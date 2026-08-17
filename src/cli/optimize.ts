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
import { selectReplacement, buildPlan, aiStats, AI_ERROR_PREFIX, type SelectedItem } from '../lib/ai-ranker.ts';
import type { CartItem, ProductCandidate } from '../lib/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONCURRENCY = 3;
const startedAt = Date.now();

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('\nANTHROPIC_API_KEY is not set. The engine is the model — there is no');
  console.error('rule-based fallback any more. Put the key in .env (see .env.example).\n');
  process.exit(1);
}

const money = (n: number) => `${Number(n).toFixed(2)} UAH`;

// The bot reads this per guest from the session row; locally it is an env knob so
// the three bands can be compared on the same cart.
const TOLERANCE = process.env.SIZE_TOLERANCE ?? 'normal';

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

/* 5. The model chooses. Every judgement and every number below is its own. */
console.log('Choosing replacements');
console.log(`  model: claude-sonnet-5 · size tolerance: ${TOLERANCE}`);

/**
 * `silpo_get_similar_products` reports stale availability — observed
 * `available: true` / `stock: 1` for a product that `get_product_details` and
 * the cart both called unavailable. Details agrees with the cart, so the chosen
 * candidate is confirmed there before being proposed. When the confirmation
 * fails the model is asked again without that candidate, up to three rounds.
 */
const diagnostics: Array<{ item: CartItem; considered: number; offered: number }> = [];
let confirmationCalls = 0;
let skippedUnavailable = 0;

// Two phases, matching the workflow: the model picks a ranked shortlist in one
// call per line, then Silpo confirms the picks in order. Interleaving them and
// re-asking the model per runner-up cost 3-4 calls a line and timed the n8n node
// out at 60 s.
const MODEL_CONCURRENCY = 6;

const pools = items.map((item, index) => {
  const lookup = lookups[index];
  const all = lookup.ok && lookup.value ? lookup.value : [];
  // `similar_products` returns the original product itself as a candidate.
  //
  // Candidates priced at or above the original are dropped before the prompt is
  // built. This is not a judgement the model should be making: a replacement
  // must save money to be a replacement at all, so those rows cannot become an
  // answer — they only make the prompt longer and the call slower.
  return all.filter(
    (c) => c.id !== item.productId && c.available && (c.stock ?? 0) >= item.quantity && c.price < item.price,
  );
});

const picks = await mapLimit(items, MODEL_CONCURRENCY, async (item, index) =>
  pools[index].length ? await selectReplacement(item, pools[index], API_KEY, TOLERANCE) : null,
);
const modelCalls = pools.filter((p) => p.length).length;

const chosen = await mapLimit(items, CONCURRENCY, async (item, index) => {
  const considered = pools[index].length;
  const selection = picks[index].ok ? picks[index].value : null;
  if (!selection || selection.chosen == null) return { considered, selection: null, candidate: null };

  const order = [selection.chosen, ...selection.alternates];
  for (const idx of order) {
    const candidate = pools[index][idx];
    if (!candidate) continue;
    confirmationCalls++;
    let details: any;
    try {
      details = await callTool<any>('silpo_get_product_details', {
        branchId,
        deliveryType,
        timeslotStart,
        timeslotEnd,
        slug: candidate.slug,
      });
    } catch {
      continue;
    }

    const product = details.product ?? {};
    if (product.available === false || (product.stock ?? 0) < item.quantity) {
      skippedUnavailable++;
      continue;
    }

    return {
      considered,
      selection,
      candidate: {
        ...candidate,
        price: product.price ?? candidate.price,
        oldPrice: product.oldPrice ?? candidate.oldPrice,
        stock: product.stock,
        available: true,
        brand: details.product?.attributes?.['Торгова марка'] ?? null,
      } as ProductCandidate,
    };
  }
  return { considered, selection: null, candidate: null };
});

// A model outage must not read as "nothing worth replacing".
const aiFailures = chosen.filter((c) => !c.ok && c.error?.startsWith(AI_ERROR_PREFIX));
if (aiFailures.length) {
  console.error(`\nThe model failed on ${aiFailures.length} of ${items.length} items:`);
  console.error(`  ${aiFailures[0].error}`);
  console.error('\nThere is no rule-based fallback. Fix the API access and re-run.\n');
  process.exit(1);
}

const selected: SelectedItem[] = items.map((item, index) => {
  const result = chosen[index].ok ? chosen[index].value! : { considered: 0, selection: null, candidate: null };
  diagnostics.push({ item, considered: result.considered, offered: result.candidate ? 1 : 0 });
  return { item, candidate: result.candidate, selection: result.selection };
});

console.log(`  ${modelCalls} model calls · ${confirmationCalls} availability checks · ${skippedUnavailable} dropped as unavailable`);

const plan = buildPlan(items, selected, loyalty);

/* 6. Report */
const summary = plan.summary;
const amount = (n: number) => n.toFixed(2).padStart(9);
console.log(`\n${'='.repeat(72)}`);
console.log(`Before   ${amount(summary.originalTotal)} UAH`);
console.log(`After    ${amount(summary.optimizedTotal)} UAH`);
console.log(`Saving   ${amount(summary.saving)} UAH   ${summary.savingPct}%`);
console.log(`\n${summary.itemsAnalyzed} items · ${summary.replacementsFound} replacements · ${summary.promotionsUsed} on promotion`);
if (summary.bonusAvailable > 0) {
  console.log(`Loyalty bonuses: ${summary.bonusAvailable} (potential, excluded from the saving)`);
}
console.log('='.repeat(72) + '\n');

plan.replacements.forEach((r, i) => {
  console.log(`${i + 1}. ${r.originalName}`);
  console.log(`   ${money(r.originalPrice)}  ${r.originalRatio ?? ''}`);
  console.log(`   → ${r.replacementName}`);
  console.log(`   ${money(r.replacementPrice)}${r.onPromotion ? '  [promotion]' : ''}`);
  console.log(`   saving ${money(r.saving)} (−${r.savingPct}%)`);
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

console.log('─'.repeat(72));
console.log('Per-item diagnostics:\n');
for (const d of diagnostics) {
  console.log(`  ${String(d.considered).padStart(3)} candidates → ${d.offered} offered   ${d.item.name.slice(0, 44)}`);
}
console.log(`\n${stats.calls} MCP calls · ${stats.retries} retries · ${stats.refreshes} refreshes · ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);

// cacheReads at 0 means the system-prompt cache silently stopped working.
const cached = aiStats.cacheReads + aiStats.cacheWrites + aiStats.inputTokens;
console.log(
  `${aiStats.calls} model calls · in ${aiStats.inputTokens} · out ${aiStats.outputTokens}` +
    ` · cache write ${aiStats.cacheWrites} · cache read ${aiStats.cacheReads}` +
    ` (${cached ? Math.round((aiStats.cacheReads / cached) * 100) : 0}% of prompt served from cache)\n`,
);

if (process.argv.includes('--json')) {
  mkdirSync(resolve(ROOT, '.secrets'), { recursive: true });
  const outFile = resolve(ROOT, '.secrets/plan.json');
  writeFileSync(
    outFile,
    JSON.stringify({ shoppingCartId, branchId, deliveryType, timeslotStart, timeslotEnd, createdAt: new Date().toISOString(), ...plan }, null, 2),
  );
  console.log('Plan written to .secrets/plan.json\n');
}
