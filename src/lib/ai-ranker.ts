/**
 * The decision engine.
 *
 * Every judgement about a replacement — is it the same kind of product, is the
 * pack comparable, what does it save — is made by the model. There is no
 * hand-written scoring, no keyword blocklist and no rule-based fallback: when
 * the API is unavailable the run fails loudly rather than degrading into a
 * worse answer the guest cannot tell apart.
 *
 * Two things stay in code on purpose:
 *
 *   - The model picks a candidate by **index**. Product ids, company ids and
 *     branch ids are then looked up from the real MCP response, so a
 *     hallucinated identifier cannot reach a cart write (working rule 2).
 *   - Sizes arrive as the raw strings Silpo returns ("1,5л", "180г"), so the
 *     model compares them directly instead of a parser guessing units.
 */

import type {
  CartItem,
  ProductCandidate,
  LoyaltyInfo,
  OptimizationPlan,
  Replacement,
  PlanSummary,
  ParsedSize,
} from "./types.ts";

const MODEL = "claude-sonnet-5";
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
const WISH_MODEL = MODEL;
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

/* -------------------------------------------------------------- transport */

interface Message {
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

/**
 * Minimal HTTP contract, so this module runs unchanged in both hosts.
 *
 * The n8n Code-node sandbox has no global `fetch`; it has the project's own
 * `httpFetch`, which already normalises n8n's three possible transports to
 * exactly this shape. Keeping the engine transport-agnostic is what lets the
 * same file be the single source of truth for the CLI and the workflow.
 */
export interface HttpResponse {
  status: number;
  text: string;
}

export type Fetcher = (
  url: string,
  opts: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponse>;

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
async function callModel(
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

function parseJson<T>(text: string): T {
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

function textOf(body: Message): string {
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

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------- selection */

const SELECT_SYSTEM_TEMPLATE = `Ти — асистент, який добирає заміни товарів у кошику супермаркету «Сільпо».

Тобі дають один товар із кошика і пронумерований список кандидатів на заміну.
Обери НЕ БІЛЬШЕ ОДНОГО кандидата — найкращий — або жодного.

ГОЛОВНЕ ПРАВИЛО: заміна має зберігати СУТЬ покупки. Дешевше — другорядне.

ПРИЙМАЙ, якщо товар виконує ту саму роль:
- молоко 2,5% → інше молоко 2,5%
- макарони → макарони іншого бренду
- куряче філе → куряче філе

ВІДХИЛЯЙ, якщо змінюється призначення:
- протеїновий/спортивний → звичайний солодкий
- молоко → рослинний напій (і навпаки)
- комбуча/ферментований → звичайний сік чи газованка
- безлактозний/безглютеновий/без цукру → звичайний (дієтичне обмеження!)
- дитяче харчування → недитяче
- інша жирність або градація (82% масло → 72,5%; сметана 15% → 20%)
- кардинально інший смак, якщо смак є суттю покупки

РОЗМІР УПАКОВКИ: у кожного товару вказано фасування (напр. «1,5л», «180г»).
Порівнюй його чесно. Фасування кандидата має бути в межах від {MIN} до {MAX}
від оригіналу.

ЦІНА ЗА ОДИНИЦЮ — обов'язкове правило. Якщо фасування кандидата МЕНШЕ за
оригінал, порахуй ціну за однакову кількість (за 100 г або за літр) і переконайся,
що вона краща. Менша упаковка за меншу ціну сама по собі — це НЕ економія:
двох таких може коштувати дорожче за оригінал. Не краща за одиницю — не обирай.

verifySize=true став лише тоді, коли фасування СПРАВДІ неможливо порівняти —
наприклад «30шт» проти «1,5л», або воно вказане як «невідоме». Тоді ж тримай
confidence не вище 0,6. Якщо обидва фасування зрозумілі, просто порівняй їх:
не підходить — не обирай кандидата, а не познач його прапорцем.

ЯК ОБИРАТИ СЕРЕД ПРИЙНЯТНИХ:
Спочатку відсій усіх, хто не зберігає суть покупки або має невідповідне
фасування. Серед тих, що лишились, обери НАЙДЕШЕВШОГО — того, що дає
найбільшу економію. Не обирай найсхожішого за назвою, якщо поруч є так само
прийнятний і суттєво дешевший.

Кандидат, що коштує стільки ж або дорожче за оригінал, не є заміною:
поверни chosen=null, а не такого кандидата.

ЦІНИ: порівнюй їх, щоб обрати найдешевшого прийнятного кандидата, але НЕ
повертай жодних сум і відсотків. Економію рахує код — раніше її рахувала модель
і на вагових товарах помилялася (на позиції 0,3 кг вийшло 1,32 замість 132,00).
Твоя робота — вибір, не множення.

ЗАПАСНІ ВАРІАНТИ:
Крім найкращого, назви ще до двох прийнятних кандидатів (alternates), від
дешевшого до дорожчого. Вони потрібні на випадок, коли найкращого не виявиться
в наявності. Це мають бути повноцінні заміни за тими самими правилами — не
«хоч щось». Якщо таких немає, поверни порожній список.

ФОРМАТ ВІДПОВІДІ — виключно JSON, без markdown і пояснень:
{"chosen":2,"accept":true,"confidence":0.85,"reason":"Той самий батончик Snickers, менша версія","verifySize":false,"alternates":[7,4]}

Якщо жоден кандидат не підходить:
{"chosen":null,"accept":false,"confidence":0.0,"reason":"Немає близького аналога","verifySize":false,"alternates":[]}

alternates — номери запасних кандидатів, від дешевшого до дорожчого, до двох.

reason — українською, до 90 символів, конкретно про товар.
confidence — 0.0..1.0, наскільки впевнений, що суть покупки збережена.`;

/**
 * The selection prompt for one tolerance setting.
 *
 * Built per call rather than stored as a constant because the band is now the
 * guest's choice. The result is still byte-identical across the calls of one
 * run, which is what keeps the prompt cache working (measured 1161 tokens,
 * against Sonnet 5's 1024-token minimum).
 */
export function selectSystemPrompt(tolerance?: string | null): string {
  const band = sizeBand(tolerance);
  return SELECT_SYSTEM_TEMPLATE.split('{MIN}')
    .join(String(band.min).replace('.', ','))
    .split('{MAX}')
    .join(String(band.max).replace('.', ','));
}

/** Pack size as Silpo reports it, whichever field this product carries. */
function sizeLabel(p: {
  ratio?: string | null;
  displayRatio?: string | null;
}): string {
  return p.displayRatio ?? p.ratio ?? "невідоме";
}

export function buildSelectPrompt(
  item: CartItem,
  candidates: ProductCandidate[],
): string {
  const lines = candidates.map(
    (c, i) =>
      `[${i}] ${c.name} | фасування: ${sizeLabel(c)} | ціна: ${c.price}${c.oldPrice != null ? ` (було ${c.oldPrice}, акція)` : ""}`,
  );

  return [
    `ТОВАР У КОШИКУ: ${item.name}`,
    `фасування: ${sizeLabel(item)} | ціна: ${item.price} | кількість: ${item.quantity}`,
    "",
    `КАНДИДАТИ (${candidates.length}):`,
    ...lines,
  ].join("\n");
}

export interface Selection {
  chosen: number | null;
  accept: boolean;
  confidence: number;
  reason: string;
  verifySize: boolean;
  /** Runners-up as indices into the list shown, ranked, from the same call. */
  alternates: number[];
}

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
 * Structured-output schema. Every object needs `additionalProperties: false`
 * and a full `required` list; numeric bounds are not supported, so confidence
 * is clamped in code after parsing.
 */
const SELECT_SCHEMA = {
  type: "object",
  properties: {
    chosen: { type: ["integer", "null"] },
    accept: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
    verifySize: { type: "boolean" },
    alternates: { type: "array", items: { type: "integer" } },
  },
  required: ["chosen", "accept", "confidence", "reason", "verifySize", "alternates"],
  additionalProperties: false,
} as const;

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
  tolerance?: string | null,
): Promise<Selection | null> {
  if (!candidates.length) return null;

  // The last argument turns on system-prompt caching: this prompt is re-sent
  // once per cart line, byte-identical every time.
  const body = await callModel(
    selectSystemPrompt(tolerance),
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
  const alternates = (Array.isArray(raw.alternates) ? raw.alternates : [])
    .map((a: unknown) => Math.trunc(num(a)))
    .filter((idx, at, all) => idx >= 0 && idx < candidates.length && idx !== chosen && all.indexOf(idx) === at)
    .slice(0, 2);

  return {
    chosen,
    accept: Boolean(raw.accept),
    confidence: Math.max(0, Math.min(1, num(raw.confidence))),
    reason: String(raw.reason ?? "").slice(0, 120),
    verifySize: Boolean(raw.verifySize),
    alternates,
  };
}

/* ------------------------------------------------------------------ plan */

export interface SelectedItem {
  item: CartItem;
  candidate: ProductCandidate | null;
  selection: Selection | null;
}

/** Minimum confidence for a replacement to be offered to the guest. */
export const MIN_CONFIDENCE = 0.5;

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

/** Unknown or missing values fall back to `normal` rather than to the widest band. */
export function sizeBand(tolerance?: string | null): { min: number; max: number } {
  const preset = SIZE_TOLERANCE[(tolerance || 'normal') as SizeTolerance];
  return preset ? { min: preset.min, max: preset.max } : SIZE_TOLERANCE.normal;
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

/** Two decimal places. Used for the post-write difference the guest is shown. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Assembles the plan from the model's own decisions and numbers. Ids and names
 * come from the MCP payload; every figure comes from the model.
 */
export function buildPlan(
  cartItems: CartItem[],
  selected: SelectedItem[],
  loyalty?: LoyaltyInfo,
): OptimizationPlan {
  const replacements: Replacement[] = [];
  const rejected: Replacement[] = [];

  for (const { item, candidate, selection } of selected) {
    if (!candidate || !selection) continue;
    const { saving, savingPct } = computeSaving(item, candidate);

    const replacement: Replacement = {
      originalProductId: item.productId,
      originalName: item.name,
      originalPrice: item.price,
      originalRatio: item.ratio ?? null,
      quantity: item.quantity,
      replacementProductId: candidate.id,
      replacementCompanyId: candidate.companyId,
      replacementBranchId: candidate.branchId,
      replacementName: candidate.name,
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
      aiSource: 'ai',
    };

    const keep = selection.accept && selection.confidence >= MIN_CONFIDENCE && saving > 0;
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
  };

  return { replacements, rejectedByAI: rejected, summary };
}

/* ------------------------------------------------------------------ wish */

const WISH_SCHEMA = {
  type: 'object',
  properties: { wish: { type: 'string' } },
  required: ['wish'],
  additionalProperties: false,
} as const;

/**
 * Asks the model for a receipt wish. Returns null on any problem.
 *
 * This is the one place a failure is answered with a silent fallback instead of
 * a raised error, and the reason is not inconsistency with the rest of the
 * module — it is the opposite situation. A wish carries no number and no claim,
 * and it is written *after* the cart has already been changed: the message must
 * reach the guest so they learn what happened to their cart. A static line is
 * less personal, not wrong. The engine's fallback was removed because it made
 * unverifiable claims about money that looked identical to real ones.
 *
 * The prompts are passed in rather than imported so the module stays free of
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
