/**
 * Generates the importable n8n workflow JSON.
 *
 * Why a generator instead of hand-written JSON: the optimization engine is
 * inlined into the Code nodes straight from `src/lib/optimizer.ts` — the same
 * file the local runs and the type checker use. One source of truth, so the
 * workflow can never drift from the logic that was actually verified.
 *
 * Note on language: code comments and identifiers are English, but strings the
 * customer reads in Telegram stay Ukrainian — the bot serves Silpo guests.
 *
 *   npm run build:workflows
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PLACEHOLDERS, deployment, hasDeployment, personalise } from './config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outFile = (name: string) => resolve(ROOT, 'workflows', name);

/**
 * Public base URL of the n8n instance, used to build the OAuth redirect URI.
 * Baked in so the workflows import and run without extra configuration; an
 * `N8N_BASE_URL` variable (Settings → Variables) overrides it when present.
 */
const DEFAULT_BASE_URL = PLACEHOLDERS.baseUrl;

/**
 * Whether to include the Anthropic call in the workflow.
 *
 * With no Anthropic credential configured, n8n fails the node outright ("no
 * credentials set") rather than routing through `onError`, so the node is left
 * out entirely instead. `Apply AI Decisions` then receives the prompt item,
 * finds no model response in it, and applies the rule-based fallback — the same
 * path a failed API call takes.
 *
 * Flip to true once the credential exists, then `npm run build:workflows`.
 */
const AI_SEMANTIC_CHECK = false;

/** Strips TypeScript types and module syntax so the result runs in a Code node. */
function inlineModule(relativePath: string): string {
  const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false },
  });
  return outputText
    .replace(/^\s*import\s.*?;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .trim();
}

const OPTIMIZER = inlineModule('src/lib/optimizer.ts');

/* ------------------------------------------------------------------ helpers */

interface N8nNode {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  credentials?: Record<string, { id: string; name: string }>;
  onError?: string;
  alwaysOutputData?: boolean;
}

interface NodeOptions {
  x?: number;
  y?: number;
  typeVersion?: number;
  credentials?: Record<string, { id: string; name: string }>;
  onError?: string;
  alwaysOutputData?: boolean;
}

const TELEGRAM_CREDENTIALS = { telegramApi: { id: 'SILPO_TG', name: 'Silpo Bot' } };

/**
 * n8n Data Tables, created in the UI (Overview → Data tables).
 *
 * Ids are instance-specific — recreating the tables means updating them here and
 * rebuilding. Every table also carries the system columns `id`, `createdAt` and
 * `updatedAt`; `createdAt` is what the TTL checks use.
 */
const TABLES = {
  oauthState: {
    id: PLACEHOLDERS.tables.oauthState,
    name: 'silpo_oauth_state',
    columns: {
      state: 'string',
      telegram_user_id: 'number',
      chat_id: 'number',
      code_verifier: 'string',
      client_id: 'string',
    },
  },
  sessions: {
    id: PLACEHOLDERS.tables.sessions,
    name: 'silpo_sessions',
    columns: {
      telegram_user_id: 'number',
      client_id: 'string',
      access_token_enc: 'string',
      expires_at: 'string',
      refresh_token_enc: 'string',
      blocked_brands: 'string',
    },
  },
  plans: {
    id: PLACEHOLDERS.tables.plans,
    name: 'optimization_plans',
    columns: {
      plan_id: 'string',
      telegram_user_id: 'number',
      cart_id: 'string',
      plan_json: 'string',
      original_total: 'number',
      status: 'string',
    },
  },
};

type Table = (typeof TABLES)[keyof typeof TABLES];

/** Data Table filters support equality only — age checks happen in Code nodes. */
type Filter = { keyName: string; keyValue: string };

/** Resource-mapper metadata the Data Table node expects alongside the values. */
function columnSchema(table: Table) {
  return Object.entries(table.columns).map(([id, type]) => ({
    id,
    displayName: id,
    required: false,
    defaultMatch: false,
    display: true,
    type,
    readOnly: false,
    removed: false,
  }));
}

function makeNode(name: string, type: string, parameters: Record<string, unknown>, options: NodeOptions = {}): N8nNode {
  return {
    parameters,
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    type,
    typeVersion: options.typeVersion ?? 1,
    position: [options.x ?? 0, options.y ?? 0],
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.alwaysOutputData ? { alwaysOutputData: true } : {}),
  };
}

const codeNode = (name: string, jsCode: string, options: NodeOptions = {}) =>
  makeNode(name, 'n8n-nodes-base.code', { jsCode, mode: 'runOnceForAllItems' }, { typeVersion: 2, ...options });

interface DataTableParams {
  /** `insert` is the node's default and is serialized without the key. */
  operation: 'get' | 'insert' | 'update' | 'upsert' | 'deleteRows';
  table: Table;
  filters?: Filter[];
  columns?: Record<string, unknown>;
}

function dataTableNode(name: string, params: DataTableParams, options: NodeOptions = {}) {
  const { operation, table, filters, columns } = params;
  return makeNode(
    name,
    'n8n-nodes-base.dataTable',
    {
      ...(operation === 'insert' ? {} : { operation }),
      dataTableId: { __rl: true, value: table.id, mode: 'list', cachedResultName: table.name },
      ...(filters ? { filters: { conditions: filters } } : {}),
      ...(columns
        ? {
            columns: {
              mappingMode: 'defineBelow',
              value: columns,
              matchingColumns: [],
              schema: columnSchema(table),
              attemptToConvertTypes: false,
              convertFieldsToString: false,
            },
          }
        : {}),
      // Observed on every operation except `get`.
      ...(operation === 'get' ? {} : { options: {} }),
    },
    { typeVersion: 1.1, ...options },
  );
}

const telegramNode = (name: string, parameters: Record<string, unknown>, options: NodeOptions = {}) =>
  makeNode(name, 'n8n-nodes-base.telegram', parameters, { typeVersion: 1.2, credentials: TELEGRAM_CREDENTIALS, ...options });

const stringCondition = (value: string) => ({
  options: { caseSensitive: true, version: 2 },
  combinator: 'and',
  conditions: [{ operator: { type: 'string', operation: 'equals' }, leftValue: '={{ $json.action }}', rightValue: value }],
});

/**
 * A wish printed under the result, the way Silpo prints one at the bottom of a
 * till receipt.
 *
 * These are written for this project in that spirit — the real receipt texts are
 * Silpo's own, produced by their in-house authors, and are not reproduced here.
 * A couple of lines react to how the run went so the note does not feel bolted
 * on; the rest are drawn at random.
 */
const RECEIPT_WISHES = `
const WISHES = [
  'Нехай попереду буде тиждень, у якому все складається легше, ніж здавалося.',
  'Найсмачніше в цьому кошику — те, що ви приготуєте самі.',
  'Дрібні заощадження мають звичку перетворюватися на великі радощі.',
  'Завтра трапиться щось приємне. Дрібниця, але точно вчасно.',
  'Хтось сьогодні згадає вас добрим словом. Можливо, за вечерю.',
  'Хороший день починається просто: смачно поїсти й нікуди не поспішати.',
  'Нехай удома на вас чекає тиша або сміх — залежно від того, чого більше хочеться.',
  'Іноді найкращий план на вечір — це добре повечеряти.',
  'Ви щойно виграли трохи часу для себе. Витратьте його без користі.',
  'Те, що ви шукали, знайдеться. Найімовірніше, на нижній полиці.',
  'У цьому тижні буде день, який захочеться запам’ятати. Не пропустіть його.',
  'Смак дому не залежить від ціни. Але приємно, коли він ще й вигідний.'
];

function pickWish(saving, applied) {
  if (applied === 0) return 'Ваш кошик уже такий, як треба. Як і цей день.';
  if (saving >= 150) return 'Такою економією можна пишатися. Або мовчки купити собі каву.';
  if (saving > 0 && saving < 10) return 'Навіть маленька економія — це привід зробити собі щось приємне.';
  return WISHES[Math.floor(Math.random() * WISHES.length)];
}
`;

/**
 * Brand comparison across alphabets.
 *
 * Silpo writes the same brand both ways — «Премія» in names, `PREMIA` in the
 * "Торгова марка" attribute; «Асканія» and `Ascania`. Exact matching therefore
 * fails exactly when the guest needs it most, so both sides are transliterated
 * to a common skeleton before comparing.
 */
const BRAND_HELPERS = `
const CYRILLIC_TO_LATIN = {
  'а':'a','б':'b','в':'v','г':'h','ґ':'g','д':'d','е':'e','є':'ie','ж':'zh','з':'z',
  'и':'y','і':'i','ї':'i','й':'i','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p',
  'р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh',
  'щ':'shch','ь':'','ю':'iu','я':'ia','ы':'y','э':'e','ъ':''
};

function normalizeBrand(value) {
  const lower = String(value || '').toLowerCase();
  let out = '';
  for (const ch of lower) {
    out += Object.prototype.hasOwnProperty.call(CYRILLIC_TO_LATIN, ch) ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  // Latin spellings of the same sounds diverge in predictable ways:
  //   Асканія/Ascania  -> k vs c      Яготинське/Yagotynske -> h vs g
  //   премія/PREMIA    -> ii vs i     й/y/j                 -> i
  // "ch" is protected first, otherwise c->k would corrupt Чумак/Chumak.
  out = out.replace(/[^a-z0-9]/g, '');
  out = out.split('ch').join('\u0001');
  out = out.split('c').join('k').split('\u0001').join('ch');
  out = out.split('g').join('h').split('y').join('i').split('j').join('i');
  let collapsed = '';
  for (const ch of out) {
    if (collapsed.charAt(collapsed.length - 1) !== ch) collapsed += ch;
  }
  return collapsed;
}

function brandMatches(a, b) {
  const left = normalizeBrand(a);
  const right = normalizeBrand(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // Containment covers multi-word brands ("Лавка традицій Lago" vs "Lago"), but
  // only for names long enough that a coincidental substring is unlikely.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 4 && longer.indexOf(shorter) !== -1;
}
`;

/**
 * Builds the selection card — text plus a checkbox keyboard.
 *
 * The n8n Telegram node takes a keyboard declared in its parameters, so it
 * cannot render one button per replacement when the count varies. These two
 * messages therefore go through the Telegram Bot API directly, where
 * `reply_markup` is just JSON we assemble here.
 */
