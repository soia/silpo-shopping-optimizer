/**
 * Runs the full optimization pipeline against the real cart, without n8n.
 *
 * Exists to prove the demo metric on live data before trusting the workflow,
 * and to debug the engine quickly. Strictly read-only: no write tools are
 * called here by design — cart changes require explicit confirmation in the bot.
 *
 *   npm run optimize
 *   npm run optimize -- --json    also write .secrets/plan.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool, mapLimit, stats } from '../lib/mcp.ts';
import { scoreCandidate, filterCandidates, buildPlan, type ItemBest } from '../lib/optimizer.ts';
import { rankWithAI, applyDecisions } from '../lib/ai-ranker.ts';
import type { CartItem, ProductCandidate, ScoredCandidate } from '../lib/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONCURRENCY = 3;
const startedAt = Date.now();

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} UAH`;

/* 1. Cart */
console.log('\nAnalyzing cart…\n');
const { shoppingCartId } = await callTool<{ shoppingCartId: string }>('silpo_get_my_shopping_cart');
const cartResponse = await callTool<any>('silpo_get_shopping_cart_by_id', { shoppingCartId });

const cart = cartResponse.cart;
const items: CartItem[] = cart.shipments.flatMap((s: any) => s.products);
const branchId: string = cart.shipments[0].branchId;
const deliveryType: string = cart.deliveryType;
console.log(`Found ${items.length} items totalling ${money(cart.calculation.total)}`);

/* 2. Repair the delivery slot — an expired one blocks checkout and skews promo context */
let timeslotStart: string | undefined = cart.timeslot?.start;
let timeslotEnd: string | undefined = cart.timeslot?.end;
const slotExpired =
  !timeslotStart ||
  new Date(timeslotStart) < new Date() ||
  (cart.calculation.validations ?? []).some((v: any) => v.level === 'error' && v.type === 'timeslot');

if (slotExpired) {
  console.log('Delivery slot expired — picking the next available one');
  const { slots } = await callTool<{ slots: any[] }>('silpo_get_time_slots', { branchId, limit: 100 });
  const fresh = slots.find((s) => s.available && s.deliveryType === deliveryType) ?? slots.find((s) => s.available);
  if (!fresh) {
    console.error('No available delivery slot');
    process.exit(1);
  }
  timeslotStart = fresh.start;
  timeslotEnd = fresh.end;
}

/* 3. Promotions and loyalty context — fetched once per run, in parallel */
console.log('Checking promotions, coupons and loyalty bonuses');
const contextTasks = [
  () => callTool<any>('silpo_get_promotions', { branchId, deliveryType, timeslotStart, timeslotEnd }),
  () => callTool<any>('silpo_get_my_coupons'),
  () => callTool<any>('silpo_get_promo_codes'),
  () => callTool<any>('silpo_get_my_promos'),
  () => callTool<any>('silpo_get_loyalty_info'),
];
const contextResults = await mapLimit(contextTasks, CONCURRENCY, (task) => task());
const promotions = contextResults[0].ok ? contextResults[0].value : null;
const coupons = contextResults[1].ok ? contextResults[1].value : null;
const loyalty = cartResponse.loyalty ?? {};

console.log(
  `  promotions: ${promotions?.promotions?.length ?? 0} · coupons: ${coupons?.coupons?.length ?? 0} · bonuses: ${loyalty.bonusAvailable ?? 0}`,
);

/* 4. Candidate lookup, bounded concurrency plus backoff inside the client */
console.log('Looking for alternatives');
const lookups = await mapLimit(items, CONCURRENCY, async (item) => {
  if (!item.slug) return [] as ProductCandidate[];
  const response = await callTool<{ products?: ProductCandidate[] }>('silpo_get_similar_products', {
    branchId,
    deliveryType,
    slug: item.slug,
    limit: 30,
  });
  return response.products ?? [];
});

