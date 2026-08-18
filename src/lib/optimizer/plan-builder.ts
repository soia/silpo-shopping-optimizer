/**
 * Every figure the guest is shown, and the only place they are produced.
 *
 * Working rule 3 in one file: the model chose the candidates, this multiplies.
 * The model used to return the figures as well — measured on a live 22-item cart
 * it got 2 of 16 wrong, both on weighted lines, and its plan total was 123.64
 * UAH short of the sum of its own lines. After the split: 17 of 17 lines, all
 * percentages and all totals exact.
 */

import type { CartItem, OptimizationPlan, PlanSummary, Replacement } from '../types.ts';
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
