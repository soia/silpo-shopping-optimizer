/**
 * Optimization engine — the deterministic half.
 *
 * No network calls and no AI: MCP data in, numbers out. Every function is pure
 * so the whole module can be transpiled and inlined into an n8n Code node by
 * `src/workflow/build.ts` — the workflow and the local runs share one source.
 *
 * Prices come exclusively from MCP responses. The model never produces a number.
 */

import type {
  CandidateScores,
  CartItem,
  LoyaltyInfo,
  OptimizationPlan,
  ParsedSize,
  ProductCandidate,
  Replacement,
  ScoredCandidate,
} from './types.ts';

/* ------------------------------------------------------------------ sizes */

const UNIT_TO_BASE: Record<string, [ParsedSize['unit'], number]> = {
  'г': ['g', 1],
  'гр': ['g', 1],
  'кг': ['g', 1000],
  'мл': ['ml', 1],
  'л': ['ml', 1000],
};

/** Parses "112,5г", "0,33л", "250мл", "1кг" into a base unit (grams or ml). */
export function parseSize(text: string | null | undefined): ParsedSize | null {
  if (!text) return null;
  // No `\b` after the unit: Cyrillic letters are not word characters in
  // JavaScript regexes, so a word boundary never matches after "л" or "г" and
  // the pattern silently fails on every real value. A negative lookahead for a
  // following letter does the same job correctly.
  const match = String(text)
    .toLowerCase()
    .replace(',', '.')
    .match(/(\d+(?:\.\d+)?)\s*(кг|гр|г|мл|л)(?![а-щьюяїієґa-z])/);
  if (!match) return null;

  const entry = UNIT_TO_BASE[match[2]];
  if (!entry) return null;
  return { value: parseFloat(match[1]) * entry[1], unit: entry[0] };
}

/**
 * Fat or content percentage from a name: "молоко 2,5%", "масло екстра 82%".
 *
 * Unlike pack size, this is genuinely present in the data — 139 of 288 candidate
 * names carry one — and it separates grades that are otherwise near-identical by
 * name: butter 82% vs 72.5%, sour cream 15% vs 20%.
 */