const SELECTION_CARD = `
function buildSelectionCard(plan, selected) {
  const money = n => Number(n).toFixed(2).replace('.', ',') + ' грн';
  // Product names go into a Markdown message. An unmatched _ or * makes Telegram
  // reject the whole send with HTTP 400, so escape them in dynamic text.
  // Written without regex literals or backslash escapes on purpose: this string
  // passes through a TypeScript template literal on the way into the node, and
  // that layer eats them - an earlier build emitted the broken class
  // a broken character class that silently escaped nothing.
  const BACKSLASH = String.fromCharCode(92);
  const MD_SPECIAL = '_*[]' + String.fromCharCode(96);
  const md = t => String(t).split('').map(ch => (MD_SPECIAL.indexOf(ch) === -1 ? ch : BACKSLASH + ch)).join('');
  const replacements = plan.replacements || [];
  const chosen = replacements.filter((r, i) => selected.indexOf(i) !== -1);
  const saving = chosen.reduce((sum, r) => sum + r.saving, 0);
  const originalTotal = plan.summary.originalTotal;

  let text = '🛒 *Я проаналізував ваш кошик*\\n\\n'
    + 'Було: *' + money(originalTotal) + '*\\n'
    + 'Може стати: *' + money(originalTotal - saving) + '*\\n\\n'
    + '💰 *Економія: ' + money(saving) + '*'
    + (originalTotal > 0 ? ' (' + (Math.round(saving / originalTotal * 1000) / 10) + '%)' : '')
    + '\\n\\n';

  // Nothing to choose from: report what was checked and offer no buttons, since
  // "Застосувати" and "Деталі" would both lead nowhere.
  if (!replacements.length) {
    let empty = '🛒 *Я проаналізував ваш кошик*\\n\\n'
      + plan.summary.itemsAnalyzed + ' товарів на *' + money(originalTotal) + '*\\n\\n'
      + '✅ Дешевших аналогів, які зберігають суть покупки, не знайшов.\\n'
      + '_Ваш кошик уже оптимальний._';
    if (plan.slotExpired) {
      empty += '\\n\\n⏰ _Слот доставки протух — наявність могла зчитатися неточно.'
        + ' Оберіть новий слот у застосунку і спробуйте ще раз._';
    }
    if (plan.summary.bonusAvailable > 0) {
      empty += '\\n\\n💳 Балабонуси: ' + plan.summary.bonusAvailable + ' грн — застосуйте при оформленні.';
    }
    return { text: empty, keyboard: [] };
  }

  text += 'Оберіть, що застосувати:\\n\\n';
  replacements.forEach((r, i) => {
    const on = selected.indexOf(i) !== -1;
    text += (on ? '✅ ' : '☐ ') + (i + 1) + '. ' + md(r.originalName) + '\\n'
      + '   → ' + md(r.replacementName) + '\\n'
      + '   ' + money(r.originalPrice) + ' → ' + money(r.replacementPrice)
      + '  💰 −' + money(r.saving) + (r.onPromotion ? ' 🎁' : '')
      // Shown so the guest can copy it straight into /block.
      + (r.brand ? '\\n   марка: ' + md(r.brand) : '')
      + (r.verifySize ? '\\n   ⚠️ перевірте об\\'єм' : '')
      + '\\n\\n';
  });

  // Candidate pack size is not in any search response, so it can only be checked
  // once the item is in the cart. Saying so up front keeps a rollback from
  // looking like a malfunction.
  text += '_Об\\'єм упаковки «Сільпо» у пошуку не показує. Перевірю його при застосуванні'
    + ' і скасую заміну, якщо він суттєво відрізняється._\\n\\n';
  if (replacements.some(r => r.brand)) {
    text += '_Не хочете якусь марку? Напишіть_ \`/block\` _і її назву._\\n\\n';
  }
  if (plan.slotExpired) {
    text += '⏰ _Слот доставки протух — наявність може відрізнятися._\\n\\n';
  }
  if (plan.summary.bonusAvailable > 0) {
    text += '💳 _Балабонуси: ' + plan.summary.bonusAvailable + ' грн, застосуйте при оформленні._';
  }

  // One toggle per replacement, then the action row.
  const keyboard = replacements.map((r, i) => ([{
    text: (selected.indexOf(i) !== -1 ? '✅ ' : '☐ ') + (i + 1) + '. ' + r.originalName.slice(0, 28),
    callback_data: 't:' + plan.planId + ':' + i,
  }]));

  keyboard.push([
    { text: '✅ Застосувати обране (' + chosen.length + ')', callback_data: 'apply:' + plan.planId },
    { text: '❌ Скасувати', callback_data: 'cancel:' + plan.planId },
  ]);

  return { text, keyboard };
}

function telegramApiUrl(method) {
  const token = readVar('TELEGRAM_BOT_TOKEN');
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN variable is not set (Settings → Variables, scope Global)');
  }
  return 'https://api.telegram.org/bot' + token + '/' + method;
}
`;

/* -------------------------------------------------- shared Code-node runtime */

/**
 * Reads a value from n8n Variables (Settings → Variables, scope Global).
 *
 * `$env` is deliberately not touched: n8n Cloud defines the object but throws
 * "access to env vars denied" on any property read, so even a `typeof` guard
 * does not protect against it. Variables are the only portable channel.
 */
const READ_VAR = `
function readVar(name) {
  try {
    return (typeof $vars !== 'undefined' && $vars[name]) || null;
  } catch (e) {
    return null;
  }
}
`;

/**
 * HTTP for Code nodes.
 *
 * The sandbox has no global `fetch`, so this tries three transports in order and
 * normalises them to one small shape: `{ status, headers.get(name), text }`.
 * Non-2xx responses are returned rather than thrown — the MCP client needs to
 * see 401 and 429 to refresh and back off.
 */
const HTTP_HELPER = `
// The Code-node sandbox is a restricted VM, not Node: there is no fetch, no URL
// and no URLSearchParams, and require() is limited to an allowlist - 'crypto'
// loads, 'url' and 'buffer' are rejected outright.
//
// Buffer is therefore taken from a real Buffer instance produced by crypto,
// which needs no module and no global.
const Buf = require('crypto').randomBytes(0).constructor;

// The node context is bound to 'this' only at the top level of a Code node;
// inside a plain function call it is undefined. Capture the helper here.
const _nodeHelpers = (function () {
  try {
    return this && this.helpers ? this.helpers : null;
  } catch (e) {
    return null;
  }
}).call(this);

function _toText(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (raw.constructor === Buf) return raw.toString('utf8');
  if (raw.type === 'Buffer' && Array.isArray(raw.data)) return Buf.from(raw.data).toString('utf8');
  return JSON.stringify(raw);
}

function sleep(ms) {
  if (typeof setTimeout !== 'function') return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toQuery(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}

async function httpFetch(url, opts) {
  const method = (opts && opts.method) || 'GET';
  const headers = (opts && opts.headers) || {};
  const body = opts && opts.body;
  const wrap = (status, headerObj, text) => ({
    status,
    text,
    headers: { get: (n) => headerObj[String(n).toLowerCase()] },
  });

  // 1. Native fetch, when the runtime provides it.
  if (typeof fetch === 'function') {
    const res = await fetch(url, { method, headers, body });
    return { status: res.status, text: await res.text(), headers: { get: (n) => res.headers.get(n) } };
  }

  // 2. n8n's own HTTP helper — the transport that actually exists on Cloud.
  if (_nodeHelpers && _nodeHelpers.httpRequest) {
    try {
      const res = await _nodeHelpers.httpRequest({
        url, method, headers, body,
        json: false,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
      });
      return wrap(res.statusCode || 200, res.headers || {}, _toText(res.body));
    } catch (err) {
      // Older helpers throw on non-2xx instead of honouring
      // ignoreHttpStatusErrors. Recover the status so 401 and 429 stay visible
      // to the retry logic rather than surfacing as a generic failure.
      const response = err && err.response;
      const status = (err && (err.statusCode || err.httpCode))
        || (response && (response.statusCode || response.status));
      if (status) {
        return wrap(Number(status), (response && response.headers) || {}, _toText(response && response.body));
      }
      throw err;
    }
  }

  // 3. Raw https module, if the allowlist happens to permit it.
  let https;
  try {
    https = require('https');
  } catch (e) {
    throw new Error('NO_HTTP_TRANSPORT: sandbox has no fetch, no this.helpers.httpRequest and no https module');
  }
  // Parsed with string ops rather than a regex: escaping a regex through this
  // template literal is how the previous build silently produced a comment.
  const withoutScheme = String(url).replace('https://', '').replace('http://', '');
  const firstSlash = withoutScheme.indexOf('/');
  const hostPort = firstSlash === -1 ? withoutScheme : withoutScheme.slice(0, firstSlash);
  const path = firstSlash === -1 ? '/' : withoutScheme.slice(firstSlash);
  const colon = hostPort.indexOf(':');
  const hostname = colon === -1 ? hostPort : hostPort.slice(0, colon);
  const port = colon === -1 ? 443 : Number(hostPort.slice(colon + 1));

  return await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port, path, method, headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(wrap(res.statusCode, res.headers || {}, data)));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
`;

/** MCP client for Code nodes — mirrors src/lib/mcp.ts, token comes from the DB. */
const MCP_CLIENT = `
${HTTP_HELPER}
const MCP_URL = 'https://mcp.silpo.ua/mcp';
const TOKEN_URL = 'https://mcp.silpo.ua/token';
const PROTOCOL_VERSION = '2025-06-18';

function createMcp(session) {
  let accessToken = session.access_token;
  let refreshed = null;
  let initialized = false;

  async function refresh() {
    const res = await httpFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: toQuery({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: session.client_id,
        resource: MCP_URL,
      }),
    });
    if (res.status < 200 || res.status >= 300) { const e = new Error('SILPO_REAUTH_REQUIRED'); e.code = 'REAUTH'; throw e; }
    const t = JSON.parse(res.text);
    accessToken = t.access_token;
    refreshed = {
      access_token: t.access_token,
      refresh_token: t.refresh_token || session.refresh_token,
      expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    };
    return accessToken;
  }

  async function rpc(method, params) {
    const id = Math.floor(Math.random() * 1e9);
    const send = () => httpFetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + accessToken,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

    let res = await send();
    if (res.status === 401) { await refresh(); res = await send(); }
    for (let i = 0; (res.status === 429 || res.status >= 500) && i < 5; i++) {
      await sleep(Math.pow(2, i) * 1000 + Math.random() * 250);
      res = await send();
    }
    if (res.status === 403) { const e = new Error('SILPO_FORBIDDEN'); e.code = 'FORBIDDEN'; throw e; }
    if (res.status < 200 || res.status >= 300) { const e = new Error('SILPO_MCP_ERROR_' + res.status); e.code = 'MCP'; throw e; }

    const raw = res.text;
    let msg;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const line of raw.split('\\n')) {
        if (!line.startsWith('data:')) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m.id === id || m.error) msg = m; } catch (e) {}
      }
    } else { msg = JSON.parse(raw); }
    if (!msg) throw new Error('SILPO_EMPTY_RESPONSE');
    if (msg.error) throw new Error('SILPO_RPC_' + msg.error.code);
    return msg.result;
  }

  return {
    async call(name, args) {
      if (!initialized) {
        await rpc('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'silpo-optimizer-n8n', version: '1.0.0' },
        });
        initialized = true;
      }
      const result = await rpc('tools/call', { name, arguments: args || {} });
      const textPart = (result.content || []).find(c => c.type === 'text');
      let data = result;
      if (textPart) { try { data = JSON.parse(textPart.text); } catch (e) { data = { raw: textPart.text }; } }
      if (result.isError) {
        const detail = typeof data === 'string' ? data : JSON.stringify(data);
        const e = new Error('TOOL_ERROR_' + name + ': ' + String(detail).slice(0, 300));
        e.code = 'TOOL';
        e.detail = data;
        throw e;
      }
      return data;
    },
    getRefreshed: () => refreshed,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { out[i] = { ok: false, error: e.message }; }
    }
  }));
  return out;
}
`;

