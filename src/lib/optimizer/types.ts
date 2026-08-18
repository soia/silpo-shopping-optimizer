/**
 * Types that belong to the engine rather than to the MCP payloads.
 *
 * The payload shapes live in `../types.ts`; what is here is the vocabulary of
 * the decision itself — what the model returns, what a run carries about the
 * cart as a whole, and the minimal HTTP contract that lets the engine run in
 * both hosts.
 *
 * Type-only, so it transpiles to nothing and the inliner in
 * `src/workflow/build.ts` drops it entirely.
 */

import type { CartItem, ProductCandidate, LoyaltyInfo } from '../types.ts';

/**
 * Minimal HTTP contract, so the engine runs unchanged in both hosts.
 *
 * The n8n Code-node sandbox has no global `fetch`; it has the project's own
 * `httpFetch`, which already normalises n8n's three possible transports to
 * exactly this shape. Keeping the engine transport-agnostic is what lets the
 * same files be the single source of truth for the CLI and the workflow.
 */
export interface HttpResponse {
  status: number;
  text: string;
}

export type Fetcher = (
  url: string,
  opts: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponse>;

/** The Anthropic message shape, narrowed to what the engine reads. */
export interface Message {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * A runner-up, judged in its own right.
 *
 * It used to be a bare index, and that was a real gap rather than a tidiness
 * one. When Silpo could not confirm the top pick, the runner-up was promoted
 * and inherited nothing to say for itself: the card printed «Запасний варіант —
 * основний виявився недоступним», which tells a guest nothing about the kefir
 * in front of them, and code floored its confidence at 0.6, which left it
 * unticked no matter how good it was.
 *
 * Both were code inventing a judgement it had not been given. The model now
 * makes it, in the same call and at no extra cost — three short fields instead
 * of one integer.
 */
export interface Alternate {
  index: number;
  reason: string;
  confidence: number;
}

export interface Selection {
  chosen: number | null;
  accept: boolean;
  confidence: number;
  reason: string;
  verifySize: boolean;
  /** Runners-up, ranked, each with its own verdict. */
  alternates: Alternate[];
}

export interface SelectedItem {
  item: CartItem;
  candidate: ProductCandidate | null;
  selection: Selection | null;
}

/**
 * Everything about the run that is true of the cart rather than of one line.
 *
 * Passed in rather than derived: `cartDiscount` and `couponsAvailable` come
 * from calls the pipeline already makes, and re-deriving them here would mean
 * the engine knowing about MCP payload shapes it is deliberately kept away
 * from.
 */
export interface PlanContext {
  loyalty?: LoyaltyInfo;
  /** `cart.calculation.subDiscount` — promotions Silpo already took off. */
  cartDiscount?: number;
  couponsAvailable?: number;
  /** The guest's optimization mode; sets both confidence bars. */
  mode?: string | null;
}
