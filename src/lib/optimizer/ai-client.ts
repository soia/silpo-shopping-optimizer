/**
 * Talking to Anthropic, and nothing about shopping.
 *
 * One call, one retry policy, one token counter, and the injectable fetcher that
 * lets the same code run in the CLI and inside an n8n Code node. Nothing here
 * knows what a cart line is; everything that does lives a layer up in
 * `ai-selector.ts`.
 */

import type { Fetcher, HttpResponse, Message } from './types.ts';

export const MODEL = "claude-sonnet-5";
/**
 * The wish runs on the same model as everything else, and the first choice here
 * was wrong.
 *
 * Haiku 4.5 was picked to save money, on the reasoning that a one-line wish is
 * not a hard task. Measured over 8 generations it produced Ukrainian errors in
 * roughly half of them — «у дома», «напиток», «стіл буває щедрим», «при кожному
 * ґлоткові» — which is unacceptable in copy a Ukrainian retailer's guest reads.
 * Sonnet 5 produced 8 clean lines out of 8.
 *
 * Cost was never the binding constraint: the wish is ~2% of a run either way.
 * Optimising it was optimising the wrong thing.
 */
export const WISH_MODEL = MODEL;
const API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Raised when the model cannot be reached or answered unusably.
 *
 * The prefix is load-bearing: `mapLimit` flattens rejections into plain
 * strings, so without a recognisable marker an outage would look identical to
 * "no suitable replacement" and degrade silently — the exact failure mode
 * removing the fallback was meant to end.
 */
export const AI_ERROR_PREFIX = "AI unavailable";

export class AIUnavailableError extends Error {
  constructor(message: string) {
    super(`${AI_ERROR_PREFIX}: ${message}`);
    this.name = "AIUnavailableError";
  }
}

/**
 * Token accounting, mirroring `stats` in mcp.ts.
 *
 * `cacheReads` is the one worth watching: if it stays 0 across a run, the
 * system-prompt cache is not working and the run costs ~38% more input tokens
 * than it should. The API reports that silently — there is no error.
 */
export const aiStats = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWrites: 0,
  cacheReads: 0,
};

// Named `delay`, not `sleep`: the n8n HTTP helper already declares a top-level
// `sleep` in the same Code node, and a redeclaration is a syntax error there.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Used when the host provides a standards-compliant global `fetch`. */
const defaultFetcher: Fetcher = async (url, opts) => {
  const res = await fetch(url, opts);
  return { status: res.status, text: await res.text() };
};

let fetcher: Fetcher = defaultFetcher;

/** Lets the n8n Code node hand in `httpFetch` before the engine runs. */
export function setFetcher(fn: Fetcher): void {
  fetcher = fn;
}

/**
 * One call with the retry policy the rest of the project uses: 429 and 5xx get
 * exponential backoff with jitter, everything else fails immediately.
 *
 * Two things about this model are load-bearing and were learned the hard way:
 *
 *   - Adaptive thinking is ON by default on claude-sonnet-5, and `max_tokens`
 *     caps thinking *plus* the answer. A budget sized for the JSON alone spends
 *     it all on thinking and returns `stop_reason: max_tokens` with an empty
 *     text block. `budget_tokens` cannot be used to bound it — it returns 400
 *     on this model. Give the budget room instead.
 *   - `output_config.format` constrains the reply to the schema, so there is no
 *     markdown fence to strip and no half-JSON to repair.
 */
export async function callModel(
  system: string,
  user: string,
  maxTokens: number,
  schema: unknown,
  apiKey: string,
  cacheSystem = false,
  model: string = MODEL,
  effort: 'low' | 'medium' | 'high' | null = 'medium',
): Promise<Message> {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    // Caching is a prefix match, and the render order is tools → system →
    // messages. There are no tools, so a breakpoint on the system block covers
    // the whole repeated prefix; the per-item candidate list sits after it in
    // the user turn and varies freely without invalidating anything.
    //
    // Worth it only for the selection prompt, which is sent once per cart line
    // (measured 1161 tokens — just over Sonnet 5's 1024-token minimum, so it
    // caches, but a prompt edit that shortens it below 1024 would silently stop
    // caching with no error). The totals prompt runs once per cart, so there is
    // nothing to reuse.
    system: cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system,
    // `effort` is not accepted on every model — Haiku 4.5 rejects it outright —
    // so it is only sent where it is supported.
    //
    // `low` was tried first for selection and picked the most *similar*
    // candidate rather than the cheapest acceptable one, collapsing the saving
    // to 1 UAH on a 14-item cart. Choosing among 30 candidates is not the
    // trivial judgement it looked like. Measured cost of `medium` over `low`:
    // none (in=3043 out=80 vs out=82).
    output_config: effort
      ? { effort, format: { type: 'json_schema', schema } }
      : { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });

  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: HttpResponse;
    try {
      res = await fetcher(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
    } catch (e) {
      lastError = (e as Error).message;
      await delay(2 ** attempt * 500 + Math.random() * 300);
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      const message = JSON.parse(res.text) as Message;
      const u = message.usage ?? {};
      aiStats.calls++;
      aiStats.inputTokens += u.input_tokens ?? 0;
      aiStats.outputTokens += u.output_tokens ?? 0;
      aiStats.cacheWrites += u.cache_creation_input_tokens ?? 0;
      aiStats.cacheReads += u.cache_read_input_tokens ?? 0;
      return message;
    }

    lastError = `HTTP ${res.status}: ${res.text.slice(0, 300)}`;
    if (res.status !== 429 && res.status < 500) break;
    await delay(2 ** attempt * 500 + Math.random() * 300);
  }
  throw new AIUnavailableError(lastError);
}

export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Should be unreachable while output_config.format is set, so report the
    // body rather than silently coercing it into a "no replacement" answer.
    throw new AIUnavailableError(
      `model returned unparseable JSON: ${text.slice(0, 200)}`,
    );
  }
}

export function textOf(body: Message): string {
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text) {
    // Empty content is almost always max_tokens: the model spent its budget
    // before emitting the JSON. Say so, rather than reporting "unparseable".
    const blocks = (body.content ?? []).map((c) => c.type).join(",") || "none";
    throw new AIUnavailableError(
      `empty response (stop_reason: ${body.stop_reason ?? "?"}, blocks: ${blocks})`,
    );
  }
  return text;
}
