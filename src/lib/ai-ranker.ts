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

ЩО ВЖЕ ПЕРЕВІРЕНО КОДОМ — не перевіряй це вдруге:
- кожен кандидат дешевший за оригінал і дає відчутну економію;
- ціни обох лежать на одній базі (вагове з ваговим, фасоване з фасованим);
- фасування в межах від {MIN} до {MAX} від оригіналу;
- ціна за 100 г (або за літр) у кандидата краща, ніж в оригіналу;
- жирність, де вона є в назві, збігається.
Тому питання «чи це вигідно» вже вирішене. Твоє питання одне: ЧИ ЦЕ ТОЙ САМИЙ
ТОВАР ПО СУТІ.

ПОРЯДОК ПРІОРИТЕТІВ — саме в такому порядку:
1. зберегти суть покупки;
2. зберегти важливі властивості товару (жирність, міцність, смак, дієтичні);
3. зберегти прийнятне фасування;
4. нижча ціна;
5. більша економія.
Перші три — умови допуску: не виконано хоча б одну, кандидат вибуває. Серед тих,
хто пройшов, обирай НАЙДЕШЕВШОГО. Не обирай найсхожішого за назвою, якщо поруч
є так само прийнятний і дешевший.

БРЕНД: {BRAND}

verifySize=true став лише тоді, коли фасування СПРАВДІ неможливо порівняти —
наприклад «30шт» проти «1,5л», або воно вказане як «невідоме». Тоді ж тримай
confidence не вище 0,6.

ЦІНИ: порівнюй їх, щоб обрати найдешевшого прийнятного кандидата, але НЕ
повертай жодних сум і відсотків. Економію рахує код — раніше її рахувала модель
і на вагових товарах помилялася (на позиції 0,3 кг вийшло 1,32 замість 132,00).
Твоя робота — вибір, не множення.

ЗАПАСНІ ВАРІАНТИ:
Крім найкращого, назви ще до двох прийнятних кандидатів (alternates), від
дешевшого до дорожчого. Вони потрібні на випадок, коли найкращого не виявиться
в наявності. Це мають бути повноцінні заміни за тими самими правилами — не
«хоч щось». Якщо таких немає, поверни порожній список.

Кожному запасному дай СВОЮ reason і СВОЮ confidence — про нього самого, за тими
самими правилами, що й для основного. Не пиши «запасний варіант»: людина побачить
саме цей товар у себе в кошику і має прочитати, чому він підходить.

ФОРМАТ ВІДПОВІДІ — виключно JSON, без markdown і пояснень:
{"chosen":2,"accept":true,"confidence":0.85,"reason":"Той самий батончик Snickers, менша версія","verifySize":false,"alternates":[{"index":7,"reason":"Той самий батончик, інша начинка","confidence":0.75}]}

Якщо жоден кандидат не підходить:
{"chosen":null,"accept":false,"confidence":0.0,"reason":"Немає близького аналога","verifySize":false,"alternates":[]}

alternates — до двох запасних, від дешевшого до дорожчого; index — номер зі
списку кандидатів.

REASON — українською, ДО 60 СИМВОЛІВ. Довша не вміщається в один рядок на
телефоні й переноситься, ламаючи вигляд картки. Має пояснювати, ЧОМУ заміна
доречна, а не переказувати назву. Назви ту властивість, яка збіглася, і зупинись.
  добре: «Той самий сорт кави, та сама вага, дешевше»
  добре: «Молоко тієї ж жирності 2,5%, інша марка»
  погано: «Хороший аналог» / «Схожий товар» / «Кава Lavazza замість Jacobs»
  задовго: «Той самий безлактозний кисломолочний сир 5%, схоже фасування, дешевше за акцією»

