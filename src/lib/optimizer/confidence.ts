/**
 * Confidence bands, and what each one is allowed to do.
 *
 * The exact numbers come from the guest's mode — see {@link MODES}. What
 * follows is why there are bands at all, which does not change with the mode.
 *
 * The brief proposed 0.85 and 0.65. Measured against a live 19-line cart first:
 * the four replacements the engine produced came back at 0.55, 0.6, 0.6 and
 * 0.7, and nothing in that run reached 0.8 — a 0.85 floor would have emptied
 * every card while telling us nothing about quality. The model reserves its top
 * of the scale for swaps that barely exist in a real basket.
 *
 * So the bands are set where this model's answers actually fall:
 *
 *   - **≥ confidentAt** — offered and ticked. The guest taps Apply and it
 *     happens.
 *   - **≥ minConfidence** — offered and *unticked*. Visible, explained, one tap
 *     away, but never applied by a guest who did not read it.
 *   - **below** — not offered at all.
 *
 * Presenting the middle band unticked is the whole point of the split. It is
 * the difference between "here are three things I am sure of and one I am not"
 * and a list of four identical-looking rows, which is what shipped before.
 */

import { MODES, resolveMode } from './optimization-modes.ts';

/** Lowest confidence a replacement may be offered at, in this mode. */
export function minConfidence(mode?: string | null): number {
  return MODES[resolveMode(mode)].minConfidence;
}

/** Confidence at which a replacement arrives ticked, in this mode. */
export function confidentAt(mode?: string | null): number {
  return MODES[resolveMode(mode)].confidentAt;
}

/**
 * A confidence the model reported, forced into 0…1.
 *
 * The structured-output schema cannot express numeric bounds, so the clamp has
 * to happen after parsing — a value outside the range would otherwise walk
 * straight past both bars above.
 */
export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