/** AES-256-GCM helpers — the database only ever stores ciphertext. */

const CRYPTO_HELPERS = `
const crypto = require('crypto');
${READ_VAR}
${HTTP_HELPER}
function encKey() {
  const k = readVar('TOKEN_ENCRYPTION_KEY');
  if (!k || k.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (openssl rand -hex 32), set under Settings → Variables with scope Global');
  }
  return Buf.from(k, 'hex');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buf.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}
function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buf.from(ivHex, 'hex'));
  d.setAuthTag(Buf.from(tagHex, 'hex'));
  return Buf.concat([d.update(Buf.from(dataHex, 'hex')), d.final()]).toString('utf8');
}
`;

/* ============================================================ bot workflow */

function buildBotWorkflow() {
  const nodes: N8nNode[] = [];
  const connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }> = {};

  const link = (from: string, to: string, outputIndex = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
    connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  };

  /* --- trigger and routing ------------------------------------------- */
  nodes.push(
    makeNode('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', { updates: ['message', 'callback_query'], additionalFields: { appendAttribution: false } }, {
      typeVersion: 1.1,
      x: -600,
      y: 0,
      credentials: TELEGRAM_CREDENTIALS,
    }),
  );

  nodes.push(
    codeNode(
      'Route Request',
      `
// Resolves the user's intent. No secrets and no MCP calls happen here.
const items = [];
for (const item of $input.all()) {
  const update = item.json;
  const message = update.message || (update.callback_query && update.callback_query.message);
  const from = (update.message && update.message.from) || (update.callback_query && update.callback_query.from);
  const text = ((update.message && update.message.text) || '').trim();
  const callbackData = (update.callback_query && update.callback_query.data) || '';

  let action = 'unknown';
  let planId = null;

  let toggleIndex = null;
  let brandArg = null;

  if (callbackData) {
    // apply:<planId> | details:<planId> | cancel:<planId> | t:<planId>:<index>
    const parts = callbackData.split(':');
    action = parts[0] === 't' ? 'toggle' : parts[0];
    planId = parts[1] || null;
    if (action === 'toggle') toggleIndex = Number(parts[2]);
  } else if (text.startsWith('/unblock')) {
    // Sliced rather than matched: a regex literal here would lose its escapes
    // passing through the generator's template literal.
    action = 'unblock';
    brandArg = text.slice('/unblock'.length).trim();
  } else if (text.startsWith('/blocked')) {
    action = 'blocked';
  } else if (text.startsWith('/block')) {
    action = 'block';
    brandArg = text.slice('/block'.length).trim();
  } else if (text.startsWith('/start')) action = 'start';
  else if (text.startsWith('/connect')) action = 'connect';
  else if (text.startsWith('/optimize') || text.includes('Оптимізувати')) action = 'optimize';
  else if (text.startsWith('/cart')) action = 'cart';

  items.push({ json: {
    action,
    planId,
    toggleIndex,
    brandArg,
    chatId: message && message.chat && message.chat.id,
    telegramUserId: from && from.id,
    callbackQueryId: (update.callback_query && update.callback_query.id) || null,
    messageId: (message && message.message_id) || null,
    firstName: (from && from.first_name) || '',
  }});
}
return items;
`,
      { x: -380, y: 0 },
    ),
  );
  link('Telegram Trigger', 'Route Request');

  nodes.push(
    dataTableNode(
      'Load Session',
      { operation: 'get', table: TABLES.sessions, filters: [{ keyName: 'telegram_user_id', keyValue: '={{ $json.telegramUserId }}' }] },
      { x: -160, y: 0, alwaysOutputData: true },
    ),
  );
  link('Route Request', 'Load Session');

  nodes.push(
    codeNode(
      'Merge Session',
      `
${CRYPTO_HELPERS}
// The lookup returns zero or one row; join it back onto the routed intent.
const routed = $('Route Request').all().map(i => i.json);
const rows = $input.all().map(i => i.json).filter(r => r && r.telegram_user_id);

return routed.map(r => {
  const row = rows.find(x => String(x.telegram_user_id) === String(r.telegramUserId));
  let session = null;
  if (row && row.access_token_enc) {
    session = {
      client_id: row.client_id,
      access_token: decrypt(row.access_token_enc),
      refresh_token: decrypt(row.refresh_token_enc),
      expires_at: row.expires_at,
    };
  }
  const blockedBrands = row && row.blocked_brands
    ? String(row.blocked_brands).split('|').map(b => b.trim()).filter(Boolean)
    : [];
  return { json: { ...r, authorized: Boolean(session), session, blockedBrands } };
});
`,
      { x: 60, y: 0 },
    ),
  );
  link('Load Session', 'Merge Session');

  nodes.push(
    makeNode(
      'Switch Action',
      'n8n-nodes-base.switch',
      {
        rules: {
          values: [
            { conditions: stringCondition('optimize'), outputKey: 'optimize' },
            { conditions: stringCondition('apply'), outputKey: 'apply' },
            { conditions: stringCondition('connect'), outputKey: 'connect' },
            { conditions: stringCondition('cancel'), outputKey: 'cancel' },
            { conditions: stringCondition('details'), outputKey: 'details' },
            { conditions: stringCondition('cart'), outputKey: 'cart' },
            { conditions: stringCondition('toggle'), outputKey: 'toggle' },
            { conditions: stringCondition('block'), outputKey: 'block' },
            { conditions: stringCondition('unblock'), outputKey: 'unblock' },
            { conditions: stringCondition('blocked'), outputKey: 'blocked' },
          ],
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'other' },
      },
      { typeVersion: 3.2, x: 280, y: 0 },
    ),
  );
  link('Merge Session', 'Switch Action');

  /* --- connect branch: OAuth 2.1 + PKCE ------------------------------- */
  nodes.push(
    codeNode(
      'Build Auth URL',
      `
const crypto = require('crypto');
${READ_VAR}
${HTTP_HELPER}
const b64url = b => b.toString('base64').replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const N8N_BASE_URL = readVar('N8N_BASE_URL') || '${DEFAULT_BASE_URL}';
const REDIRECT_URI = N8N_BASE_URL.replace(/\\/$/, '') + '/webhook/silpo/callback';

const out = [];
for (const item of $input.all()) {
  // Dynamic Client Registration: Silpo issues the client_id on demand, so no
  // application has to be registered by hand. Verified: POST /register → 201,
  // and no client_secret is returned (public client + PKCE).
  const registration = await httpFetch('https://mcp.silpo.ua/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Silpo Shopping Optimizer',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    }),
  });
  if (registration.status < 200 || registration.status >= 300) {
    throw new Error('DCR_FAILED_' + registration.status + '_' + String(registration.text).slice(0, 120));
  }
  const client = JSON.parse(registration.text);

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = 'https://mcp.silpo.ua/authorize?' + toQuery({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: 'https://mcp.silpo.ua/mcp',
  });

  out.push({ json: { ...item.json, authUrl, state, codeVerifier: verifier, clientId: client.client_id } });
}
return out;
`,
      { x: 520, y: -320 },
    ),
  );
  link('Switch Action', 'Build Auth URL', 2);

  nodes.push(
    dataTableNode(
      'Save OAuth State',
      {
        operation: 'insert',
        table: TABLES.oauthState,
        columns: {
          state: '={{ $json.state }}',
          telegram_user_id: '={{ $json.telegramUserId }}',
          chat_id: '={{ $json.chatId }}',
          code_verifier: '={{ $json.codeVerifier }}',
          client_id: '={{ $json.clientId }}',
        },
      },
      { x: 740, y: -320 },
    ),
  );
  link('Build Auth URL', 'Save OAuth State');

  nodes.push(
    telegramNode(
      'Send Login Link',
      {
        chatId: "={{ $('Build Auth URL').item.json.chatId }}",
        text: '🔐 *Підключення акаунта «Сільпо»*\n\nНатисніть кнопку нижче та увійдіть за номером телефону.\nПісля входу поверніться сюди — я повідомлю про готовність.\n\n_Ваш токен зберігається зашифровано на сервері й ніколи не передається в Telegram._',
        // replyMarkup and inlineKeyboard are top-level parameters of the node,
        // not members of additionalFields — putting them there silently drops
        // the keyboard and sends a plain message.
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [
            {
              row: {
                buttons: [
                  { text: '🔗 Увійти в Сільпо', additionalFields: { type: 'url', url: "={{ $('Build Auth URL').item.json.authUrl }}" } },
                ],
              },
            },
          ],
        },
        additionalFields: { parse_mode: 'Markdown', appendAttribution: false },
      },
      { x: 960, y: -320 },
    ),
  );
  link('Save OAuth State', 'Send Login Link');

  /* --- optimize branch ------------------------------------------------ */
  nodes.push(
    makeNode(
      'Is Authorized?',
      'n8n-nodes-base.if',
      {
        conditions: {
          options: { caseSensitive: true, version: 2 },
          combinator: 'and',
          conditions: [{ id: 'authed', operator: { type: 'boolean', operation: 'true', singleValue: true }, leftValue: '={{ $json.authorized }}', rightValue: '' }],
        },
        options: {},
      },
      { typeVersion: 2.2, x: 520, y: 0 },
    ),
  );
  link('Switch Action', 'Is Authorized?', 0);

  nodes.push(
    telegramNode(
      'Ask To Connect',
      { chatId: '={{ $json.chatId }}', text: '👋 Спершу підключіть акаунт «Сільпо» — інакше я не побачу ваш кошик.\n\nНатисніть /connect', additionalFields: { appendAttribution: false } },
      { x: 740, y: 160 },
    ),
  );
  link('Is Authorized?', 'Ask To Connect', 1);

  nodes.push(
    telegramNode(
      'Send Progress',
      {
        chatId: '={{ $json.chatId }}',
        text: '🛒 Оптимізуємо ваш кошик...\n\n🔎 Перевіряю альтернативи\n🎁 Перевіряю акції\n🎟 Перевіряю купони\n💳 Перевіряю балабонуси',
        additionalFields: { appendAttribution: false },
      },
      { x: 740, y: -80 },
    ),
  );
  link('Is Authorized?', 'Send Progress', 0);

  nodes.push(
    codeNode(
      'Optimize Cart',
      `
${MCP_CLIENT}
${BRAND_HELPERS}
${OPTIMIZER}

const input = $('Merge Session').first().json;
const mcp = createMcp(input.session);

// Cart: always start from the active cart id, then load the full cart.
const { shoppingCartId } = await mcp.call('silpo_get_my_shopping_cart', {});
const cartResponse = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId });
const cart = cartResponse.cart;
const items = cart.shipments.flatMap(s => s.products);
if (!items.length) {
  return [{ json: { empty: true, chatId: input.chatId, telegramUserId: input.telegramUserId } }];
}
const branchId = cart.shipments[0].branchId;
const deliveryType = cart.deliveryType;

// An expired slot blocks checkout and leaves the promo calls without context.
let timeslotStart = cart.timeslot && cart.timeslot.start;
let timeslotEnd = cart.timeslot && cart.timeslot.end;
const slotExpired = !timeslotStart || new Date(timeslotStart) < new Date()
  || (cart.calculation.validations || []).some(v => v.level === 'error' && v.type === 'timeslot');
if (slotExpired) {
  const { slots } = await mcp.call('silpo_get_time_slots', { branchId, limit: 100 });
  const fresh = (slots || []).find(s => s.available && s.deliveryType === deliveryType)
    || (slots || []).find(s => s.available);
  if (fresh) { timeslotStart = fresh.start; timeslotEnd = fresh.end; }
}

// Promotions, coupons and loyalty: fetched once per run, in parallel.
const contextTasks = [
  () => mcp.call('silpo_get_promotions', { branchId, deliveryType, timeslotStart, timeslotEnd }),
  () => mcp.call('silpo_get_my_coupons', {}),
  () => mcp.call('silpo_get_promo_codes', {}),
  () => mcp.call('silpo_get_my_promos', {}),
  () => mcp.call('silpo_get_loyalty_info', {}),
];
const contextResults = await mapLimit(contextTasks, 3, f => f());
const promotions = contextResults[0].ok ? contextResults[0].value : null;
const coupons = contextResults[1].ok ? contextResults[1].value : null;

// Candidates per cart line; concurrency 3 with backoff inside the client.
const lookups = await mapLimit(items, 3, async (item) => {
  if (!item.slug) return [];
  const response = await mcp.call('silpo_get_similar_products', { branchId, deliveryType, slug: item.slug, limit: 30 });
  return response.products || [];
});

// Out-of-stock lines: one batched replacements call for all of them.
// An expired slot makes Silpo report stock 0 for every line, so cart stock is
// only trustworthy while the slot is valid — otherwise this would fan out over
// the whole cart for nothing.
const unavailable = slotExpired ? [] : items.filter(i => i.stock === 0 || i.available === false);
if (unavailable.length) {
  try {
    const replacements = await mcp.call('silpo_get_replacements', {
      branchId, deliveryType,
      companyId: unavailable[0].companyId,
      productIds: unavailable.map(i => i.productId),
    });
    if (replacements.products) {
      items.forEach((item, index) => {
        if (unavailable.some(u => u.productId === item.productId) && lookups[index].ok) {
          lookups[index].value = lookups[index].value.concat(replacements.products);
        }
      });
    }
  } catch (e) { /* replacements are optional */ }
}

// Deterministic scoring — prices come only from the MCP responses.
//
// silpo_get_similar_products reports availability that is out of date:
// observed available:true / stock:1 for a product that get_product_details and
// the cart both reported as unavailable. The details call agrees with the cart,
// so the chosen candidate is re-checked there before it is ever shown, and the
// next-best one is used when it fails.
const CONFIRM_ATTEMPTS = 4;
const MAX_OPTIONS = 3;
const blockedBrands = (input.blockedBrands || []).filter(Boolean);
// Cheap pre-filter on the name; the authoritative check is on the attribute.
const isBlockedName = name => blockedBrands.some(b => normalizeBrand(name).indexOf(normalizeBrand(b)) !== -1);

const bestResults = await mapLimit(items, 3, async (item, i) => {
  const candidates = lookups[i] && lookups[i].ok ? lookups[i].value : [];
  const ranked = candidates
    .map(raw => ({ raw, scored: scoreCandidate(item, raw, item.quantity) }))
    .filter(x => filterCandidates(item, [x.scored], item.quantity).length > 0)
    // Cheap pass first: drop obvious matches before spending a details call.
    .filter(x => !isBlockedName(x.raw.name))
    .sort((a, b) => b.scored.finalScore - a.scored.finalScore);

  const confirmedOptions = [];
  for (const candidate of ranked.slice(0, CONFIRM_ATTEMPTS)) {
    let details;
    try {
      details = await mcp.call('silpo_get_product_details', {
        branchId, deliveryType, timeslotStart, timeslotEnd, slug: candidate.raw.slug,
      });
    } catch (e) {
      continue; // cannot confirm - do not risk it
    }
    const product = details.product || {};
    if (product.available === false || (product.stock || 0) < item.quantity) continue;

    // The authoritative brand: names do not always carry it ("Простонаше" vs
    // "ПростоНаше", "Ascania" vs "Асканія"), the attribute does.
    const brand = (product.attributes || {})['Торгова марка'] || null;
    if (brand && blockedBrands.some(b => brandMatches(brand, b))) continue;

    // Details also carries the fresher price, so the saving is recomputed
    // against it rather than against the stale search result.
    const confirmedRaw = Object.assign({}, candidate.raw, {
      price: product.price != null ? product.price : candidate.raw.price,
      oldPrice: product.oldPrice != null ? product.oldPrice : candidate.raw.oldPrice,
      stock: product.stock,
      available: true,
    });
    const rescored = scoreCandidate(item, confirmedRaw, item.quantity);
    if (!filterCandidates(item, [rescored], item.quantity).length) continue;
    rescored.brand = brand;
    // Keep the runners-up: pack size only becomes visible once an item is in
    // the cart, so the apply step needs something to fall back to.
    confirmedOptions.push(rescored);
    if (confirmedOptions.length >= MAX_OPTIONS) break;
  }
  if (!confirmedOptions.length) return null;

  // A candidate flagged verifySize is one the semantic layer will refuse, so
  // leading with it costs the line its replacement entirely even when a clean
  // alternative sits right behind. Safe options first, score second; the
  // suspicious one stays available as a last-resort alternate.
  confirmedOptions.sort((a, b) =>
    (a.suspiciousDrop ? 1 : 0) - (b.suspiciousDrop ? 1 : 0) || b.finalScore - a.finalScore);

  const best = confirmedOptions[0];
  best.alternates = confirmedOptions.slice(1).map(c => ({
    productId: c.productId,
    companyId: c.companyId,
    branchId: c.branchId,
    name: c.name,
    price: c.price,
    saving: c.saving,
    brand: c.brand || null,
  }));
  return best;
});

const perItemBest = items.map((item, i) => ({
  item,
  best: bestResults[i] && bestResults[i].ok ? bestResults[i].value : null,
}));

const plan = buildPlan(items, perItemBest, cartResponse.loyalty || {});

return [{ json: {
  chatId: input.chatId,
  telegramUserId: input.telegramUserId,
  shoppingCartId, branchId, deliveryType, timeslotStart, timeslotEnd,
  cartTotal: cart.calculation.total,
  slotExpired,
  loyalty: cartResponse.loyalty || {},
  promotionsCount: ((promotions && promotions.promotions) || []).length,
  couponsCount: ((coupons && coupons.coupons) || []).length,
  refreshedTokens: mcp.getRefreshed(),
  ...plan,
} }];
`,
      { x: 960, y: -80, onError: 'continueErrorOutput' },
    ),
  );
  link('Send Progress', 'Optimize Cart');

  nodes.push(
    codeNode(
      'Build AI Prompt',
      `
// The prompt is Ukrainian on purpose: product names and the reasons shown to
// the customer are Ukrainian, so the model should reason in the same language.
const SYSTEM_PROMPT = \`Ти — асистент, який перевіряє заміни товарів у кошику супермаркету «Сільпо».

ТВОЯ ЄДИНА ЗАДАЧА: вирішити, чи зберігає запропонована заміна СУТЬ покупки.

ПРИЙМАЙ, якщо товар виконує ту саму роль:
- молоко 2.5% -> інше молоко 2.5%
- макарони -> макарони іншого бренду
- куряче філе -> куряче філе

ВІДХИЛЯЙ, якщо змінюється призначення товару:
- протеїновий/спортивний -> звичайний солодкий
- молоко -> рослинний напій (і навпаки)
- комбуча -> звичайний сік або газованка
- безлактозний/безглютеновий -> звичайний (дієтичне обмеження)
- дитяче харчування -> недитяче
- без цукру -> із цукром

ОСОБЛИВА УВАГА: дані «Сільпо» НЕ містять об'єму кандидатів. Якщо ціна падає
більш ніж на 50%, це може бути менша упаковка. Тоді confidence не вище 0.6
і згадай про перевірку об'єму в reason.

ВІДПОВІДАЙ ВИКЛЮЧНО JSON, без markdown:
{"decisions":[{"index":0,"accept":true,"confidence":0.85,"reason":"..."}]}
reason — українською, до 90 символів.\`;

const plan = $json;
const lines = (plan.replacements || []).map((r, i) =>
  '[' + i + '] було: ' + r.originalName + (r.originalRatio ? ' (' + r.originalRatio + ')' : '')
  + ' | стане: ' + r.replacementName
  + ' | падіння ціни: ' + r.savingPct + '%' + (r.verifySize ? ' ПІДОЗРІЛО ВЕЛИКЕ' : '')
  + (r.onPromotion ? ' | за акцією' : ''));

return [{ json: { ...plan,
  aiSystemPrompt: SYSTEM_PROMPT,
  aiUserPrompt: 'Перевір ці ' + lines.length + ' замін.\\n\\n' + lines.join('\\n'),
}}];
`,
      { x: 1180, y: -240 },
    ),
  );
  link('Optimize Cart', 'Build AI Prompt', 0);

  if (AI_SEMANTIC_CHECK) {
    nodes.push(
      makeNode(
        'AI Semantic Check',
        'n8n-nodes-base.httpRequest',
        {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'anthropicApi',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: $json.aiSystemPrompt,
      messages: [{ role: 'user', content: $json.aiUserPrompt }]
    }) }}`,
        options: { timeout: 30000 },
      },
        {
          typeVersion: 4.2,
          x: 1400,
          y: -240,
          credentials: { anthropicApi: { id: 'SILPO_AI', name: 'Anthropic API' } },
          onError: 'continueRegularOutput',
        },
      ),
    );
    link('Build AI Prompt', 'AI Semantic Check');
  }

  nodes.push(
    codeNode(
      'Apply AI Decisions',
      `