CONFIDENCE — 0.0..1.0, наскільки впевнений, що суть покупки збережена. Шкала
робоча, не декоративна: від 0,8 заміну буде одразу позначено до застосування,
від 0,6 до 0,8 — показано, але людина має ввімкнути її сама, нижче 0,6 — не
показано взагалі.
  0.9  той самий товар іншої марки, усі властивості збігаються
  0.7  той самий тип товару, але відрізняється смак, сорт чи форма нарізки
  0.5  споріднена категорія, суть покупки під питанням — краще не пропонувати`;

/**
 * The selection prompt for one optimization mode.
 *
 * Built per call rather than stored as a constant because the band is now the
 * guest's choice. The result is still byte-identical across the calls of one
 * run, which is what keeps the prompt cache working (measured 1161 tokens,
 * against Sonnet 5's 1024-token minimum).
 */
export function selectSystemPrompt(mode?: string | null): string {
  const band = sizeBand(mode);
  return SELECT_SYSTEM_TEMPLATE.split('{MIN}')
    .join(String(band.min).replace('.', ','))
    .split('{MAX}')
    .join(String(band.max).replace('.', ','))
    .split('{BRAND}')
    .join(MODES[resolveMode(mode)].brand);
}

/** Pack size as Silpo reports it, whichever field this product carries. */
function sizeLabel(p: {
  ratio?: string | null;
  displayRatio?: string | null;
}): string {
  return p.displayRatio ?? p.ratio ?? "невідоме";
}

/**
 * Price per 100 g or per litre, as a label — computed here so the model never
 * divides.
 *
 * It is the number that makes two different pack sizes comparable at a glance,
 * and the one a shopper reads off a shelf edge. Absent when the pack size does
 * not parse, rather than guessed.
 */
function unitLabel(product: Parameters<typeof unitPrice>[0]): string {
  const unit = unitPrice(product);
  if (!unit) return '';
  return unit.unit === 'g'
    ? ` | за 100 г: ${round2(unit.value * 100)}`
    : ` | за літр: ${round2(unit.value * 1000)}`;
}

export function buildSelectPrompt(
  item: CartItem,
  candidates: ProductCandidate[],
): string {
  const lines = candidates.map(
    (c, i) =>
      `[${i}] ${c.name} | фасування: ${sizeLabel(c)} | ціна: ${c.price}${unitLabel(c)}${c.oldPrice != null ? ` (було ${c.oldPrice}, акція)` : ""}`,
  );

  return [
    `ТОВАР У КОШИКУ: ${item.name}${item.weighted ? ' (ваговий, ціна за кг)' : ''}`,
    `фасування: ${sizeLabel(item)} | ціна: ${item.price}${unitLabel(item)} | кількість: ${item.quantity}`,
    "",
    `КАНДИДАТИ (${candidates.length}):`,
    ...lines,
  ].join("\n");
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
    alternates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["index", "reason", "confidence"],
        additionalProperties: false,
      },
    },
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
      confidence: Math.max(0, Math.min(1, num(alt?.confidence))),
    });
    if (alternates.length === 2) break;
  }

  return {
    chosen,
    accept: Boolean(raw.accept),
    confidence: Math.max(0, Math.min(1, num(raw.confidence))),
    reason: clipReason(raw.reason),
    verifySize: Boolean(raw.verifySize),
    alternates,
  };
}

/* ------------------------------------------------------------------ plan */

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

export interface SelectedItem {
  item: CartItem;
  candidate: ProductCandidate | null;
  selection: Selection | null;
}

/**
 * Confidence bands, and what each one is allowed to do.
 *
 * The exact numbers now come from the guest's mode — see {@link MODES}. What
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
 *   - **≥ 0.8** — offered and ticked. The guest taps Apply and it happens.
 *   - **0.6 … 0.8** — offered and *unticked*. Visible, explained, one tap away,
 *     but never applied by a guest who did not read it.
 *   - **< 0.6** — not offered at all.
 *
 * Presenting the middle band unticked is the whole point of the change. It is
 * the difference between "here are three things I am sure of and one I am not"
 * and a list of four identical-looking rows, which is what shipped before.
 */

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

/** Lowest confidence a replacement may be offered at, in this mode. */
export function minConfidence(mode?: string | null): number {
  return MODES[resolveMode(mode)].minConfidence;
}

/** Confidence at which a replacement arrives ticked, in this mode. */
export function confidentAt(mode?: string | null): number {
  return MODES[resolveMode(mode)].confidentAt;
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

/* ------------------------------------------------------- the hard gate */

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

/** Two decimal places. Used for the post-write difference the guest is shown. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Assembles the plan from the model's own decisions and numbers. Ids and names
 * come from the MCP payload; every figure comes from the model.
 */
/**
 * Everything about the run that is true of the cart rather than of one line.
 *
 * Passed in rather than derived: `cartDiscount` and `couponsAvailable` come
 * from calls the pipeline already makes, and re-deriving them here would mean
 * this module knowing about MCP payload shapes it is deliberately kept away
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

export function buildPlan(
  cartItems: CartItem[],
  selected: SelectedItem[],
  context: PlanContext = {},
): OptimizationPlan {
  const loyalty = context.loyalty;
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
      // Drives whether the line is ticked when the card is first drawn, and the
      // «не певен» marker beside it. Resolved here rather than in the UI:
      // the bar depends on the mode, and the card is redrawn on every toggle
      // from a stored row that has no idea which mode produced it.
      confident: selection.confidence >= confidentAt(context.mode),
      aiSource: 'ai',
    };

    const keep =
      selection.accept &&
      selection.confidence >= minConfidence(context.mode) &&
      saving >= MIN_SAVING;
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
    // Stated, never summed into `saving`. See PlanSummary for why.
    cartDiscount: round2(context.cartDiscount ?? 0),
    couponsAvailable: context.couponsAvailable ?? 0,
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
