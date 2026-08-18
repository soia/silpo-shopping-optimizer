/**
 * The decision engine — public surface.
 *
 * This is the only entry point the CLI, the tests and the workflow generator
 * name. The modules behind it are split by responsibility, not by layer, and
 * each one carries the measurement that put its rules where they are:
 *
 *   `ai-client.ts`          talking to Anthropic; knows nothing about carts
 *   `ai-selector.ts`        the model's judgement, and reading its answer
 *   `prompts.ts`            everything the model is told
 *   `schemas.ts`            the shape it must answer in
 *   `candidate-filter.ts`   the hard gate — facts only (working rule 3c)
 *   `product-utils.ts`      pack size, grade, price per unit
 *   `optimization-modes.ts` what a mode is allowed to loosen
 *   `confidence.ts`         which band offers, which band ticks
 *   `plan-builder.ts`       every figure the guest is shown (working rule 3)
 *   `types.ts`              the engine's own vocabulary
 *
 * Note for `src/workflow/build.ts`: this file is **not** inlined into the Code
 * nodes. Its re-exports would survive the inliner's `export ` strip as bare
 * `* from './x.ts';` lines. The generator lists the implementation modules
 * instead, in dependency order.
 */

export {
  AI_ERROR_PREFIX,
  AIUnavailableError,
  aiStats,
  setFetcher,
} from './ai-client.ts';

export {
  clipReason,
  generateWish,
  selectReplacement,
} from './ai-selector.ts';

export { buildSelectPrompt, selectSystemPrompt } from './prompts.ts';

export { MIN_SAVING, filterCandidates, rejectReason } from './candidate-filter.ts';

export { fatPercent, parseSize, round2, sizeOf, unitPrice } from './product-utils.ts';

export {
  DEFAULT_MODE,
  MODES,
  SIZE_TOLERANCE,
  resolveMode,
  sizeBand,
} from './optimization-modes.ts';

export { confidentAt, minConfidence } from './confidence.ts';

export { buildPlan, computeSaving } from './plan-builder.ts';

export type { Mode, SizeTolerance } from './optimization-modes.ts';

export type {
  Alternate,
  Fetcher,
  HttpResponse,
  PlanContext,
  SelectedItem,
  Selection,
} from './types.ts';