${OPTIMIZER}
// The model only decides accept/reject. Every total below is recomputed here,
// so a hallucinated number can never reach the customer.
const plan = $('Build AI Prompt').first().json;
const replacements = plan.replacements || [];

// Rule-based fallback for a missing key, an API error or malformed output.
function fallback(list) {
  const RED_FLAGS = [
    [/протеїн|protein|nutri|profeel/i, 'оригінал — протеїновий продукт'],
    [/безлактозн/i, 'оригінал — безлактозний'],
    [/без цукру|безглютен|без глютен/i, 'оригінал має дієтичне обмеження'],
    [/комбуч/i, 'оригінал — ферментований напій'],
    [/дитяч|milupa/i, 'оригінал — дитяче харчування'],
  ];
  return list.map((r, index) => {
    let blocker = null;
    for (const [pattern, label] of RED_FLAGS) {
      if (pattern.test(r.originalName) && !pattern.test(r.replacementName)) { blocker = label; break; }
    }
    const accept = !blocker && r.finalScore >= 0.6 && !r.verifySize;
    return { index, accept,
      confidence: accept ? Math.min(0.75, r.finalScore) : 0.3,
      reason: accept ? 'Схожий товар тієї ж категорії' + (r.onPromotion ? ', за акцією' : '')
        : (blocker || (r.verifySize ? 'Підозріло велике падіння ціни — можлива менша упаковка' : 'Недостатня схожість')),
      source: 'fallback' };
  });
}