export function parsePercent(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = String(text).replace(',', '.').match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

/** Pack size of a product: the `ratio` field first, then the name as fallback. */
export function sizeOf(product: { ratio?: string | null; name: string }): ParsedSize | null {
  return parseSize(product.ratio) ?? parseSize(product.name) ?? null;
}

/** Price per base unit (UAH per gram or ml), or null when size is unknown. */
export function unitPrice(product: { ratio?: string | null; name: string; price: number }): number | null {
  const size = sizeOf(product);
  if (!size?.value) return null;
  return product.price / size.value;
}

/* -------------------------------------------------------------- similarity */

const STOPWORDS = new Set(['з', 'зі', 'та', 'і', 'й', 'у', 'в', 'на', 'для', 'без', 'від', 'до', 'т', 'б', 'шт', 'уп', 'пак', 'ж', 'мдж']);

export function tokenize(name: string): string[] {
  return String(name)
    .toLowerCase()
    .replace(/[«»"'’,.()\/\\-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t) && !/^\d+([.,]\d+)?(г|кг|мл|л|%)?$/.test(t));
}

/** Product type — the first meaningful word ("Напій", "Батончик", "Сирок"). */
export function headNoun(name: string): string {
  return tokenize(name)[0] ?? '';
}

/** Jaccard overlap of name tokens, 0..1. */
export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/** Latin tokens as a brand proxy (Alpro, Snickers, Kit Kat) — the API has no brand field. */
export function latinTokens(name: string): Set<string> {
  return new Set(String(name).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);
}

/* ------------------------------------------------------------------ scoring */

/**
 * Weights are taken verbatim from the brief.
 *
 * The brief also lists `categoryMatchScore`, but leaves it out of the formula —
 * the weights already sum to 1.00 without it. Category is folded into
 * `similarityScore` through the head-noun match instead.
 */
export const WEIGHTS = {
  similarity: 0.4,
  priceSaving: 0.25,
  brandMatch: 0.1,
  sizeMatch: 0.1,
  promotion: 0.1,
  availability: 0.05,
} as const;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function scoreCandidate(original: CartItem, candidate: ProductCandidate, quantity = 1): ScoredCandidate {
  // Similarity: name overlap plus an explicit product-type match.
  const overlap = jaccard(original.name, candidate.name);
  const sameHead = headNoun(original.name) === headNoun(candidate.name);
  const similarityScore = Math.min(1, overlap * 0.7 + (sameHead ? 0.3 : 0));

  const originalSize = sizeOf(original);
  const candidateSize = sizeOf(candidate);
  const sameUnitFamily = Boolean(originalSize && candidateSize && originalSize.unit === candidateSize.unit);
  const sizeRatio = sameUnitFamily && originalSize && candidateSize ? candidateSize.value / originalSize.value : null;
  // Unknown size stays neutral: neither rewarded nor punished.
  const sizeMatchScore = sizeRatio ? Math.max(0, 1 - Math.abs(Math.log2(sizeRatio))) : 0.5;

  const originalBrand = latinTokens(original.name);
  const candidateBrand = latinTokens(candidate.name);
  const sharedBrand = [...originalBrand].some((t) => candidateBrand.has(t));
  const brandMatchScore = sharedBrand ? 1 : originalBrand.size === 0 && candidateBrand.size === 0 ? 0.5 : 0.2;

  // Saving is deterministic and sourced from MCP prices only.
  const savingPerUnit = original.price - candidate.price;
  const saving = round2(savingPerUnit * quantity);
  const savingPct = original.price > 0 ? savingPerUnit / original.price : 0;
  const priceSavingScore = Math.max(0, Math.min(1, savingPct / 0.4)); // -40% saturates

  const originalUnit = unitPrice(original);
  const candidateUnit = unitPrice(candidate);
  const unitSavingPct = originalUnit && candidateUnit ? (originalUnit - candidateUnit) / originalUnit : null;

  const promotionScore = candidate.oldPrice != null ? 1 : 0;
  const availabilityScore = candidate.available && (candidate.stock ?? 0) >= quantity ? 1 : 0;

  // Candidate pack size is unavailable from MCP (see docs/engine-findings.md).
  // A steep drop within the same product type is the only signal left that the
  // replacement might simply be a smaller package.
  const sizeUnknown = !sameUnitFamily;

  // Identical name, materially lower price. Silpo lists the same product in
  // several pack sizes under one name — «Сметана Яготинська 15% стакан» is both
  // 300 g at 57.49 and 180 g at 32.99 — so when the names match exactly, the
  // difference is almost certainly the pack, not a better deal.
  const sameName = tokenize(original.name).join(' ') === tokenize(candidate.name).join(' ');
  const suspiciousDrop = sizeUnknown && (savingPct >= 0.5 || (sameName && savingPct >= 0.15));

  // The brief is explicit that 2.5% milk must be replaced by 2.5% milk. One
  // percentage point of slack covers rounding between labels (2.5 vs 2.6) while
  // still separating grades (82 vs 72.5).
  const originalPercent = parsePercent(original.name);
  const candidatePercent = parsePercent(candidate.name);
  const percentMismatch =
    originalPercent != null && candidatePercent != null && Math.abs(originalPercent - candidatePercent) > PERCENT_TOLERANCE;

  const scores: CandidateScores = {
    similarityScore: round2(similarityScore),
    priceSavingScore: round2(priceSavingScore),
    brandMatchScore: round2(brandMatchScore),
    sizeMatchScore: round2(sizeMatchScore),
    promotionScore,
    availabilityScore,
  };

  const finalScore =
    similarityScore * WEIGHTS.similarity +
    priceSavingScore * WEIGHTS.priceSaving +
    brandMatchScore * WEIGHTS.brandMatch +
    sizeMatchScore * WEIGHTS.sizeMatch +
    promotionScore * WEIGHTS.promotion +
    availabilityScore * WEIGHTS.availability;

  return {
    productId: candidate.id,
    companyId: candidate.companyId,
    branchId: candidate.branchId,
    slug: candidate.slug,
    name: candidate.name,
    price: candidate.price,
    oldPrice: candidate.oldPrice ?? null,
    ratio: candidate.ratio ?? null,
    stock: candidate.stock ?? 0,
    available: Boolean(candidate.available),
    saving,
    savingPct: round2(savingPct * 100),
    unitSavingPct: unitSavingPct == null ? null : round2(unitSavingPct * 100),
    sizeRatio: sizeRatio == null ? null : round2(sizeRatio),
    sameUnitFamily,
    sizeUnknown,
    suspiciousDrop,
    originalPercent,
    candidatePercent,
    percentMismatch,
    onPromotion: candidate.oldPrice != null,
    scores,
    finalScore: round2(finalScore),
  };
}

/* ---------------------------------------------------------------- filtering */

/** Percentage points of slack allowed between an original and its replacement. */
export const PERCENT_TOLERANCE = 1;

export const THRESHOLDS = {
  /** Below this the candidate is a different kind of product entirely. */
  minSimilarity: 0.35,
  minFinalScore: 0.55,
  /** UAH — smaller gains are not worth bothering the customer with. */
  minSaving: 1,
  /**
   * Pack sizes must be close, not merely within an order of magnitude. At the
   * old 2x band a 300 g sour cream was replaced by a 180 g one: 4% cheaper per
   * gram, but 40% less product — two packs would cost more than the original.
   */
  minSizeRatio: 0.8,
  maxSizeRatio: 1.25,
  minUnitSavingPct: 0,
} as const;

/**
 * Drops unsuitable candidates. The governing rule from the brief: preserve what
 * the customer actually intended to buy, rather than find the cheapest thing.
 */
export function filterCandidates(original: CartItem, scored: ScoredCandidate[], quantity = 1): ScoredCandidate[] {
  return scored
    .filter((c) => {
      // `similar_products` returns the original product itself as a candidate.
      if (c.productId === original.productId) return false;
      if (!c.available || c.stock < quantity) return false;
      // Different fat or content grade — a different product, not a cheaper one.
      if (c.percentMismatch) return false;
      if (c.saving < THRESHOLDS.minSaving) return false;
      if (c.scores.similarityScore < THRESHOLDS.minSimilarity) return false;
      if (c.finalScore < THRESHOLDS.minFinalScore) return false;

      // When both sizes are known, the pack must be comparable.
      if (c.sizeRatio != null && (c.sizeRatio > THRESHOLDS.maxSizeRatio || c.sizeRatio < THRESHOLDS.minSizeRatio)) {
        return false;
      }
      // A saving that comes purely from a smaller pack is not a saving.
      if (c.unitSavingPct != null && c.unitSavingPct <= THRESHOLDS.minUnitSavingPct) return false;
      return true;
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

/* ------------------------------------------------------------------ summary */

export interface ItemBest {
  item: CartItem;
  best: ScoredCandidate | null;
}

/**
 * Builds the plan. Only positive savings are summed.
 * Loyalty bonuses are reported separately and never added to the total.
 */
export function buildPlan(cartItems: CartItem[], perItemBest: ItemBest[], loyalty?: LoyaltyInfo): OptimizationPlan {
  const replacements: Replacement[] = [];

  for (const { item, best } of perItemBest) {
    if (!best || best.saving <= 0) continue;
    replacements.push({
      originalProductId: item.productId,
      originalName: item.name,
      originalPrice: item.price,
      originalRatio: item.ratio ?? null,
      quantity: item.quantity,
      replacementProductId: best.productId,
      replacementCompanyId: best.companyId,
      replacementBranchId: best.branchId,
      replacementName: best.name,
      replacementPrice: best.price,
      replacementRatio: best.ratio,
      onPromotion: best.onPromotion,
      brand: best.brand ?? null,
      alternates: best.alternates ?? [],
      saving: best.saving,
      savingPct: best.savingPct,
      finalScore: best.finalScore,
      scores: best.scores,
      verifySize: best.suspiciousDrop,
    });
  }

  const originalTotal = round2(cartItems.reduce((sum, item) => sum + item.total, 0));
  const totalSaving = round2(replacements.reduce((sum, r) => sum + r.saving, 0));

  return {
    replacements,
    summary: {
      itemsAnalyzed: cartItems.length,
      replacementsFound: replacements.length,
      promotionsUsed: replacements.filter((r) => r.onPromotion).length,
      originalTotal,
      optimizedTotal: round2(originalTotal - totalSaving),
      saving: totalSaving,
      savingPct: originalTotal > 0 ? round2((totalSaving / originalTotal) * 100) : 0,
      bonusAvailable: loyalty?.bonusAvailable ?? 0,
    },
  };
}
