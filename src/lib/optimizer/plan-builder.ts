/**
 * Every figure the guest is shown, and the only place they are produced.
 *
 * Working rule 3 in one file: the model chose the candidates, this multiplies.
 * The model used to return the figures as well — measured on a live 22-item cart
 * it got 2 of 16 wrong, both on weighted lines, and its plan total was 123.64
 * UAH short of the sum of its own lines. After the split: 17 of 17 lines, all
 * percentages and all totals exact.
 */

import type { Alternate, CartItem, OptimizationPlan, PlanSummary, Replacement } from '../types.ts';
import type { PlanContext, SelectedItem } from './types.ts';
import { round2 } from './product-utils.ts';
import { MIN_SAVING } from './candidate-filter.ts';
import { confidentAt, minConfidence } from './confidence.ts';

/**
 * The saving for one line — in code, deliberately.
 *
 * The model used to return these figures. Measured on a live 22-item cart it got
 * 2 of 16 wrong, both on weighted lines: a 0.3 kg line came back as 1.32 instead
 * of 132.00, and the plan total was 123.64 UAH short. Every decision above is
 * still the model's; this multiplication is not a decision.
 */
export function computeSaving(
  item: { price: number; quantity: number },
  candidate: { price: number },
): { saving: number; savingPct: number } {
  const perUnit = item.price - candidate.price;
  return {
    saving: round2(perUnit * item.quantity),
    savingPct: item.price > 0 ? round2((perUnit / item.price) * 100) : 0,
  };
}

/**
 * Assembles the plan from the model's own decisions. Ids and names come from the
 * MCP payload; every figure is computed here from MCP prices.
 */
export function buildPlan(
  cartItems: CartItem[],
  selected: SelectedItem[],
  context: PlanContext = {},
): OptimizationPlan {
  const loyalty = context.loyalty;
  const replacements: Replacement[] = [];
  const rejected: Replacement[] = [];

  for (const { item, candidate, selection } of selected) {
    if (!candidate || !selection) continue;
    const { saving, savingPct } = computeSaving(item, candidate);

    const replacement: Replacement = {
      originalProductId: item.productId,
      originalName: item.name,
      // Carried for the product link on the card. Not a figure and not a
      // judgement — it is the identifier Silpo already gave this line.
      originalSlug: item.slug ?? null,
      originalPrice: item.price,
      originalRatio: item.ratio ?? null,
      quantity: item.quantity,
      replacementProductId: candidate.id,
      replacementCompanyId: candidate.companyId,
      replacementBranchId: candidate.branchId,
      replacementName: candidate.name,
      replacementSlug: candidate.slug ?? null,
      replacementPrice: candidate.price,
      replacementRatio: candidate.displayRatio ?? candidate.ratio ?? null,
      onPromotion: candidate.oldPrice != null,
      brand: candidate.brand ?? null,
      alternates: candidate.alternates ?? [],
      saving,
      savingPct,
      verifySize: selection.verifySize,
      aiReason: selection.reason,
      aiConfidence: selection.confidence,
      // Drives whether the line is ticked when the card is first drawn, and the
      // «не певен» marker beside it. Resolved here rather than in the UI:
      // the bar depends on the mode, and the card is redrawn on every toggle
      // from a stored row that has no idea which mode produced it.
      confident: selection.confidence >= confidentAt(context.mode),
      aiSource: 'ai',
    };

    const keep =
      selection.accept &&
      selection.confidence >= minConfidence(context.mode) &&
      saving >= MIN_SAVING;
    (keep ? replacements : rejected).push(replacement);
  }

  // Totals in code. These were a model call until it returned a plan total
  // 123.64 UAH short of the sum of its own lines; the call is gone, which also
  // removes one round trip per run.
  const originalTotal = round2(cartItems.reduce((sum, item) => sum + item.total, 0));
  const saving = round2(replacements.reduce((sum, r) => sum + r.saving, 0));

  const summary: PlanSummary = {
    itemsAnalyzed: cartItems.length,
    replacementsFound: replacements.length,
    promotionsUsed: replacements.filter((r) => r.onPromotion).length,
    originalTotal,
    optimizedTotal: round2(originalTotal - saving),
    saving,
    savingPct: originalTotal > 0 ? round2((saving / originalTotal) * 100) : 0,
    bonusAvailable: loyalty?.bonusAvailable ?? 0,
    // Stated, never summed into `saving`. See PlanSummary for why.
    cartDiscount: round2(context.cartDiscount ?? 0),
    couponsAvailable: context.couponsAvailable ?? 0,
  };

  return { replacements, rejectedByAI: rejected, summary };
}

