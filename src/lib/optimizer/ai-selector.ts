/**
 * The model's two jobs, and the reading of what it answers.
 *
 * Every judgement about a replacement — is it the same kind of product, is the
 * pack comparable — is made here, by the model. There is no hand-written
 * scoring, no keyword blocklist and no rule-based fallback: when the API is
 * unavailable the run fails loudly rather than degrading into a worse answer the
 * guest cannot tell apart.
 *
 * Two things stay in code on purpose:
 *
 *   - The model picks a candidate by **index**. Product ids, company ids and
 *     branch ids are then looked up from the real MCP response by the caller, so
 *     a hallucinated identifier cannot reach a cart write (working rule 2).
 *   - Not one figure the guest sees comes from here. `computeSaving()` and
 *     `buildPlan()` in `plan-builder.ts` produce every number from MCP prices
 *     (working rule 3).
 */

import type { CartItem, ProductCandidate } from '../types.ts';
import type { Alternate, Selection } from './types.ts';
import { WISH_MODEL, callModel, parseJson, textOf } from './ai-client.ts';
import { buildSelectPrompt, selectSystemPrompt } from './prompts.ts';
import { SELECT_SCHEMA, WISH_SCHEMA } from './schemas.ts';
import { clampConfidence } from './confidence.ts';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Holds a reason to one line on a phone.
 *
 * The prompt asks for 60 characters and mostly gets it, but a reason that runs
 * over wraps to the left margin in Telegram — losing the six-space indent that
 * makes an item read as one block — and there is no way to indent a wrapped
 * line in the Bot API. So the limit is enforced here as well, cut at a word
 * rather than mid-syllable: a reason that stops early still reads, one that
 * stops halfway through «фасуванн» does not.
 */
export function clipReason(text: unknown): string {
  const reason = String(text ?? '').trim();
  if (reason.length <= 60) return reason;
  const cut = reason.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '') + '…';
}

/**
 * Asks the model to choose a replacement for one cart line.
 *
 * Returns null when there is nothing to choose from; throws when the API is
 * unreachable, so the caller can tell "no good swap" apart from "no answer".
 */
export async function selectReplacement(
  item: CartItem,
  candidates: ProductCandidate[],
  apiKey: string,
  mode?: string | null,
): Promise<Selection | null> {
  if (!candidates.length) return null;

  // The last argument turns on system-prompt caching: this prompt is re-sent
  // once per cart line, byte-identical every time.
  const body = await callModel(
    selectSystemPrompt(mode),
    buildSelectPrompt(item, candidates),
    4000,
    SELECT_SCHEMA,
    apiKey,
    true,
  );
  const raw = parseJson<Partial<Selection>>(textOf(body));

  const chosen = raw.chosen == null ? null : Math.trunc(num(raw.chosen));
  if (chosen == null || chosen < 0 || chosen >= candidates.length) return null;

  // Indices are checked against the list actually shown, and the top pick is
  // dropped from the runners-up — the model repeats it there sometimes.
  const seen: number[] = [];
  const alternates: Alternate[] = [];
  for (const raw_alt of Array.isArray(raw.alternates) ? raw.alternates : []) {
    const alt = raw_alt as Partial<Alternate>;
    const index = Math.trunc(num(alt?.index));
    if (index < 0 || index >= candidates.length || index === chosen || seen.indexOf(index) !== -1) continue;
    seen.push(index);
    alternates.push({
      index,
      reason: clipReason(alt?.reason),
      confidence: clampConfidence(num(alt?.confidence)),
    });
    if (alternates.length === 2) break;
  }

  return {
    chosen,
    accept: Boolean(raw.accept),
    confidence: clampConfidence(num(raw.confidence)),
    reason: clipReason(raw.reason),
    verifySize: Boolean(raw.verifySize),
    alternates,
  };
}

/**
 * Asks the model for a receipt wish. Returns null on any problem.
 *
 * This is the one place a failure is answered with a silent fallback instead of
 * a raised error, and the reason is not inconsistency with the rest of the
 * engine — it is the opposite situation. A wish carries no number and no claim,
 * and it is written *after* the cart has already been changed: the message must
 * reach the guest so they learn what happened to their cart. A static line is
 * less personal, not wrong. The engine's fallback was removed because it made
 * unverifiable claims about money that looked identical to real ones.
 *
 * The prompts are passed in rather than imported so the engine stays free of
 * guest-facing copy (working rule 12); they live in `src/lib/ui.ts`.
 */
export async function generateWish(
  system: string,
  user: string,
  apiKey: string,
): Promise<string | null> {
  try {
    const body = await callModel(system, user, 600, WISH_SCHEMA, apiKey, false, WISH_MODEL, 'medium');
    const raw = parseJson<{ wish?: unknown }>(textOf(body));
    return typeof raw.wish === 'string' ? raw.wish : null;
  } catch {
    return null;
  }
}
