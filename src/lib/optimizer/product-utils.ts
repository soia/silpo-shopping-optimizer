/**
 * Reading facts off a product: pack size, grade, price per unit.
 *
 * Everything here is arithmetic or parsing over a payload Silpo returned — no
 * judgement, no thresholds, no model. It is the layer the gate stands on, and
 * the reason it is separate is that these five functions are the ones with a
 * measured defect history behind them: each comment below records a live run
 * that went wrong before the rule existed.
 */

import type { ParsedSize } from '../types.ts';

/** Two decimal places. Used for the post-write difference the guest is shown. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const UNIT_TO_BASE: Record<string, [ParsedSize['unit'], number]> = {
  'г': ['g', 1],
  'гр': ['g', 1],
  'кг': ['g', 1000],
  'мл': ['ml', 1],
  'л': ['ml', 1000],
};

/**
 * Parses "112,5г", "0,33л", "250мл", "1кг" into a base unit (grams or ml).
 *
 * Only the apply-time guard uses this. Candidate selection compares the raw
 * `displayRatio` strings in the prompt instead — the model reads "1,5л" against
 * "0,5л" without help, and a parser that silently returns null is worse than no
 * parser at that stage.
 */
export function parseSize(text: string | null | undefined): ParsedSize | null {
  if (!text) return null;
  // No word boundary after the unit: Cyrillic letters are not word characters
  // in JavaScript regexes, so it never matches after "л" or "г" and the pattern
  // silently fails on every real value. A negative lookahead does the job.
  const match = String(text)
    .toLowerCase()
    .replace(',', '.')
    .match(/(\d+(?:\.\d+)?)\s*(кг|гр|г|мл|л)(?![а-щьюяїієґa-z])/);
  if (!match) return null;

  const entry = UNIT_TO_BASE[match[2]];
  if (!entry) return null;
  return { value: parseFloat(match[1]) * entry[1], unit: entry[0] };
}

/** Pack size of a cart line: the `ratio` field first, then the name as fallback. */
export function sizeOf(product: { ratio?: string | null; name: string }): ParsedSize | null {
  return parseSize(product.ratio) ?? parseSize(product.name) ?? null;
}

/**
 * Fat percentage, or grade, as written in the product name.
 *
 * Really present, unlike pack size once was: measured 139 of 288 candidate
 * names. It separates grades that nothing else does — butter 82% against 72.5%,
 * sour cream 15% against 20% — and the brief requires 2.5% milk to be replaced
 * by 2.5% milk.
 *
 * `%` is anchored to the digits rather than a word boundary: Cyrillic letters
 * are not word characters in JavaScript regexes, so `\b` never matches here.
 */
export function fatPercent(name: string): number | null {
  const match = String(name).replace(',', '.').match(/(\d{1,2}(?:\.\d)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Price per gram or per millilitre — the only figure on which two products can
 * honestly be compared.
 *
 * The two bases Silpo uses, derived from the live fixture rather than from the
 * documentation:
 *
 *   - **weighted line** — `price` is per kilogram, and `ratio` ("100г") is the
 *     shelf label, not a pack. Dividing by the label is what produced a claimed
 *     saving of 90.61% on a swap that was really worth about 6%.
 *   - **packaged line** — `price` is for one pack of `displayRatio` / `ratio`.
 *
 * The derivation: in one candidate pool the weighted hams priced 299…649 while
 * the packaged ones were 95.99 per 170 g, i.e. 565 per kg. Weighted prices only
 * sit in that range when they are per kilogram; read as per-100 g they would put
 * the same ham at 5 490 per kg, ten times its own shelf neighbours.
 *
 * Returns null when the size cannot be parsed and the product is not weighted —
 * an unknown basis is reported, never guessed.
 */
export function unitPrice(product: {
  price: number;
  weighted?: boolean;
  ratio?: string | null;
  displayRatio?: string | null;
  name?: string;
}): { value: number; unit: ParsedSize['unit'] } | null {
  if (product.weighted) return { value: product.price / 1000, unit: 'g' };
  const size = parseSize(product.displayRatio) ?? parseSize(product.ratio) ?? parseSize(product.name);
  if (!size || !size.value) return null;
  return { value: product.price / size.value, unit: size.unit };
}