/* 4b. Out-of-stock lines get replacements in a single batched call */
// An expired slot makes Silpo report stock 0 for every cart line, so this
// filter is only meaningful while the slot is valid.
const unavailable = slotExpired ? [] : items.filter((i) => i.stock === 0 || i.available === false);
if (unavailable.length) {
  console.log(`  ${unavailable.length} unavailable items — fetching replacements`);
  try {
    const replacements = await callTool<{ products?: ProductCandidate[] }>('silpo_get_replacements', {
      branchId,
      deliveryType,
      companyId: unavailable[0].companyId,
      productIds: unavailable.map((i) => i.productId),
    });
    if (replacements.products) {
      items.forEach((item, index) => {
        const lookup = lookups[index];
        if (unavailable.some((u) => u.productId === item.productId) && lookup.ok && lookup.value) {
          lookup.value = lookup.value.concat(replacements.products!);
        }
      });
    }
  } catch {
    // Replacements are a bonus; a failure here must not abort the analysis.
  }
}

/* 5. Deterministic scoring */
const perItemBest: ItemBest[] = [];
const diagnostics: Array<{ item: CartItem; considered: number; passed: number }> = [];
const nearMisses: Array<{ item: CartItem; nearest: ScoredCandidate }> = [];

/**
 * `silpo_get_similar_products` reports stale availability — observed
 * `available: true` / `stock: 1` for a product that `get_product_details` and
 * the cart both called unavailable. Details agrees with the cart, so the chosen
 * candidate is confirmed there before being proposed.
 */
const CONFIRM_ATTEMPTS = 3;
let confirmationCalls = 0;
let skippedUnavailable = 0;

const confirmed = await mapLimit(items, CONCURRENCY, async (item, index) => {
  const lookup = lookups[index];
  const candidates = lookup.ok && lookup.value ? lookup.value : [];
  const ranked = candidates
    .map((raw) => ({ raw, scored: scoreCandidate(item, raw, item.quantity) }))
    .filter((x) => filterCandidates(item, [x.scored], item.quantity).length > 0)
    .sort((a, b) => b.scored.finalScore - a.scored.finalScore);

  for (const candidate of ranked.slice(0, CONFIRM_ATTEMPTS)) {
    confirmationCalls++;
    let details: any;
    try {
      details = await callTool<any>('silpo_get_product_details', {
        branchId,
        deliveryType,
        timeslotStart,
        timeslotEnd,
        slug: candidate.raw.slug,
      });
    } catch {
      continue;
    }
    const product = details.product ?? {};
    if (product.available === false || (product.stock ?? 0) < item.quantity) {
      skippedUnavailable++;
      continue;
    }

    const confirmedRaw: ProductCandidate = {
      ...candidate.raw,
      price: product.price ?? candidate.raw.price,
      oldPrice: product.oldPrice ?? candidate.raw.oldPrice,
      stock: product.stock,
      available: true,
    };
    const rescored = scoreCandidate(item, confirmedRaw, item.quantity);
    if (!filterCandidates(item, [rescored], item.quantity).length) continue;
    return { best: rescored, considered: candidates.length, passed: ranked.length };
  }
  return { best: null, considered: candidates.length, passed: ranked.length };
});

items.forEach((item, index) => {
  const result = confirmed[index].ok ? confirmed[index].value! : { best: null, considered: 0, passed: 0 };
  perItemBest.push({ item, best: result.best });
  diagnostics.push({ item, considered: result.considered, passed: result.passed });

  if (!result.best) {
    const lookup = lookups[index];
    const candidates = lookup.ok && lookup.value ? lookup.value : [];
    const scored = candidates.map((c) => scoreCandidate(item, c, item.quantity));
    const nearest = scored.filter((s) => s.saving > 0).sort((a, b) => b.finalScore - a.finalScore)[0];
    if (nearest) nearMisses.push({ item, nearest });
  }
});

console.log(`  ${confirmationCalls} availability checks · ${skippedUnavailable} candidates dropped as unavailable`);

const rawPlan = buildPlan(items, perItemBest, loyalty);

