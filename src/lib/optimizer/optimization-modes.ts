/**
 * How hard a run is allowed to push, as one guest-visible setting.
 *
 * Everything a mode governs is declared here and nowhere else: the pack-size
 * band the gate enforces, the two confidence bars, and the sentence about brand
 * that goes into the prompt. Working rule 3d applies to this file — the numbers
 * were measured against live runs, and moving one means measuring again.
 */

/**
 * How far a replacement's pack size may drift from the original.
 *
 * The guest picks one in Settings; `normal` is the default and the band the
 * project ran on before the setting existed. `loose` exists because guests asked
 * for it, and it is only safe because of the per-unit rule in the prompt: a
 * smaller pack is allowed only when the price per 100 g or per litre actually
 * improves. Without that, `loose` would re-create the defect this project spent
 * a long time removing — 300 g swapped for 180 g at 4% less per gram, which is
 * 40% less product and costs more if you buy two.
 *
 * Enforced twice: in the prompt when the model chooses, and again at apply time
 * against the cart's own `ratio`, which is authoritative.
 */
export const SIZE_TOLERANCE = {
  strict: { min: 0.95, max: 1.05, label: 'строго' },
  normal: { min: 0.8, max: 1.25, label: 'звичайно' },
  loose: { min: 0.6, max: 1.7, label: 'вільно' },
} as const;

export type SizeTolerance = keyof typeof SIZE_TOLERANCE;

/**
 * How hard the run is allowed to push, as one setting.
 *
 * It began as three pack-size presets, because pack size was the only axis
 * where a guest's tolerance obviously differed. That turned out to be one face
 * of a single question — how far from the original a replacement may travel —
 * and asking it three separate times (pack size, brand, how sure is sure
 * enough) would have produced nine combinations, most of them incoherent.
 *
 * So one control moves all three together, and each mode is a position on the
 * same axis:
 *
 * | | pack size | offered from | ticked from | brand |
 * |---|---|---|---|---|
 * | `conservative` | 0.95–1.05 | 0.75 | 0.85 | prefers the same one |
 * | `balanced` | 0.8–1.25 | 0.6 | 0.8 | free |
 * | `max` | 0.6–1.7 | 0.55 | 0.8 | free, and said so |
 *
 * Two things deliberately do **not** move. The tick bar stays at 0.8 outside
 * `conservative`: a guest asking for bigger savings is asking to be *shown*
 * more, not to have more applied on their behalf while they are not reading.
 * And `MIN_SAVING` never moves — a 0.60 UAH swap is noise in every mode.
 *
 * `max` is only defensible because of the per-unit rule in the gate: a smaller
 * pack is allowed there only when the price for the same quantity actually
 * improves. Without it, `max` would recreate the defect this project spent a
 * long time removing.
 *
 * The band is enforced twice — in the prompt when the model chooses, and again
 * at apply time against the cart's own `ratio`, which is authoritative.
 */
export const MODES = {
  conservative: {
    size: 'strict',
    minConfidence: 0.75,
    confidentAt: 0.85,
    brand: 'За інших рівних обирай той самий бренд, що й в оригіналі.',
  },
  balanced: {
    size: 'normal',
    minConfidence: 0.6,
    confidentAt: 0.8,
    brand: 'Бренд не має значення, якщо решта властивостей збігається.',
  },
  max: {
    size: 'loose',
    minConfidence: 0.55,
    confidentAt: 0.8,
    brand: 'Бренд не має значення. Сміливо пропонуй власні марки мережі та невідомі бренди, якщо тип товару той самий.',
  },
} as const;

export type Mode = keyof typeof MODES;
export const DEFAULT_MODE: Mode = 'balanced';

/**
 * Resolves whatever is stored on the session row to a mode.
 *
 * Rows written before modes existed hold a pack-size preset, so those three
 * names map onto the mode that carries the same band. Nothing needs migrating,
 * and a value from the future degrades to the default rather than to the
 * loosest setting — the failure that costs a guest the least.
 */
export function resolveMode(value?: string | null): Mode {
  const key = String(value || '');
  if (key in MODES) return key as Mode;
  if (key === 'strict') return 'conservative';
  if (key === 'loose') return 'max';
  return DEFAULT_MODE;
}

/** The pack-size band of a mode. */
export function sizeBand(mode?: string | null): { min: number; max: number } {
  const preset = SIZE_TOLERANCE[MODES[resolveMode(mode)].size];
  return { min: preset.min, max: preset.max };
}