let decisions = null;
try {
  const response = $input.first().json;
  const textPart = (response.content || []).find(c => c.type === 'text');
  if (textPart) {
    const parsed = JSON.parse(String(textPart.text).replace(/^\\\`\\\`\\\`(?:json)?|\\\`\\\`\\\`$/g, '').trim());
    const byIndex = new Map((parsed.decisions || []).map(d => [d.index, d]));
    decisions = replacements.map((r, i) => {
      const decision = byIndex.get(i);
      if (!decision) return fallback([r])[0];
      return { index: i, accept: Boolean(decision.accept),
        confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
        reason: String(decision.reason || '').slice(0, 120), source: 'ai' };
    });
  }
} catch (e) { decisions = null; }
if (!decisions) decisions = fallback(replacements);

const kept = [], rejected = [];
replacements.forEach((r, i) => {
  const decision = decisions[i];
  const enriched = { ...r, aiReason: decision.reason, aiConfidence: decision.confidence, aiSource: decision.source };
  (decision.accept && decision.confidence >= 0.5 ? kept : rejected).push(enriched);
});

const saving = round2(kept.reduce((sum, r) => sum + r.saving, 0));
const originalTotal = plan.summary.originalTotal;

const summary = { ...plan.summary,
  replacementsFound: kept.length,
  promotionsUsed: kept.filter(r => r.onPromotion).length,
  optimizedTotal: round2(originalTotal - saving),
  saving,
  savingPct: originalTotal > 0 ? round2(saving / originalTotal * 100) : 0,
};

// Only what the apply step actually needs is persisted — scores and diagnostics
// stay in memory. Keeps the stored row small and leaks less into storage.
const stored = {
  shoppingCartId: plan.shoppingCartId,
  // Indices the guest wants applied; everything is selected by default.
  selected: kept.map((r, i) => i),
  replacements: kept.map(r => ({
    originalProductId: r.originalProductId,
    originalName: r.originalName,
    originalPrice: r.originalPrice,
    quantity: r.quantity,
    replacementProductId: r.replacementProductId,
    replacementCompanyId: r.replacementCompanyId,
    replacementBranchId: r.replacementBranchId,
    replacementName: r.replacementName,
    replacementPrice: r.replacementPrice,
    alternates: r.alternates || [],
    saving: r.saving,
    savingPct: r.savingPct,
    onPromotion: r.onPromotion,
    verifySize: r.verifySize,
    aiReason: r.aiReason,
  })),
  summary: { originalTotal, saving },
};

// Telegram caps callback_data at 64 bytes, and a toggle carries plan id plus an
// index. A cartId+timestamp key ate 50 of those, so the plan gets a short key of
// its own — nothing downstream derives meaning from it.
const shortId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

return [{ json: { ...plan,
  planId: shortId,
  replacements: kept,
  rejectedByAI: rejected,
  aiSource: decisions[0] ? decisions[0].source : 'none',
  storedPlan: JSON.stringify(stored),
  summary,
}}];
`,
      { x: 1620, y: -240 },
    ),
  );
  link(AI_SEMANTIC_CHECK ? 'AI Semantic Check' : 'Build AI Prompt', 'Apply AI Decisions');

  nodes.push(
    dataTableNode(
      'Save Plan',
      {
        operation: 'insert',
        table: TABLES.plans,
        columns: {
          plan_id: '={{ $json.planId }}',
          telegram_user_id: '={{ $json.telegramUserId }}',
          cart_id: '={{ $json.shoppingCartId }}',
          plan_json: '={{ $json.storedPlan }}',
          original_total: '={{ $json.summary.originalTotal }}',
          status: 'pending',
        },
      },
      { x: 1840, y: -240 },
    ),
  );
  link('Apply AI Decisions', 'Save Plan');

  nodes.push(
    codeNode(
      'Format Recommendation',
      `
${READ_VAR}
${SELECTION_CARD}
const plan = $('Apply AI Decisions').first().json;
// Everything is selected to begin with; the guest unticks what they do not want.
const selected = (plan.replacements || []).map((r, i) => i);
const card = buildSelectionCard(plan, selected);

const body = { chat_id: plan.chatId, text: card.text, parse_mode: 'Markdown' };
if (card.keyboard.length) body.reply_markup = { inline_keyboard: card.keyboard };

return [{ json: { url: telegramApiUrl('sendMessage'), body } }];
`,
      { x: 2060, y: -240 },
    ),
  );
  link('Save Plan', 'Format Recommendation');

  // Sent through the Bot API rather than the Telegram node: the keyboard needs
  // one row per replacement, and the node's keyboard is fixed at design time.
  nodes.push(
    makeNode(
      'Send Recommendation',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 2280, y: -240 },
    ),
  );
  link('Format Recommendation', 'Send Recommendation');

  /* --- brand blocklist: /block, /unblock, /blocked --------------------- */
  nodes.push(
    codeNode(
      'Update Blocklist',
      `
${BRAND_HELPERS}
// Brands the guest never wants offered. Stored pipe-separated on their session
// row, matched case-insensitively against both the product name and the
// "Торгова марка" attribute that get_product_details returns.
const route = $('Merge Session').first().json;
const current = route.blockedBrands || [];
const brand = (route.brandArg || '').trim();
const lower = brand.toLowerCase();

let next = current.slice();
let text;

if (route.action === 'block') {
  if (!brand) {
    text = '🚫 *Не пропонувати марку*\\n\\nНапишіть команду разом із назвою марки — вона вказана під кожною заміною в картці оптимізації.\\n\\nНаприклад: \`/block\` і далі назва.';
  } else if (current.some(b => brandMatches(b, brand))) {
    text = '🚫 «' + brand + '» вже у чорному списку.';
  } else {
    next = current.concat([brand]);
    text = '🚫 «' + brand + '» додано.\\n\\n_Більше не пропонуватиму цю марку як заміну._';
  }
} else if (route.action === 'unblock') {
  if (!brand) {
    text = 'Напишіть \`/unblock\` і назву марки, яку хочете повернути.\\n\\nПоточний список — /blocked';
  } else {
    next = current.filter(b => !brandMatches(b, brand));
    text = next.length === current.length
      ? '«' + brand + '» не було у списку.'
      : '✅ «' + brand + '» прибрано з чорного списку.';
  }
} else {
  text = current.length
    ? '🚫 *Ці марки я не пропоную*\\n\\n' + current.map(b => '• ' + b).join('\\n')
      + '\\n\\n_Повернути:_ \`/unblock\` і назва марки'
    : '🚫 *Список винятків порожній*\\n\\nЯ пропоную заміни будь-яких марок.\\n\\nЩоб виключити якусь, напишіть \`/block\` і назву марки — вона вказана під кожною заміною в картці оптимізації.';
}

return [{ json: {
  chatId: route.chatId,
  telegramUserId: route.telegramUserId,
  blockedValue: next.join('|'),
  text,
}}];
`,
      { x: 520, y: 1280 },
    ),
  );
  link('Switch Action', 'Update Blocklist', 7);
  link('Switch Action', 'Update Blocklist', 8);
  link('Switch Action', 'Update Blocklist', 9);

  nodes.push(
    dataTableNode(
      'Save Blocklist',
      {
        operation: 'update',
        table: TABLES.sessions,
        filters: [{ keyName: 'telegram_user_id', keyValue: '={{ $json.telegramUserId }}' }],
        columns: { blocked_brands: '={{ $json.blockedValue }}' },
      },
      { x: 740, y: 1280 },
    ),
  );
  link('Update Blocklist', 'Save Blocklist');

  nodes.push(
    telegramNode(
      'Send Blocklist',
      {
        chatId: "={{ $('Update Blocklist').first().json.chatId }}",
        text: "={{ $('Update Blocklist').first().json.text }}",
        additionalFields: { parse_mode: 'Markdown', appendAttribution: false },
      },
      { x: 960, y: 1280 },
    ),
  );
  link('Save Blocklist', 'Send Blocklist');

  /* --- toggle branch: tick a replacement on or off --------------------- */
  nodes.push(
    dataTableNode(
      'Load Plan For Toggle',
      { operation: 'get', table: TABLES.plans, filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }] },
      { x: 520, y: 1120, alwaysOutputData: true },
    ),
  );
  link('Switch Action', 'Load Plan For Toggle', 6);

  nodes.push(
    codeNode(
      'Toggle Selection',
      `
${READ_VAR}
${SELECTION_CARD}
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

// Same ownership boundary as everywhere else a plan is touched.
if (!row || String(row.telegram_user_id) !== String(route.telegramUserId) || row.status !== 'pending') {
  return [{ json: { skip: true, url: telegramApiUrl('answerCallbackQuery'), body: {
    callback_query_id: route.callbackQueryId,
    text: 'План застарів — запустіть /optimize ще раз',
  }}}];
}

const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
plan.planId = row.plan_id;
const selected = Array.isArray(plan.selected) ? plan.selected.slice() : (plan.replacements || []).map((r, i) => i);

const index = Number(route.toggleIndex);
const at = selected.indexOf(index);
if (at === -1) selected.push(index); else selected.splice(at, 1);
selected.sort((a, b) => a - b);
plan.selected = selected;

const card = buildSelectionCard(plan, selected);
const body = {
  chat_id: route.chatId,
  message_id: route.messageId,
  text: card.text,
  parse_mode: 'Markdown',
};
if (card.keyboard.length) body.reply_markup = { inline_keyboard: card.keyboard };

return [{ json: {
  skip: false,
  planId: row.plan_id,
  planJson: JSON.stringify(plan),
  url: telegramApiUrl('editMessageText'),
  body,
}}];
`,
      { x: 740, y: 1120 },
    ),
  );
  link('Load Plan For Toggle', 'Toggle Selection');

  nodes.push(
    dataTableNode(
      'Save Selection',
      {
        operation: 'update',
        table: TABLES.plans,
        filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }],
        columns: { plan_json: '={{ $json.planJson }}' },
      },
      { x: 960, y: 1120 },
    ),
  );
  link('Toggle Selection', 'Save Selection');

  // editMessageText keeps the card in place instead of posting a new one on
  // every tick.
  nodes.push(
    makeNode(
      'Update Card',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: "={{ $('Toggle Selection').first().json.url }}",
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify($('Toggle Selection').first().json.body) }}",
        options: {},
      },
      { typeVersion: 4.2, x: 1180, y: 1120, onError: 'continueRegularOutput' },
    ),
  );
  link('Save Selection', 'Update Card');

  /* --- apply branch: the only place that writes ----------------------- */
  nodes.push(
    dataTableNode(
      'Load Plan',
      { operation: 'get', table: TABLES.plans, filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }] },
      { x: 520, y: 320, alwaysOutputData: true },
    ),
  );
  link('Switch Action', 'Load Plan', 1);

  nodes.push(
    codeNode(
      'Validate Plan',
      `
// Data Table filters only do equality, so ownership, status and age are checked
// here. Ownership is a security boundary: a leaked plan id must not be enough to
// modify somebody else's cart.
const PLAN_TTL_MINUTES = 30;
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

const reject = (text) => [{ json: { chatId: route.chatId, invalid: true, text } }];

if (!row) return reject('⏳ План не знайдено. Запустіть /optimize ще раз.');
if (String(row.telegram_user_id) !== String(route.telegramUserId)) {
  return reject('⛔ Цей план належить іншому користувачу.');
}
if (row.status === 'applying') {
  return reject('⏳ Ці зміни вже застосовуються — зачекайте кілька секунд.\\n\\nНе тисніть кнопку повторно, інакше заміни зробляться двічі.');
}
if (row.status !== 'pending') {
  return reject('✅ Цей план уже застосований або скасований.\\n\\nЗапустіть /optimize, щоб порахувати заново.');
}
const createdAt = new Date(row.createdAt || row.created_at || 0);
if (Date.now() - createdAt.getTime() > PLAN_TTL_MINUTES * 60 * 1000) {
  return reject('⏳ План застарів — ціни могли змінитися.\\n\\nЗапустіть /optimize ще раз.');
}

return [{ json: { ...row, invalid: false } }];
`,
      { x: 630, y: 320 },
    ),
  );
  link('Load Plan', 'Validate Plan');

  nodes.push(
    codeNode(
      'Apply Changes',
      `
${MCP_CLIENT}
${OPTIMIZER}

// Read the row from Validate Plan by name: Claim Plan and Send Applying sit
// between them, so $input here is a Telegram response, not the plan.
const row = $('Validate Plan').first().json;
const route = $('Merge Session').first().json;

// Validate Plan already rejected anything unowned, stale or already applied.
if (row.invalid) {
  return [{ json: { chatId: row.chatId, expired: true, text: row.text } }];
}

const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
const mcp = createMcp(route.session);

// Re-read the cart first: another session may have changed it since the analysis.
const before = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId: plan.shoppingCartId });
const beforeItems = before.cart.shipments.flatMap(s => s.products);
const beforeTotal = before.cart.calculation.total;

// Only what the guest left ticked. Missing selection means an older plan, where
// everything was implied.
const selected = Array.isArray(plan.selected)
  ? plan.selected
  : plan.replacements.map((r, i) => i);
const chosen = plan.replacements.filter((r, i) => selected.indexOf(i) !== -1);
const deselected = plan.replacements.length - chosen.length;

const applicable = chosen.filter(r =>
  beforeItems.some(i => i.productId === r.originalProductId));
const vanished = chosen.length - applicable.length;

if (!applicable.length) {
  return [{ json: { chatId: route.chatId, expired: true,
    text: '🔄 Кошик змінився з моменту аналізу — жодної із запропонованих позицій у ньому вже немає.\\n\\nЗапустіть /optimize ще раз.' }}];
}

// Pack size is invisible until an item sits in the cart, so applying is a
// retry loop rather than a single pass: add a candidate, look at what the cart
// says about it, and fall back to the next one when it disagrees.
//
// Batched by round rather than per item — one cart read serves every candidate
// tried in that round, so the whole thing costs at most MAX_ROUNDS reads no
// matter how many replacements there are.
const MAX_ROUNDS = 3;

const queue = applicable.map(replacement => {
  const original = beforeItems.find(i => i.productId === replacement.originalProductId);
  const primary = {
    productId: replacement.replacementProductId,
    companyId: replacement.replacementCompanyId,
    branchId: replacement.replacementBranchId,
    name: replacement.replacementName,
    price: replacement.replacementPrice,
    saving: replacement.saving,
  };
  return {
    replacement,
    original,
    options: [primary].concat(replacement.alternates || []),
    attempt: 0,
    settled: false,
    chosen: null,
    reason: null,
    detail: null,
  };
});

const failed = [];

for (let round = 0; round < MAX_ROUNDS; round++) {
  const active = queue.filter(q => !q.settled && q.options[q.attempt]);
  if (!active.length) break;

  // 1. add this round's candidate for every unsettled replacement
  for (const q of active) {
    const option = q.options[q.attempt];
    q.added = false;
    let lastError = null;
    for (let tries = 0; tries < 3 && !q.added; tries++) {
      if (tries > 0) await sleep(700 * tries);
      try {
        await mcp.call('silpo_add_or_update_cart_products', {
          shoppingCartId: plan.shoppingCartId,
          products: [{
            productId: option.productId,
            companyId: option.companyId,
            branchId: option.branchId,
            quantity: q.original.quantity,
            addQuantity: false,
          }],
        });
        q.added = true;
      } catch (e) {
        lastError = e;
      }
    }
    if (!q.added) {
      q.reason = 'add-failed';
      q.detail = lastError ? String(lastError.message).slice(0, 160) : 'unknown';
      q.attempt++;
    }
    await sleep(250);
  }

  // 2. one read for the whole round - this is where ratio finally appears
  const mid = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId: plan.shoppingCartId });
  const midItems = mid.cart.shipments.flatMap(s => s.products);
  const rollback = [];

  for (const q of active) {
    if (!q.added) continue;
    const option = q.options[q.attempt];
    const line = midItems.find(i => i.productId === option.productId);

    // Availability: the cart overrules the search index.
    if (line && q.original && q.original.stock > 0 && line.stock === 0) {
      q.reason = 'unavailable';
      q.detail = option.name;
      rollback.push(option.productId);
      q.attempt++;
      continue;
    }

    const originalSize = q.original ? sizeOf(q.original) : null;
    const newSize = line ? sizeOf(line) : null;
    if (originalSize && newSize && originalSize.unit === newSize.unit) {
      const factor = newSize.value / originalSize.value;
      if (factor > THRESHOLDS.maxSizeRatio || factor < THRESHOLDS.minSizeRatio) {
        q.reason = 'size';
        q.detail = { name: option.name, from: q.original.ratio, to: line.ratio };
        rollback.push(option.productId);
        q.attempt++;
        continue;
      }
    }

    q.settled = true;
    q.chosen = { option: option, ratio: line ? line.ratio : null, fallbackUsed: q.attempt > 0 };
  }

  if (rollback.length) {
    try {
      await mcp.call('silpo_remove_cart_products', {
        shoppingCartId: plan.shoppingCartId,
        products: rollback.map(id => ({ productId: id })),
      });
    } catch (e) { /* final read reports the truth */ }
  }
}

// 3. originals go only for replacements that survived every check
const confirmed = queue.filter(q => q.settled);
if (confirmed.length) {
  try {
    await mcp.call('silpo_remove_cart_products', {
      shoppingCartId: plan.shoppingCartId,
      products: confirmed.map(q => ({ productId: q.replacement.originalProductId })),
    });
  } catch (e) { /* the original stays; verification will show it */ }
}

// The attempt counter also equals how many candidates were tried and failed.
const sizeRejected = queue.filter(q => !q.settled && q.reason === 'size')
  .map(q => ({
    originalName: q.replacement.originalName,
    name: q.detail.name,
    originalRatio: q.detail.from,
    newRatio: q.detail.to,
    tried: q.attempt,
    available: q.options.length,
  }));
const stockRejected = queue.filter(q => !q.settled && q.reason === 'unavailable')
  .map(q => ({
    originalName: q.replacement.originalName,
    name: q.detail,
    tried: q.attempt,
    available: q.options.length,
  }));
for (const q of queue.filter(q => !q.settled && q.reason === 'add-failed')) {
  failed.push({ name: q.options[Math.min(q.attempt, q.options.length - 1)].name, error: q.detail });
}
const substituted = confirmed.filter(q => q.chosen.fallbackUsed)
  .map(q => ({ planned: q.replacement.replacementName, used: q.chosen.option.name }));


// Mandatory verification: the headline number must come from the cart itself.
const after = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId: plan.shoppingCartId });
const afterTotal = after.cart.calculation.total;

return [{ json: {
  chatId: route.chatId,
  planId: row.plan_id,
  applied: confirmed.length,
  deselected,
  failed,
  sizeRejected,
  stockRejected,
  substituted,
  vanished,
  beforeTotal,
  afterTotal,
  actualSaving: round2(beforeTotal - afterTotal),
  promisedSaving: plan.summary.saving,
  loyalty: after.loyalty || {},
  validations: after.cart.calculation.validations || [],
}}];
`,
      { x: 1400, y: 240, onError: 'continueErrorOutput' },
    ),
  );

  nodes.push(
    makeNode(
      'Plan Valid?',
      'n8n-nodes-base.if',
      {
        conditions: {
          options: { caseSensitive: true, version: 2 },
          combinator: 'and',
          conditions: [{ id: 'valid', operator: { type: 'boolean', operation: 'false', singleValue: true }, leftValue: '={{ $json.invalid }}', rightValue: '' }],
        },
        options: {},
      },
      { typeVersion: 2.2, x: 740, y: 320 },
    ),
  );
  link('Validate Plan', 'Plan Valid?');

  // Claim the plan BEFORE any cart write. Marking it applied only at the end
  // left a window as long as the whole run, during which a second tap passed
  // validation and applied everything twice.
  nodes.push(
    dataTableNode(
      'Claim Plan',
      {
        operation: 'update',
        table: TABLES.plans,
        filters: [{ keyName: 'plan_id', keyValue: '={{ $json.plan_id }}' }],
        columns: { status: 'applying' },
      },
      { x: 960, y: 240 },
    ),
  );
  link('Plan Valid?', 'Claim Plan', 0);

  // Immediate feedback: without it the button spins and the guest taps again.
  nodes.push(
    telegramNode(
      'Send Applying',
      {
        chatId: "={{ $('Merge Session').first().json.chatId }}",
        text: '⏳ Застосовую зміни до кошика…',
        additionalFields: { appendAttribution: false },
      },
      { x: 1180, y: 240 },
    ),
  );
  link('Claim Plan', 'Send Applying');
  link('Send Applying', 'Apply Changes');

  nodes.push(
    telegramNode(
      'Send Plan Invalid',
      { chatId: '={{ $json.chatId }}', text: '={{ $json.text }}', additionalFields: { appendAttribution: false } },
      { x: 960, y: 440 },
    ),
  );
  link('Plan Valid?', 'Send Plan Invalid', 1);


  nodes.push(
    dataTableNode(
      'Mark Plan Applied',
      {
        operation: 'update',
        table: TABLES.plans,
        filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }],
        columns: { status: 'applied' },
      },
      { x: 1620, y: 240 },
    ),
  );
  link('Apply Changes', 'Mark Plan Applied', 0);

  nodes.push(
    codeNode(
      'Format Result',
      `
${RECEIPT_WISHES}
// The headline demo metric is the actual cart total after the change.
const result = $('Apply Changes').first().json;
const money = n => Number(n).toFixed(2).replace('.', ',') + ' грн';

if (result.expired) return [{ json: { chatId: result.chatId, text: result.text } }];

let text = '🎉 *Оптимізація застосована*\\n\\n'
  + 'Було:\\n*' + money(result.beforeTotal) + '*\\n\\n'
  + 'Стало:\\n*' + money(result.afterTotal) + '*\\n\\n'
  + '💰 *ФАКТИЧНО ЗЕКОНОМЛЕНО:*\\n*' + money(result.actualSaving) + '*\\n\\n'
  + '─────────────\\n'
  + result.applied + ' замін застосовано';

if (result.failed && result.failed.length) {
  text += '\\n\\n⚠️ *Не вдалося застосувати:*';
  for (const item of result.failed) {
    text += '\\n• ' + item.name + '\\n  _' + String(item.error).slice(0, 140) + '_';
  }
}
// Availability and size can only be checked once the item is in the cart, so
// these rollbacks are reported explicitly rather than hidden.
if (result.stockRejected && result.stockRejected.length) {
  text += '\\n\\n🚫 *Не знайшов доступної заміни:*';
  for (const item of result.stockRejected) {
    text += '\\n• ' + item.originalName
      + (item.tried > 1 ? '\\n  перебрав ' + item.tried + ' варіанти — усі виявились недоступні' : '\\n  залишив оригінал');
  }
  text += '\\n\\n_У пошуку «Сільпо» вони значилися доступними, але кошик показав інше._'
    + ' _Кошик тут головніший._';
}
if (result.sizeRejected && result.sizeRejected.length) {
  text += '\\n\\n📦 *Не знайшов заміни того ж об\\'єму:*';
  for (const item of result.sizeRejected) {
    text += '\\n• ' + item.originalName + ' (' + item.originalRatio + ')'
      + '\\n  найближче було ' + item.newRatio + ' — не підійшло'
      + (item.tried > 1 ? ', перебрав ' + item.tried + ' варіанти' : '')
      + '\\n  залишив оригінал';
  }
  // The guest cannot see why this happens only now, so say it plainly.
  text += '\\n\\n_«Сільпо» не показує об\\'єм упаковки в пошуку — я бачу його лише тоді,'
    + ' коли товар уже в кошику. Тому перевіряю після додавання: менша упаковка за меншу ціну'
    + ' це не економія, адже двох таких коштуватимуть дорожче за оригінал._';
}
if (result.vanished) {
  text += '\\n↩️ ' + result.vanished + ' позицій уже не було в кошику';
}
if (result.deselected) {
  text += '\\n☐ ' + result.deselected + ' замін ви не обрали';
}
// The card showed one product; the cart proved it wrong and a runner-up went in
// instead. Saying which keeps the message honest about what was bought.
if (result.substituted && result.substituted.length) {
  text += '\\n\\n🔄 *Підставив інший товар:*';
  for (const item of result.substituted) {
    text += '\\n• замість ' + item.planned + '\\n  взяв ' + item.used;
  }
}
if (Math.abs(result.actualSaving - result.promisedSaving) > 1) {
  text += '\\n\\n_Фактична економія відрізняється від прогнозу — ціни або наявність змінилися._';
}
const bonus = result.loyalty && result.loyalty.bonusAvailable;
if (bonus > 0) {
  text += '\\n\\n💳 Балабонуси: ' + bonus + ' грн — застосуйте при оформленні.';
}
const errors = (result.validations || []).filter(v => v.level === 'error');
if (errors.length) {
  text += '\\n\\n⚠️ Кошик потребує уваги: ' + errors.map(e => e.message).join(', ');
}

// Labelled so it reads as the receipt-style closing line it is, rather than a
// stray remark. Not attributed to Silpo: these texts are ours.
text += '\\n\\n─────────────\\n🧾 *Побажання до вашого чека*\\n_'
  + pickWish(result.actualSaving, result.applied) + '_';

return [{ json: { chatId: result.chatId, text } }];
`,
      { x: 1180, y: 320 },
    ),
  );
  link('Mark Plan Applied', 'Format Result');

  nodes.push(telegramNode('Send Result', { chatId: '={{ $json.chatId }}', text: '={{ $json.text }}', additionalFields: { parse_mode: 'Markdown', appendAttribution: false } }, { x: 1400, y: 320 }));
  link('Format Result', 'Send Result');

  /* --- cancel, help, errors ------------------------------------------- */
  nodes.push(
    telegramNode(
      'Send Cancelled',
      { chatId: '={{ $json.chatId }}', text: '❌ Скасовано. Кошик не змінювався.\n\nЗапустіть /optimize, коли будете готові.', additionalFields: { appendAttribution: false } },
      { x: 520, y: 520 },
    ),
  );
  link('Switch Action', 'Send Cancelled', 3);

  nodes.push(
    telegramNode(
      'Send Help',
      {
        chatId: '={{ $json.chatId }}',
        text: '👋 Вітаю! Я допоможу зменшити вартість вашого кошика «Сільпо», не змінюючи його суті.\n\n*Основне*\n/connect — підключити акаунт Сільпо\n/cart — показати кошик\n/optimize — знайти, де можна зекономити\n\n*Якщо якусь марку не хочете бачити в замінах*\n/blocked — ваш список винятків\n/block + назва марки — не пропонувати її\n/unblock + назва марки — повернути\n\n_Назву марки я показую під кожною заміною, тож її можна просто скопіювати._\n\nЯ шукаю дешевші аналоги, акції, купони та балабонуси — і нічого не змінюю без вашого підтвердження.',
        additionalFields: { appendAttribution: false },
      },
      { x: 520, y: 660 },
    ),
  );
  link('Switch Action', 'Send Help', 10);

  nodes.push(
    dataTableNode(
      'Load Plan Details',
      { operation: 'get', table: TABLES.plans, filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }] },
      { x: 520, y: 800, alwaysOutputData: true },
    ),
  );
  link('Switch Action', 'Load Plan Details', 4);

  nodes.push(
    codeNode(
      'Format Details',
      `
// Full breakdown behind the "details" button. Ownership is re-checked here for
// the same reason as in Validate Plan: a plan id alone must not reveal another
// customer's cart.
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

if (!row || String(row.telegram_user_id) !== String(route.telegramUserId)) {
  return [{ json: { chatId: route.chatId,
    text: '⏳ План не знайдено або він застарів.\\n\\nЗапустіть /optimize ще раз.' }}];
}

const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
const money = n => Number(n).toFixed(2).replace('.', ',') + ' грн';
const replacements = plan.replacements || [];

const blocks = replacements.map((r, i) =>
  (i + 1) + '. *' + r.originalName + '*\\n'
  + '   ' + money(r.originalPrice) + (r.quantity > 1 ? ' × ' + r.quantity : '') + '\\n'
  + '   ↓\\n'
  + '   *' + r.replacementName + '*\\n'
  + '   ' + money(r.replacementPrice) + (r.onPromotion ? '  🎁 акція' : '') + '\\n'
  + '   💰 економія ' + money(r.saving) + ' (−' + r.savingPct + '%)'
  + (r.aiReason ? '\\n   💬 ' + r.aiReason : '')
  + (r.verifySize ? '\\n   ⚠️ перевірте об\\'єм упаковки' : ''));

let text = '🔍 *Деталі оптимізації*\\n\\n'
  + 'Було: ' + money(plan.summary.originalTotal) + '\\n'
  + 'Стане: ' + money(plan.summary.originalTotal - plan.summary.saving) + '\\n'
  + '💰 Економія: *' + money(plan.summary.saving) + '*\\n\\n'
  + '─────────────\\n\\n';

// Telegram caps a message at 4096 characters.
const LIMIT = 3900;
const kept = [];
for (const block of blocks) {
  if ((text + kept.join('\\n\\n') + block).length > LIMIT) break;
  kept.push(block);
}
text += kept.join('\\n\\n');
if (kept.length < blocks.length) {
  text += '\\n\\n_…і ще ' + (blocks.length - kept.length) + ' замін — не вмістилися в повідомлення._';
}

return [{ json: { chatId: route.chatId, planId: row.plan_id, text } }];
`,
      { x: 740, y: 800 },
    ),
  );
  link('Load Plan Details', 'Format Details');

  nodes.push(
    telegramNode(
      'Send Details',
      {
        chatId: '={{ $json.chatId }}',
        text: '={{ $json.text }}',
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [
            {
              row: {
                buttons: [
                  { text: '✅ Застосувати', additionalFields: { type: 'callback_data', callback_data: '=apply:{{ $json.planId }}' } },
                  { text: '❌ Скасувати', additionalFields: { type: 'callback_data', callback_data: '=cancel:{{ $json.planId }}' } },
                ],
              },
            },
          ],
        },
        additionalFields: { parse_mode: 'Markdown', appendAttribution: false },
      },
      { x: 960, y: 800 },
    ),
  );
  link('Format Details', 'Send Details');

  /* --- cart branch: read-only view of what is in the cart right now ----- */
  nodes.push(
    codeNode(
      'Read Cart',
      `
${MCP_CLIENT}

const route = $('Merge Session').first().json;
if (!route.authorized) {
  return [{ json: { chatId: route.chatId, empty: true,
    text: '👋 Спершу підключіть акаунт «Сільпо» — інакше я не побачу ваш кошик.\\n\\nНатисніть /connect' }}];
}

const mcp = createMcp(route.session);
const { shoppingCartId } = await mcp.call('silpo_get_my_shopping_cart', {});
const response = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId });
const cart = response.cart;
const items = cart.shipments.flatMap(s => s.products);
const money = n => Number(n).toFixed(2).replace('.', ',') + ' грн';

if (!items.length) {
  return [{ json: { chatId: route.chatId, empty: true,
    text: '🛒 Ваш кошик порожній.\\n\\nНаповніть його в застосунку «Сільпо» — і я перевірю, де можна зекономити.' }}];
}

// Telegram caps a message at 4096 characters.
const shown = items.slice(0, 30);
const lines = shown.map((item, i) =>
  (i + 1) + '. ' + item.name + '\\n'
  + '   ' + money(item.price) + (item.quantity > 1 ? ' × ' + item.quantity : '')
  + (item.ratio ? '  ·  ' + item.ratio : '')
  + (item.oldPrice ? '  🎁 було ' + money(item.oldPrice) : ''));

let text = '🛒 *Ваш кошик*\\n'
  + items.length + ' товарів на *' + money(cart.calculation.total) + '*\\n\\n'
  + lines.join('\\n');

if (items.length > shown.length) {
  text += '\\n\\n_…і ще ' + (items.length - shown.length) + ' позицій._';
}

const discount = cart.calculation.subDiscount;
if (discount > 0) {
  text += '\\n\\n🎁 Знижок уже враховано: ' + money(discount);
}

const loyalty = response.loyalty || {};
if (loyalty.bonusAvailable > 0) {
  text += '\\n💳 Балабонуси: ' + loyalty.bonusAvailable + ' грн';
}

// An expired slot also makes Silpo report every line as out of stock.
const slotBroken = (cart.calculation.validations || []).some(v => v.level === 'error' && v.type === 'timeslot');
if (slotBroken) {
  text += '\\n\\n⏰ _Слот доставки протух — оберіть новий у застосунку, інакше кошик не оформиться._';
}

return [{ json: { chatId: route.chatId, empty: false, text } }];
`,
      { x: 520, y: 960, onError: 'continueErrorOutput' },
    ),
  );
  link('Switch Action', 'Read Cart', 5);
  link('Read Cart', 'Handle Error', 1);

  nodes.push(
    telegramNode(
      'Send Cart',
      {
        chatId: '={{ $json.chatId }}',
        text: '={{ $json.text }}',
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [
            {
              row: {
                buttons: [{ text: '🔍 Оптимізувати кошик', additionalFields: { type: 'callback_data', callback_data: 'optimize:' } }],
              },
            },
          ],
        },
        additionalFields: { parse_mode: 'Markdown', appendAttribution: false },
      },
      { x: 740, y: 960 },
    ),
  );
  link('Read Cart', 'Send Cart', 0);

  nodes.push(
    codeNode(
      'Handle Error',
      `
// Never leak a stack trace to the customer — map failures to plain guidance.
const failure = $input.first().json;
const raw = String((failure.error && failure.error.message) || failure.message || '');
const route = $('Merge Session').first().json;

let text;
if (raw.includes('SILPO_REAUTH_REQUIRED') || raw.includes('REAUTH')) {
  text = '🔐 Доступ до акаунта «Сільпо» втратив силу.\\n\\nНатисніть /connect, щоб увійти знову.';
} else if (raw.includes('SILPO_FORBIDDEN')) {
  text = '⛔ Немає доступу до цієї операції у вашому акаунті «Сільпо».';
} else if (raw.includes('SILPO_MCP_ERROR_429')) {
  text = '⏳ Забагато запитів до «Сільпо». Зачекайте хвилину і спробуйте ще раз.';
} else if (raw.includes('SILPO_MCP_ERROR_5') || raw.includes('SILPO_EMPTY_RESPONSE')) {
  text = '🔧 Сервіс «Сільпо» тимчасово недоступний. Спробуйте за кілька хвилин.';
} else if (raw.includes('TOKEN_ENCRYPTION_KEY')) {
  text = '⚙️ Помилка конфігурації бота. Зверніться до адміністратора.';
} else if (raw.includes('TOOL_ERROR')) {
  text = '🛒 «Сільпо» не змогло виконати операцію з кошиком.\\n\\nПеревірте кошик у застосунку та спробуйте ще раз.';
} else {
  // Not a stack trace, but enough to identify the failure without digging
  // through Executions. Unknown errors are the ones worth surfacing.
  const hint = raw.replace(/\\s+/g, ' ').slice(0, 120);
  text = '😔 Щось пішло не так. Спробуйте ще раз через /optimize.'
    + (hint ? '\\n\\n_' + hint + '_' : '');
}
return [{ json: { chatId: route.chatId, text } }];
`,
      { x: 960, y: 660 },
    ),
  );
  link('Optimize Cart', 'Handle Error', 1);

  // A crashed run must not leave the plan claimed forever. 'failed' is terminal
  // on purpose: the cart may be half-changed, so the guest re-runs /optimize
  // rather than retrying a plan built against a cart that no longer exists.
  nodes.push(
    dataTableNode(
      'Release Plan',
      {
        operation: 'update',
        table: TABLES.plans,
        filters: [{ keyName: 'plan_id', keyValue: "={{ $('Merge Session').first().json.planId }}" }],
        columns: { status: 'failed' },
      },
      { x: 1400, y: 660 },
    ),
  );
  // Both fan out from the same error output: chaining them would feed Handle
  // Error the table-update result instead of the error itself.
  link('Apply Changes', 'Release Plan', 1);
  link('Apply Changes', 'Handle Error', 1);

  nodes.push(
    telegramNode(
      'Send Error',
      { chatId: '={{ $json.chatId }}', text: '={{ $json.text }}', additionalFields: { parse_mode: 'Markdown', appendAttribution: false } },
      { x: 1180, y: 660 },
    ),
  );
  link('Handle Error', 'Send Error');

  return {
    name: 'Silpo Shopping Optimizer — Telegram Bot',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: { instanceId: 'silpo-optimizer' },
    tags: [{ name: 'silpo' }],
  };
}

