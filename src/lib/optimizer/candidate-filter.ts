/**
 * The hard gate — the deterministic half of the decision.
 *
 * Working rule 3c governs this file: it decides **facts**, the model decides
 * **meaning**. Every rule below encodes something the API states outright —
 * availability, stock, price basis, pack ratio, unit price, the fat percentage
 * in a name, the saving floor. None of them may grow into a rule about what a
 * product is *for*; kombucha against juice stays the model's call.
 *
 * It runs before the prompt, and again on the price `get_product_details`
 * confirms.
 */

import type { CartItem, ProductCandidate } from '../types.ts';
import { fatPercent, parseSize, round2, unitPrice } from './product-utils.ts';

/**
 * The smallest per-line saving worth showing.
 *
 * A live run proposed swapping «Ковбаса Алан Лікарська» for «Ковбаса Алан
 * Молочна» — a different flavour of sausage — to save **0.60 UAH**. The trade is
 * real and the arithmetic was right; the offer was still noise. Below this floor
 * a replacement asks the guest to accept a change to their shopping in exchange
 * for nothing, which is the opposite of the product's promise.
 */
export const MIN_SAVING = 2;

/**
 * Why a candidate can never become a replacement, or null when it may compete.
 *
 * This is the deterministic half of the decision, and it runs **before** the
 * model rather than after it. Everything here is a fact the API states plainly;
 * nothing here is a judgement about what a product is for. That division is
 * deliberate — a rule engine that tried to decide whether kombucha may become
 * juice would be brittle and wrong, while a model asked to notice that two
 * prices are quoted on different bases is being asked to do arithmetic it
 * cannot see the inputs for.
 *
 * Ordered cheapest check first so the common rejections cost nothing.
 */
export function rejectReason(
  item: CartItem,
  candidate: ProductCandidate,
  band: { min: number; max: number },
  minSaving = MIN_SAVING,
): string | null {
  if (candidate.id === item.productId) return 'same product';
  if (candidate.available === false) return 'unavailable';
  if ((candidate.stock ?? 0) < item.quantity) return 'not enough stock';

  // The prices are not on the same basis, so neither the saving nor the
  // quantity to add can be derived. Cross-basis swaps also break the apply
  // step, which adds the replacement with the original's quantity: 0.1 of a
  // packaged product is 0.1 packs, not 100 grams of it.
  if (Boolean(item.weighted) !== Boolean(candidate.weighted)) return 'price basis differs';

  if (candidate.price >= item.price) return 'not cheaper';
  if (round2((item.price - candidate.price) * item.quantity) < minSaving) return 'saving below the floor';

  // Grade, where the name states it. A candidate that carries no percentage is
  // not rejected — most do not, and absence is not disagreement.
  const originalFat = fatPercent(item.name);
  const candidateFat = fatPercent(candidate.name);
  if (originalFat != null && candidateFat != null && Math.abs(originalFat - candidateFat) > 1) {
    return 'different grade';
  }

  // Size and unit price. Skipped for weighted lines: both sides are then priced
  // per kilogram, so the raw prices are already comparable and the "100г" label
  // on each of them is not a pack to divide by.
  if (!item.weighted) {
    const originalSize = parseSize(item.ratio) ?? parseSize(item.name);
    const candidateSize = parseSize(candidate.displayRatio) ?? parseSize(candidate.ratio);
    if (originalSize && candidateSize && originalSize.unit === candidateSize.unit) {
      const factor = candidateSize.value / originalSize.value;
      if (factor < band.min || factor > band.max) return 'pack size out of band';

      // A smaller pack at a lower price is not a saving: two of them cost more
      // than the original. The comparison only means anything once the pack
      // sizes are known, which they have been since silpo-mcp-service v1.108.0.
      const original = unitPrice(item);
      const replacement = unitPrice(candidate);
      if (original && replacement && replacement.value >= original.value) {
        return 'worse per unit';
      }
    }
  }

  return null;
}

/**
 * Applies {@link rejectReason} to a pool, keeping the tally the CLI prints.
 *
 * Returning the counts rather than logging them keeps the module free of both
 * hosts' output conventions, and makes the gate measurable: the share of a pool
 * each rule removes is the only evidence that a rule is doing anything.
 */
export function filterCandidates(
  item: CartItem,
  candidates: ProductCandidate[],
  band: { min: number; max: number },
  minSaving = MIN_SAVING,
): { kept: ProductCandidate[]; rejected: Record<string, number> } {
  const kept: ProductCandidate[] = [];
  const rejected: Record<string, number> = {};
  for (const candidate of candidates) {
    const reason = rejectReason(item, candidate, band, minSaving);
    if (reason) rejected[reason] = (rejected[reason] || 0) + 1;
    else kept.push(candidate);
  }
  return { kept, rejected };
}