/* 5b. Semantic check: does the swap preserve the purchase intent? */
console.log('Checking whether replacements preserve the purchase intent');
const ranking = await rankWithAI(rawPlan.replacements);
console.log(`  ${ranking.usedAI ? 'model: claude-sonnet-5' : `deterministic fallback — ${ranking.reason}`}`);
const plan = applyDecisions(rawPlan, ranking.decisions);

/* 6. Report */
const summary = plan.summary;
console.log(`\n${'='.repeat(72)}`);
console.log(`Before:   ${money(summary.originalTotal)}`);
console.log(`After:    ${money(summary.optimizedTotal)}`);
console.log(`SAVING:   ${money(summary.saving)}  (${summary.savingPct}%)`);
console.log(`${summary.itemsAnalyzed} items analyzed · ${summary.replacementsFound} replacements · ${summary.promotionsUsed} on promotion`);
if (summary.bonusAvailable > 0) {
  console.log(`Loyalty bonuses: ${summary.bonusAvailable} (potential, excluded from the saving)`);
}
console.log('='.repeat(72) + '\n');

plan.replacements.forEach((r, i) => {
  console.log(`${i + 1}. ${r.originalName}`);
  console.log(`   ${money(r.originalPrice)}  ${r.originalRatio ?? ''}`);
  console.log(`   → ${r.replacementName}`);
  console.log(`   ${money(r.replacementPrice)}${r.onPromotion ? '  [promotion]' : ''}`);
  console.log(`   saving ${money(r.saving)} (−${r.savingPct}%) · score ${r.finalScore} [similarity ${r.scores.similarityScore}]`);
  if (r.aiReason) console.log(`   ${r.aiReason} (confidence ${r.aiConfidence})`);
  if (r.verifySize) console.log('   WARNING: verify the pack size — the price drop is suspiciously large');
  console.log('');
});

if (plan.rejectedByAI?.length) {
  console.log('─'.repeat(72));
  console.log('Rejected — would not preserve the purchase intent:\n');
  for (const r of plan.rejectedByAI) {
    console.log(`• ${r.originalName.slice(0, 46)}`);
    console.log(`  → ${r.replacementName.slice(0, 46)} (−${r.savingPct}%, ${money(r.saving)})`);
    console.log(`  ${r.aiReason}\n`);
  }
}

if (nearMisses.length) {
  console.log('─'.repeat(72));
  console.log('Cheaper but filtered out by the deterministic rules:\n');
  for (const { item, nearest } of nearMisses.slice(0, 8)) {
    const reasons: string[] = [];
    if (nearest.scores.similarityScore < 0.35) reasons.push(`different product (similarity ${nearest.scores.similarityScore})`);
    if (nearest.unitSavingPct != null && nearest.unitSavingPct <= 0) reasons.push(`more expensive per unit (${nearest.unitSavingPct}%)`);
    if (nearest.sizeRatio != null && (nearest.sizeRatio > 2 || nearest.sizeRatio < 0.5)) reasons.push(`different size (×${nearest.sizeRatio})`);
    if (!reasons.length) reasons.push(`score ${nearest.finalScore} below threshold`);
    console.log(`• ${item.name.slice(0, 46)}`);
    console.log(`  → ${nearest.name.slice(0, 46)} — ${reasons.join(', ')}`);
  }
  console.log('');
}

console.log('─'.repeat(72));
console.log('Per-item diagnostics:\n');
for (const d of diagnostics) {
  console.log(`  ${String(d.considered).padStart(3)} candidates → ${d.passed} kept   ${d.item.name.slice(0, 44)}`);
}
console.log(`\nMCP: ${stats.calls} calls · ${stats.retries} retries · ${stats.refreshes} refreshes · ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

if (process.argv.includes('--json')) {
  mkdirSync(resolve(ROOT, '.secrets'), { recursive: true });
  const outFile = resolve(ROOT, '.secrets/plan.json');
  writeFileSync(
    outFile,
    JSON.stringify({ shoppingCartId, branchId, deliveryType, timeslotStart, timeslotEnd, createdAt: new Date().toISOString(), ...plan }, null, 2),
  );
  console.log('Plan written to .secrets/plan.json\n');
}