/* ======================================================== oauth workflow */

function buildOAuthWorkflow() {
  const nodes: N8nNode[] = [];
  const connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }> = {};

  const link = (from: string, to: string, outputIndex = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
    connections[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  };

  nodes.push(makeNode('Webhook /silpo/callback', 'n8n-nodes-base.webhook', { path: 'silpo/callback', responseMode: 'responseNode', options: {} }, { typeVersion: 2, x: 0, y: 0 }));

  nodes.push(
    dataTableNode(
      'Load OAuth State',
      { operation: 'get', table: TABLES.oauthState, filters: [{ keyName: 'state', keyValue: '={{ $json.query.state }}' }] },
      { x: 220, y: 0, alwaysOutputData: true },
    ),
  );
  link('Webhook /silpo/callback', 'Load OAuth State');

  nodes.push(
    codeNode(
      'Exchange Code',
      `
${CRYPTO_HELPERS}
const hook = $('Webhook /silpo/callback').first().json;
const row = $input.first().json;
const query = hook.query || {};

if (query.error) {
  return [{ json: { ok: false, message: 'Авторизацію скасовано: ' + query.error } }];
}
// The state is looked up in storage — this is the CSRF guard.
if (!row || !row.state || String(row.state) !== String(query.state)) {
  return [{ json: { ok: false, message: 'Посилання застаріло або вже використане. Натисніть /connect у боті ще раз.' } }];
}
// Data Table filters cannot express a time window, so the 10-minute TTL is
// enforced here against the system createdAt column.
const issuedAt = new Date(row.createdAt || 0).getTime();
if (!issuedAt || Date.now() - issuedAt > 10 * 60 * 1000) {
  return [{ json: { ok: false, message: 'Посилання дійсне 10 хвилин і вже прострочене. Натисніть /connect у боті ще раз.' } }];
}

// Must match the redirect_uri sent to /authorize, character for character.
const N8N_BASE_URL = readVar('N8N_BASE_URL') || '${DEFAULT_BASE_URL}';
const REDIRECT_URI = N8N_BASE_URL.replace(/\\/$/, '') + '/webhook/silpo/callback';

const res = await httpFetch('https://mcp.silpo.ua/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: toQuery({
    grant_type: 'authorization_code',
    code: query.code,
    redirect_uri: REDIRECT_URI,
    client_id: row.client_id,
    code_verifier: row.code_verifier,
    resource: 'https://mcp.silpo.ua/mcp',
  }),
});
if (res.status < 200 || res.status >= 300) {
  return [{ json: { ok: false, message: 'Не вдалося завершити вхід. Спробуйте /connect ще раз.' } }];
}
const token = JSON.parse(res.text);

// Tokens are encrypted before they touch the database and never logged.
return [{ json: {
  ok: true,
  telegram_user_id: row.telegram_user_id,
  chat_id: row.chat_id,
  client_id: row.client_id,
  access_token_enc: encrypt(token.access_token),
  refresh_token_enc: encrypt(token.refresh_token || ''),
  expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(),
}}];
`,
      { x: 440, y: 0 },
    ),
  );
  link('Load OAuth State', 'Exchange Code');

  nodes.push(
    makeNode(
      'Success?',
      'n8n-nodes-base.if',
      {
        conditions: {
          options: { caseSensitive: true, version: 2 },
          combinator: 'and',
          conditions: [{ id: 'ok', operator: { type: 'boolean', operation: 'true', singleValue: true }, leftValue: '={{ $json.ok }}', rightValue: '' }],
        },
        options: {},
      },
      { typeVersion: 2.2, x: 660, y: 0 },
    ),
  );
  link('Exchange Code', 'Success?');

  nodes.push(
    dataTableNode(
      'Save Session',
      {
        operation: 'upsert',
        table: TABLES.sessions,
        filters: [{ keyName: 'telegram_user_id', keyValue: '={{ $json.telegram_user_id }}' }],
        columns: {
          telegram_user_id: '={{ $json.telegram_user_id }}',
          client_id: '={{ $json.client_id }}',
          access_token_enc: '={{ $json.access_token_enc }}',
          refresh_token_enc: '={{ $json.refresh_token_enc }}',
          expires_at: '={{ $json.expires_at }}',
        },
      },
      { x: 880, y: -100 },
    ),
  );
  link('Success?', 'Save Session', 0);

  // Single-use authorization codes: drop the state as soon as it is spent.
  nodes.push(
    dataTableNode(
      'Cleanup State',
      {
        operation: 'deleteRows',
        table: TABLES.oauthState,
        filters: [{ keyName: 'state', keyValue: "={{ $('Load OAuth State').first().json.state }}" }],
      },
      { x: 1100, y: -100 },
    ),
  );
  link('Save Session', 'Cleanup State');

  nodes.push(
    telegramNode(
      'Notify Connected',
      { chatId: "={{ $('Exchange Code').first().json.chat_id }}", text: '✅ Акаунт «Сільпо» підключено!\n\nТепер натисніть /optimize — і я перевірю ваш кошик.', additionalFields: { appendAttribution: false } },
      { x: 1320, y: -100 },
    ),
  );
  link('Cleanup State', 'Notify Connected');

  nodes.push(
    makeNode(
      'Respond OK',
      'n8n-nodes-base.respondToWebhook',
      {
        respondWith: 'text',
        responseBody:
          '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:56px">✅</div><h2>Акаунт підключено</h2><p>Поверніться в Telegram.</p></div></body>',
        options: { responseCode: 200, responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } },
      },
      { typeVersion: 1.1, x: 1540, y: -100 },
    ),
  );
  link('Notify Connected', 'Respond OK');

  nodes.push(
    makeNode(
      'Respond Error',
      'n8n-nodes-base.respondToWebhook',
      {
        respondWith: 'text',
        responseBody:
          '={{ "<!doctype html><meta charset=\\"utf-8\\"><body style=\\"font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0\\"><div style=\\"text-align:center\\"><div style=\\"font-size:56px\\">⚠️</div><h2>Не вдалося підключити</h2><p>" + $json.message + "</p></div></body>" }}',
        options: { responseCode: 400, responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } },
      },
      { typeVersion: 1.1, x: 880, y: 120 },
    ),
  );
  link('Success?', 'Respond Error', 1);

  return {
    name: 'Silpo Shopping Optimizer — OAuth Callback',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: { instanceId: 'silpo-optimizer' },
    tags: [{ name: 'silpo' }],
  };
}