/**
 * Swaps a chosen runner-up into the primary slot of one line.
 *
 * The guest taps «Інші варіанти» and picks one; from that moment the picked
 * product is an ordinary replacement, not a footnote on somebody else's. That is
 * the whole point of doing it here rather than storing a `selectedAlternateIndex`
 * beside the plan: the apply step, the details screen and the card all read
 * `replacementProductId` and `saving`, and none of them should have to learn
 * about a second, shadow choice.
 *
 * The old primary swaps places with it and goes to the head of `alternates`, so
 * changing one's mind costs one more tap and no re-run — and so apply-time
 * fallback keeps a candidate that already cleared every check.
 *
 * Figures are recomputed here from the two prices, per working rule 3, and never
 * carried over from the alternate's stored `saving`: quantity belongs to the
 * line, not to the candidate.
 */
export function applyAlternate(
  plan: { replacements?: Replacement[]; summary?: { saving?: number } },
  replacementIndex: number,
  alternateIndex: number,
): { ok: boolean; reason?: 'no-replacement' | 'no-alternate' | 'no-saving' } {
  const replacements = plan.replacements ?? [];
  const line = replacements[replacementIndex];
  if (!line) return { ok: false, reason: 'no-replacement' };

  const alternates = line.alternates ?? [];
  const picked = alternates[alternateIndex];
  // `offerable` is what the card put a button on; anything else arriving here is
  // a stale keyboard from before a redraw, not a choice the guest could see.
  if (!picked || picked.offerable === false) return { ok: false, reason: 'no-alternate' };

  const { saving, savingPct } = computeSaving(
    { price: line.originalPrice, quantity: line.quantity },
    { price: picked.price },
  );
  // The floor the gate applies to every other proposal. A candidate that no
  // longer clears it is not offered a second door in through the UI.
  if (saving < MIN_SAVING) return { ok: false, reason: 'no-saving' };

  const demoted: Alternate = {
    productId: line.replacementProductId,
    companyId: line.replacementCompanyId,
    branchId: line.replacementBranchId,
    name: line.replacementName,
    slug: line.replacementSlug,
    price: line.replacementPrice,
    saving: line.saving,
    brand: line.brand ?? null,
    reason: line.aiReason ?? null,
    confident: line.confident,
    // It was on the card a moment ago, so it is by definition offerable.
    offerable: true,
  };

  line.replacementProductId = picked.productId;
  line.replacementCompanyId = picked.companyId;
  line.replacementBranchId = picked.branchId;
  line.replacementName = picked.name;
  line.replacementSlug = picked.slug ?? null;
  line.replacementPrice = picked.price;
  line.brand = picked.brand ?? null;
  line.aiReason = picked.reason ?? null;
  line.confident = picked.confident;
  line.saving = saving;
  line.savingPct = savingPct;
  // Pack size was read for the primary; nothing confirmed it for this one, so it
  // is dropped rather than inherited. Apply verifies it from the cart anyway.
  line.replacementRatio = null;
  line.alternates = [demoted].concat(alternates.filter((_, i) => i !== alternateIndex));

  // The headline is the sum of every line, ticked or not — the card derives the
  // ticked figure itself. Recomputed, never adjusted by a delta.
  if (plan.summary) {
    plan.summary.saving = round2(replacements.reduce((sum, r) => sum + r.saving, 0));
  }
  return { ok: true };
}