/* ------------------------------------------------------------------ output */

const bot = buildBotWorkflow();
const oauth = buildOAuthWorkflow();

const botJson = JSON.stringify(bot, null, 2);
const oauthJson = JSON.stringify(oauth, null, 2);
// Named .template so nobody imports the placeholder build by mistake.
writeFileSync(outFile('telegram-bot.template.json'), botJson);
writeFileSync(outFile('oauth-callback.template.json'), oauthJson);

console.log(`workflows/telegram-bot.template.json    ${bot.nodes.length} nodes (placeholders, for git)`);
console.log(`workflows/oauth-callback.template.json  ${oauth.nodes.length} nodes (placeholders, for git)`);

// The importable copy carries the real instance and table ids and never leaves
// .secrets/, so the tracked files stay identical on every machine.
if (hasDeployment) {
  const outDir = resolve(ROOT, '.secrets/workflows');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'telegram-bot.json'), personalise(botJson));
  writeFileSync(resolve(outDir, 'oauth-callback.json'), personalise(oauthJson));
  console.log(`\n>>> IMPORT THESE — built for ${deployment.baseUrl}:`);
  console.log('  .secrets/workflows/telegram-bot.json');
  console.log('  .secrets/workflows/oauth-callback.json');
} else {
  console.log('\nNo .secrets/n8n.json found, so these are placeholder builds.');
  console.log('Add your instance URL and data table ids there, then rebuild.');
}
