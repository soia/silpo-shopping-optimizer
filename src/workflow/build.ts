/**
 * Generates the importable n8n workflow JSON.
 *
 * Why a generator instead of hand-written JSON: the optimization engine is
 * inlined into the Code nodes straight from `src/lib/optimizer/` — the same
 * files the local runs and the type checker use. One source of truth, so the
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
import { UI, BUTTON } from '../lib/ui.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outFile = (name: string) => resolve(ROOT, 'workflows', name);

/**
 * Public base URL of the n8n instance, used to build the OAuth redirect URI.
 * Baked in so the workflows import and run without extra configuration; an
 * `N8N_BASE_URL` variable (Settings → Variables) overrides it when present.
 */
const DEFAULT_BASE_URL = PLACEHOLDERS.baseUrl;

/**
 * The Anthropic call is no longer a separate node, and there is no flag to turn
 * it off.
 *
 * The model is the engine now: it chooses each replacement and computes each
 * figure, so a run without it has nothing to propose. It therefore lives inside
 * the `Optimize Cart` Code node, which already has an HTTP transport, and reads
 * its key from the `ANTHROPIC_API_KEY` variable rather than a credential —
 * Code nodes cannot read credentials. A missing key fails the run with a plain
 * message instead of silently proposing nothing.
 */

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

/**
 * The decision engine, inlined into the Code node that runs it.
 *
 * `src/lib/optimizer/` replaced the hand-written scorer: the model chooses the
 * replacement and code computes every figure. The engine reaches the network
 * through an injectable fetcher, so the node calls `setFetcher(httpFetch)`
 * before using it — the sandbox has no global `fetch`.
 *
 * Listed file by file rather than through `optimizer/index.ts`, and the order
 * matters twice over:
 *
 *   - `index.ts` is a barrel of `export … from` lines. The inliner strips the
 *     leading `export `, which would leave bare `{ … } from './x.ts';` in the
 *     node — a syntax error. It is deliberately not in this list.
 *   - Concatenation flattens every module into one scope, so a module has to
 *     appear after the ones it reads at load time. Dependency order below.
 *
 * The flattening is also why nothing here may declare a top-level name the other
 * inlined helpers already use — `sleep` collided once and the node failed to
 * compile. `npm run validate` is what catches that class of mistake.
 */
const OPTIMIZER_MODULES = [
  'types.ts',
  'product-utils.ts',
  'optimization-modes.ts',
  'confidence.ts',
  'schemas.ts',
  'candidate-filter.ts',
  'prompts.ts',
  'plan-builder.ts',
  'ai-client.ts',
  'ai-selector.ts',
];

const AI_RANKER = OPTIMIZER_MODULES.map((file) => inlineModule(`src/lib/optimizer/${file}`))
  .filter(Boolean)
  .join('\n\n');

/**
 * The presentation layer, inlined the same way the engine is.
 *
 * Everything the guest reads lives in `src/lib/ui.ts`. Because that file is read
 * from disk and interpolated rather than written inside a template literal, its
 * strings are ordinary source — a newline is `\n`, an apostrophe needs no
 * escape, and the double-escaping trap that bit this generator three times does
 * not apply to copy any more.
 */
const UI_MODULE = inlineModule('src/lib/ui.ts');

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
  executeOnce?: boolean;
}

interface NodeOptions {
  x?: number;
  y?: number;
  typeVersion?: number;
  credentials?: Record<string, { id: string; name: string }>;
  onError?: string;
  alwaysOutputData?: boolean;
  /**
   * Run the node once regardless of how many items arrive.
   *
   * Data Table operations emit one item per affected row, so anything sending a
   * message downstream of a multi-row delete otherwise sends one per row.
   */
  executeOnce?: boolean;
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
      size_tolerance: 'string',
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
    ...(options.executeOnce ? { executeOnce: true } : {}),
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

/* -------------------------------------------------- shared Code-node runtime */

/**
 * Reads a value from n8n Variables (Settings → Variables, scope Global).
 *
 * `$env` is deliberately not touched: n8n Cloud defines the object but throws
 * "access to env vars denied" on any property read, so even a `typeof` guard
 * does not protect against it. Variables are the only portable channel.
 */
const READ_VAR = `
// Two sources, each in its own try/catch. n8n Cloud exposes $vars and defines
// $env but throws "access to env vars denied" on any property read, so a shared
// guard would lose the $vars value. Self-hosted Community has no Variables
// feature (it is licensed) but can set real environment variables, provided
// N8N_BLOCK_ENV_ACCESS_IN_NODE=false.
function readVar(name) {
  try {
    const v = (typeof $vars !== 'undefined' && $vars[name]) || null;
    if (v) return v;
  } catch (e) { /* Variables unavailable - fall through to env */ }
  try {
    const v = (typeof $env !== 'undefined' && $env[name]) || null;
    if (v) return v;
  } catch (e) { /* env access denied - n8n Cloud */ }
  return null;
}
`;

/**
 * Bot API endpoint builder — needs READ_VAR in the same node.
 *
 * Used wherever a message cannot go through the Telegram node: keyboards built
 * in code, message edits, and callback acknowledgements.
 */
const TELEGRAM_API = `
function telegramApiUrl(method) {
  const token = readVar('TELEGRAM_BOT_TOKEN');
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN variable is not set (Settings → Variables, scope Global)');
  }
  return 'https://api.telegram.org/bot' + token + '/' + method;
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
${UI_MODULE}
// Resolves the user's intent. No secrets and no MCP calls happen here.
const items = [];
for (const item of $input.all()) {
  const update = item.json;
  const message = update.message || (update.callback_query && update.callback_query.message);
  const from = (update.message && update.message.from) || (update.callback_query && update.callback_query.from);
  const text = ((update.message && update.message.text) || '').trim();
  const callbackData = (update.callback_query && update.callback_query.data) || '';
  // A reply to the «+ Додати марку» prompt carries a brand name and nothing
  // else — no command, no syntax for the guest to get right.
  const replyTo = (update.message && update.message.reply_to_message && update.message.reply_to_message.text) || '';
  const isBrandReply = replyTo.indexOf(BRAND_PROMPT_MARKER) === 0;

  let action = 'unknown';
  let planId = null;

  let toggleIndex = null;
  // Which replacement's runners-up, and which of them was tapped. Indices only:
  // callback_data is capped at 64 bytes, and the plan already holds the rest.
  let altIndex = null;
  let altChoice = null;
  let sizeChoice = '';
  let brandArg = null;
  let brandIndex = null;
  // Disconnecting is confirmed by a tap, so the same action arrives twice: once
  // as the command, once as logout:yes. Only the second one may clear anything.
  let logoutConfirm = false;
  let logoutCancel = false;

  if (callbackData) {
    // apply:<planId> | details:<planId> | cancel:<planId> | t:<planId>:<index>
    // | alt:<planId>[:<index>] | altpick:<planId>:<index>:<alternate>
    // | logout:yes | brx:<index> | home: | settings: | brands: | bradd: | about:
    const parts = callbackData.split(':');
    action = parts[0] === 't' ? 'toggle' : parts[0];
    planId = parts[1] || null;
    if (action === 'toggle') toggleIndex = Number(parts[2]);
    if (action === 'alt') {
      // With an index it opens that line's runners-up; without one it is the
      // «Назад» button on that screen, which redraws the card. One branch, two
      // directions - the screen it lands on is the only difference.
      action = 'alternates';
      altIndex = parts[2] === undefined || parts[2] === '' ? null : Number(parts[2]);
    }
    if (action === 'altpick') {
      action = 'altPick';
      altIndex = Number(parts[2]);
      altChoice = Number(parts[3]);
    }
    if (action === 'brx') {
      action = 'brandRemove';
      planId = null;
      brandIndex = Number(parts[1]);
    }
    if (action === 'bradd') action = 'brandAdd';
    if (action === 'brands') action = 'blocked';
    if (action === 'sizes') {
      // 'sizes:' opens the screen; 'sizes:<preset>' saves a choice.
      sizeChoice = parts[1] || '';
      action = sizeChoice ? 'sizeSet' : 'sizes';
    }
    if (action === 'logout') {
      planId = null;
      logoutConfirm = parts[1] === 'yes';
      logoutCancel = parts[1] === 'no';
    }
  } else if (isBrandReply) {
    action = 'block';
    brandArg = text;
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
  // The persistent keyboard sends its label as an ordinary message, so each of
  // the three chrome buttons is matched here as well as its command.
  else if (text.startsWith('/optimize') || text.indexOf('Оптимізувати') !== -1) action = 'optimize';
  else if (text.startsWith('/cart') || text.indexOf('Мій кошик') !== -1) action = 'cart';
  else if (text.startsWith('/settings') || text.indexOf('Налаштування') !== -1) action = 'settings';
  else if (text.startsWith('/logout') || text.startsWith('/disconnect')) action = 'logout';

  items.push({ json: {
    action,
    planId,
    toggleIndex,
    altIndex,
    altChoice,
    sizeChoice,
    brandArg,
    brandIndex,
    logoutConfirm,
    logoutCancel,
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

  /* --- callback acknowledgement --------------------------------------- */
  //
  // A tap that is never acknowledged leaves the button spinning for half a
  // minute, which reads as a hang and invites a second press — the same reflex
  // that once caused a double apply. This branch answers every callback the
  // moment it arrives, in parallel with the work it triggered.
  //
  // The screens excluded here answer their own callback because they carry a
  // toast («Ascania повернуто в пошук»), and Telegram accepts one answer per
  // query.
  nodes.push(
    codeNode(
      'Build Ack',
      `
${READ_VAR}
${TELEGRAM_API}
// These screens answer their own callback because they carry a toast, and
// Telegram accepts one answer per query.
//
// 'sizeSet' used to be on this list and no longer is. Its answer was produced by
// Update Size but *dispatched* by Send Size - at the end of a chain that goes
// through a Data Table write first - so anything failing in between left the
// button spinning for thirty seconds with no explanation, which is the exact
// behaviour working rule 11 exists to prevent. The confirmation it used to toast
// now rides on the redrawn card instead, where a failed write cannot swallow it.
const SELF_ACKING = ['home', 'settings', 'about', 'blocked', 'block', 'unblock', 'brandAdd', 'brandRemove', 'sizes'];

return $input.all()
  .filter(i => i.json.callbackQueryId && SELF_ACKING.indexOf(i.json.action) === -1)
  .map(i => ({ json: {
    url: telegramApiUrl('answerCallbackQuery'),
    body: { callback_query_id: i.json.callbackQueryId },
  }}));
`,
      { x: -380, y: 200 },
    ),
  );
  link('Route Request', 'Build Ack');

  nodes.push(
    makeNode(
      'Send Ack',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      // A failed acknowledgement must never take down the run it belongs to.
      { typeVersion: 4.2, x: -160, y: 200, onError: 'continueRegularOutput' },
    ),
  );
  link('Build Ack', 'Send Ack');

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
  // The column still holds the pack-size preset for guests who set one before
  // modes existed; the engine and the screens both fold those three names onto
  // the mode carrying the same band, so nothing has to be migrated. Anything
  // unrecognised degrades to the default, never to the boldest setting.
  const sizeTolerance = row && row.size_tolerance ? String(row.size_tolerance) : '';
  return { json: { ...r, authorized: Boolean(session), session, blockedBrands, sizeTolerance } };
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
            { conditions: stringCondition('logout'), outputKey: 'logout' },
            { conditions: stringCondition('settings'), outputKey: 'settings' },
            { conditions: stringCondition('about'), outputKey: 'about' },
            { conditions: stringCondition('brandRemove'), outputKey: 'brandRemove' },
            { conditions: stringCondition('brandAdd'), outputKey: 'brandAdd' },
            { conditions: stringCondition('home'), outputKey: 'home' },
            // Appended after 'home' on purpose: every index below is positional,
            // and inserting earlier would silently re-route existing branches.
            // Only the fallback index moves, and the validator checks it.
            { conditions: stringCondition('sizes'), outputKey: 'sizes' },
            { conditions: stringCondition('sizeSet'), outputKey: 'sizeSet' },
            { conditions: stringCondition('alternates'), outputKey: 'alternates' },
            { conditions: stringCondition('altPick'), outputKey: 'altPick' },
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
        text: UI.connectPrompt,
        // replyMarkup and inlineKeyboard are top-level parameters of the node,
        // not members of additionalFields — putting them there silently drops
        // the keyboard and sends a plain message.
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [
            {
              row: {
                buttons: [
                  { text: BUTTON.login, additionalFields: { type: 'url', url: "={{ $('Build Auth URL').item.json.authUrl }}" } },
                ],
              },
            },
          ],
        },
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
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
      {
        chatId: '={{ $json.chatId }}',
        text: UI.connectFirst,
        // A dead end with instructions is a dead end. The one thing to do next
        // is a button.
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [{ row: { buttons: [{ text: BUTTON.connect, additionalFields: { type: 'callback_data', callback_data: 'connect:' } }] } }],
        },
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      { x: 740, y: 160 },
    ),
  );
  link('Is Authorized?', 'Ask To Connect', 1);

  // The progress line carries the persistent keyboard.
  //
  // Telegram allows one reply_markup per message, so the always-visible chrome
  // cannot ride on a screen that already has inline buttons. This message needs
  // no buttons of its own and every guest passes through it on their first
  // /optimize, which makes it the natural place to install the keyboard. Sent
  // through the Bot API rather than the Telegram node so the markup is literal
  // JSON — a mistyped node parameter would drop the keyboard silently.
  nodes.push(
    codeNode(
      'Build Progress',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
const route = $('Merge Session').first().json;
return [{ json: { url: telegramApiUrl('sendMessage'),
  body: message(route.chatId, UI.analysing, { reply_markup: homeKeyboard() }) }}];
`,
      { x: 740, y: -80 },
    ),
  );
  link('Is Authorized?', 'Build Progress', 0);

  nodes.push(
    makeNode(
      'Send Progress',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 960, y: -80 },
    ),
  );
  link('Build Progress', 'Send Progress');

  nodes.push(
    codeNode(
      'Optimize Cart',
      `
${MCP_CLIENT}
${READ_VAR}
${BRAND_HELPERS}
${AI_RANKER}

const input = $('Merge Session').first().json;
const mcp = createMcp(input.session);

// The engine is the model. There is no rule-based fallback to degrade into, so
// a missing key fails the run here rather than silently proposing nothing.
const API_KEY = readVar('ANTHROPIC_API_KEY');
if (!API_KEY) {
  throw new Error('ANTHROPIC_API_KEY variable is not set (Settings → Variables, scope Global)');
}
// The sandbox has no global fetch; hand the engine the transport that works.
setFetcher(httpFetch);

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

// The model chooses. Prices still come only from MCP responses; the model reads
// them and computes the savings.
//
// silpo_get_similar_products reports availability that is out of date:
// observed available:true / stock:1 for a product that get_product_details and
// the cart both reported as unavailable. The details call agrees with the cart,
// so each chosen candidate is re-checked there, and a candidate that fails is
// removed from the pool before the model is asked again.
// Two phases, each at the concurrency its own limit allows.
//
// The first version interleaved them and asked the model again for every
// runner-up: 3-4 model calls per line, ~50 per cart, and n8n killed the node
// with "Task execution timed out after 60 seconds". One call now returns a
// ranked shortlist, and the two services are no longer throttled together —
// working rule 15 caps Silpo at 3, it says nothing about Anthropic.
const MODEL_CONCURRENCY = 6;
const SILPO_CONCURRENCY = 3;
const MAX_OPTIONS = 3;
const blockedBrands = (input.blockedBrands || []).filter(Boolean);
// Cheap pre-filter on the name; the authoritative check is on the attribute.
const isBlockedName = name => blockedBrands.some(b => normalizeBrand(name).indexOf(normalizeBrand(b)) !== -1);

// Phase 1 - the deterministic gate, then the model, one call per line.
//
// filterCandidates removes only what the API states as fact: a price quoted on
// another basis (weighted against packaged), a pack outside the guest's band, a
// grade that differs, a candidate that is worse per unit despite a lower ticket
// price. What a product is *for* stays the model's judgement - the gate makes
// its pool shorter and honest, it does not make its decision.
const band = sizeBand(input.sizeTolerance);
const gateTally = {};
const pools = items.map((item, i) => {
  const candidates = lookups[i] && lookups[i].ok ? lookups[i].value : [];
  const result = filterCandidates(item, candidates.filter(c => !isBlockedName(c.name)), band);
  for (const reason of Object.keys(result.rejected)) {
    gateTally[reason] = (gateTally[reason] || 0) + result.rejected[reason];
  }
  return result.kept;
});

const picks = await mapLimit(items, MODEL_CONCURRENCY, async (item, i) => {
  if (!pools[i].length) return null;
  return await selectReplacement(item, pools[i], API_KEY, input.sizeTolerance);
});

// Phase 2 - Silpo confirms availability, price and brand.
//
// silpo_get_similar_products reports availability that is out of date: observed
// available:true / stock:1 for a product that get_product_details and the cart
// both reported as unavailable. Details agrees with the cart, so every candidate
// is re-checked there before it can be shown.
const bestResults = await mapLimit(items, SILPO_CONCURRENCY, async (item, i) => {
  const selection = picks[i] && picks[i].ok ? picks[i].value : null;
  if (!selection || selection.chosen == null) return null;

  // Each option carries the verdict the model wrote about it. A runner-up is a
  // product in its own right, not a consolation prize, and the guest will be
  // looking at it in their cart.
  const order = [{ index: selection.chosen, reason: selection.reason, confidence: selection.confidence }]
    .concat(selection.alternates || []);
  const confirmed = [];
  for (const option of order) {
    const idx = option.index;
    if (confirmed.length >= MAX_OPTIONS) break;
    const candidate = pools[i][idx];
    if (!candidate) continue;

    let details;
    try {
      details = await mcp.call('silpo_get_product_details', {
        branchId, deliveryType, timeslotStart, timeslotEnd, slug: candidate.slug,
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

    const confirmedCandidate = Object.assign({}, candidate, {
      price: product.price != null ? product.price : candidate.price,
      oldPrice: product.oldPrice != null ? product.oldPrice : candidate.oldPrice,
      stock: product.stock,
      available: true,
      brand,
    });
    // The gate again, on the confirmed price. get_product_details overrides the
    // search price, and a candidate that only cleared the floor at its stale
    // price must not slip through on the strength of the model having liked it.
    if (rejectReason(item, confirmedCandidate, band)) continue;

    // Computed here, from the price details just confirmed - not from the search
    // result and not by the model.
    const numbers = computeSaving(item, confirmedCandidate);
    confirmed.push({
      candidate: confirmedCandidate,
      saving: numbers.saving,
      savingPct: numbers.savingPct,
      reason: option.reason,
      confidence: option.confidence,
    });
  }
  if (!confirmed.length) return null;

  // The model's own verdict travels with whichever candidate is actually used,
  // so a promoted runner-up inherits neither the top pick's saving nor its
  // words. It used to inherit a placeholder instead - «Запасний варіант,
  // основний виявився недоступним» - plus a confidence floored at 0.6, which
  // left a perfectly good kefir unticked and unexplained. Both were code
  // inventing a judgement; now the model makes it, per option, in the one call.
  const best = confirmed[0];
  const enrichedSelection = Object.assign({}, selection, {
    reason: best.reason,
    confidence: best.confidence,
  });
  // The runner-up now has two readers: apply-time fallback, which takes whatever
  // is next in the list, and the guest, who can pick one by hand off the «Інші
  // варіанти» screen. The second reader is why the model's verdict travels with
  // it - a candidate the guest chooses must be able to say why it is here, in
  // words written about itself.
  best.candidate.alternates = confirmed.slice(1).map(o => ({
    productId: o.candidate.id,
    companyId: o.candidate.companyId,
    branchId: o.candidate.branchId,
    name: o.candidate.name,
    // Carried so a promoted runner-up is still a link when the result message
    // names it. Navigational only - nothing decides anything from it.
    slug: o.candidate.slug || null,
    price: o.candidate.price,
    saving: o.saving,
    brand: o.candidate.brand || null,
    reason: o.reason,
    // Both bars resolved here, where the mode is known. The card is redrawn from
    // a stored row that has no idea which mode produced it, and the alternatives
    // screen is drawn from the same row.
    confident: o.confidence >= confidentAt(input.sizeTolerance),
    // Working rule 3d: below minConfidence a candidate is not offered at all.
    // It stays in the array - apply-time fallback may still need it when the
    // cart contradicts everything above it - but no button is drawn for it.
    offerable: o.confidence >= minConfidence(input.sizeTolerance),
  }));
  return { candidate: best.candidate, selection: enrichedSelection };
});

const selected = items.map((item, i) => {
  const r = bestResults[i] && bestResults[i].ok ? bestResults[i].value : null;
  return { item, candidate: r ? r.candidate : null, selection: r ? r.selection : null };
});

// subDiscount is what Silpo has already taken off this cart. It travels into
// the plan to be *stated* beside the saving, never added to it: the promotion
// is already inside every line's price.
const plan = buildPlan(items, selected, {
  loyalty: cartResponse.loyalty || {},
  cartDiscount: cart.calculation.subDiscount,
  couponsAvailable: ((coupons && coupons.coupons) || []).length,
  mode: input.sizeTolerance,
});

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
  // One value, two readers: the engine resolves it to a band and two confidence
  // bars, the card prints its name. resolveMode folds the legacy pack-size
  // presets, so an old session row needs no migration.
  sizeTolerance: input.sizeTolerance,
  mode: input.sizeTolerance,
  ...plan,
} }];
`,
      { x: 960, y: -80, onError: 'continueErrorOutput' },
    ),
  );
  link('Send Progress', 'Optimize Cart');

  // An empty cart has no plan to build: the AI call has nothing to judge and
  // `plan.summary` does not exist, so the downstream nodes used to throw and the
  // progress message stayed on screen as the last thing the guest saw.
  nodes.push(
    makeNode(
      'Cart Is Empty?',
      'n8n-nodes-base.if',
      {
        conditions: {
          options: { caseSensitive: true, version: 2 },
          combinator: 'and',
          conditions: [{ id: 'empty', operator: { type: 'boolean', operation: 'true', singleValue: true }, leftValue: '={{ $json.empty === true }}', rightValue: '' }],
        },
        options: {},
      },
      { typeVersion: 2.2, x: 1180, y: -80 },
    ),
  );
  link('Optimize Cart', 'Cart Is Empty?', 0);

  nodes.push(
    telegramNode(
      'Send Empty Cart',
      {
        chatId: '={{ $json.chatId }}',
        text: UI.cartEmptyForOptimize,
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      { x: 1400, y: 60 },
    ),
  );
  link('Cart Is Empty?', 'Send Empty Cart', 0);

  nodes.push(
    codeNode(
      'Finalize Plan',
      `
${UI_MODULE}
// Every decision and every figure was produced by the model in Optimize Cart.
// This node only gives the plan an id and trims it down to what the apply step
// will need, so nothing extra is persisted.
const plan = $json;
const kept = plan.replacements || [];
const rejected = plan.rejectedByAI || [];
const summary = plan.summary;

// Only what the apply step actually needs is persisted — reasons and
// diagnostics stay in memory. Keeps the stored row small and leaks less.
const stored = {
  shoppingCartId: plan.shoppingCartId,
  // The mode this plan was judged in. Read back at apply time so changing the
  // setting mid-flight cannot silently re-judge a plan the guest already saw,
  // and printed on the card every time it is redrawn.
  sizeTolerance: plan.sizeTolerance,
  mode: plan.mode,
  // Indices the guest wants applied. Only what cleared the confidence bar is
  // ticked to begin with - defaultSelection decides, and the card renders the
  // same array, so the screen and the row can never disagree about what a tap
  // on Apply would do.
  selected: defaultSelection(kept),
  replacements: kept.map(r => ({
    originalProductId: r.originalProductId,
    originalName: r.originalName,
    // Both slugs are persisted because the card is redrawn from this row on
    // every toggle: without them the names stop being links after the first tap.
    originalSlug: r.originalSlug,
    originalPrice: r.originalPrice,
    quantity: r.quantity,
    replacementProductId: r.replacementProductId,
    replacementCompanyId: r.replacementCompanyId,
    replacementBranchId: r.replacementBranchId,
    replacementName: r.replacementName,
    replacementSlug: r.replacementSlug,
    replacementPrice: r.replacementPrice,
    alternates: r.alternates || [],
    saving: r.saving,
    savingPct: r.savingPct,
    onPromotion: r.onPromotion,
    verifySize: r.verifySize,
    aiReason: r.aiReason,
    // Persisted because the card is redrawn from this row on every toggle: a
    // dropped flag would silently re-tick the cautious lines on the first tap.
    confident: r.confident,
  })),
  // bonusAvailable is stored because the card is re-rendered on every tick, and
  // without it the bonus note vanished after the guest's first tap.
  summary: {
    originalTotal: summary.originalTotal,
    saving: summary.saving,
    itemsAnalyzed: summary.itemsAnalyzed,
    bonusAvailable: summary.bonusAvailable,
    cartDiscount: summary.cartDiscount,
    couponsAvailable: summary.couponsAvailable,
  },
};

// Telegram caps callback_data at 64 bytes, and a toggle carries plan id plus an
// index. A cartId+timestamp key ate 50 of those, so the plan gets a short key of
// its own — nothing downstream derives meaning from it.
const shortId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

return [{ json: { ...plan,
  planId: shortId,
  replacements: kept,
  rejectedByAI: rejected,
  aiSource: 'ai',
  storedPlan: JSON.stringify(stored),
  summary,
}}];
`,
      { x: 1180, y: -240 },
    ),
  );
  link('Cart Is Empty?', 'Finalize Plan', 1);

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
  link('Finalize Plan', 'Save Plan');

  nodes.push(
    codeNode(
      'Format Recommendation',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
const plan = $('Finalize Plan').first().json;
// The very array that was persisted, not a second opinion about it: Finalize
// Plan already decided which lines are ticked, and recomputing it here is how
// the screen and the stored row drift apart.
const stored = JSON.parse(plan.storedPlan);
const card = buildSelectionCard(plan, stored.selected || []);

const body = message(plan.chatId, card.text);
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

  /* --- brand preferences: the Brands screen and its mutations ---------- */
  //
  // One screen, four ways in: the ✕ on a row, the «+ Додати марку» prompt, and
  // the /block and /unblock commands kept as fallbacks. Every one of them ends
  // on the same rendered list, so there is no separate "confirmation message"
  // state to design or to dismiss.
  nodes.push(
    codeNode(
      'Update Blocklist',
      `
${BRAND_HELPERS}
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
// Brands the guest never wants offered. Stored pipe-separated on their session
// row, matched case-insensitively against both the product name and the
// "Торгова марка" attribute that get_product_details returns.
const route = $('Merge Session').first().json;
const current = route.blockedBrands || [];
const brand = (route.brandArg || '').trim();
const ctx = { chatId: route.chatId, messageId: route.messageId, callbackQueryId: route.callbackQueryId };

let next = current.slice();
let toast = null;
let notice = null;
let requests;

if (route.action === 'brandAdd' || (route.action === 'block' && !brand) || (route.action === 'unblock' && !brand)) {
  // Nothing to save — ask for the name and let the reply come back as a block.
  requests = brandPromptRequest(ctx);
} else {
  if (route.action === 'block') {
    if (current.some(b => brandMatches(b, brand))) {
      toast = brandToast('duplicate', brand);
    } else {
      next = current.concat([brand]);
      toast = brandToast('added', brand);
    }
  } else if (route.action === 'unblock') {
    next = current.filter(b => !brandMatches(b, brand));
    if (next.length !== current.length) toast = brandToast('removed', brand);
  } else if (route.action === 'brandRemove') {
    // The ✕ carries the row index rather than the name: a brand can be longer
    // than the 64 bytes callback_data allows.
    const removed = current[Number(route.brandIndex)];
    if (removed) {
      next = current.filter((b, i) => i !== Number(route.brandIndex));
      toast = brandToast('removed', removed);
    }
  }
  // A command has no callback to toast into, so the same words go on the screen.
  if (toast && !route.callbackQueryId) notice = toast;
  requests = screenRequests(buildBrandsCard(next, notice), ctx, toast);
}

return requests.map(r => ({ json: {
  chatId: route.chatId,
  telegramUserId: route.telegramUserId,
  blockedValue: next.join('|'),
  url: telegramApiUrl(r.method),
  body: r.body,
}}));
`,
      { x: 520, y: 1280 },
    ),
  );
  // block, unblock, brandRemove, brandAdd. Reading the list is not a mutation
  // and goes to Show Brands instead — routing 'blocked' here as well would draw
  // the screen twice.
  link('Switch Action', 'Update Blocklist', 7);
  link('Switch Action', 'Update Blocklist', 8);
  link('Switch Action', 'Update Blocklist', 13);
  link('Switch Action', 'Update Blocklist', 14);

  /* --- pack-size tolerance ------------------------------------------- */

  nodes.push(
    codeNode(
      'Update Size',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
const route = $('Merge Session').first().json;
// Only a key the screen itself offers may be written. A tap carries whatever
// the keyboard put in it, and the column is read back into the engine.
const allowed = MODE_OPTIONS.map(o => o.key);
const choice = allowed.indexOf(String(route.sizeChoice || '')) !== -1 ? route.sizeChoice : 'balanced';

// Nothing is drawn here any more. The screen is built after the write, from the
// row the table hands back - see Confirm Size.
return [{ json: {
  telegramUserId: route.telegramUserId,
  chatId: route.chatId,
  messageId: route.messageId,
  callbackQueryId: route.callbackQueryId,
  sizeValue: choice,
}}];
`,
      { x: 520, y: 1420 },
    ),
  );
  link('Switch Action', 'Update Size', 17);

  nodes.push(
    dataTableNode(
      'Save Size',
      {
        operation: 'update',
        table: TABLES.sessions,
        // $json because this node's input *is* Update Size's output, so the id
        // is on the item in front of it. That is the whole test - not a
        // preference. Where the input is something else, name the node instead
        // (Clear Session, below).
        filters: [{ keyName: 'telegram_user_id', keyValue: '={{ $json.telegramUserId }}' }],
        columns: { size_tolerance: '={{ $json.sizeValue }}' },
      },
      // No onError here, and that is the fix rather than an omission.
      //
      // The Data Table node catches its own exceptions whenever continueOnFail()
      // is true - and that is true for BOTH continueRegularOutput and
      // continueErrorOutput. Its router then pushes the node's own *input* item
      // into the regular output, attaching the error only when it is a
      // NodeApiError or a NodeOperationError. A table error is neither, so
      // wiring an error output here did not surface the failure: it buried it,
      // and the branch carried on drawing a screen from an item that had never
      // been near the table. The error output could never fire.
      //
      // continueRegularOutput is therefore not error handling here - it is the
      // only way to keep the branch alive past a failed write, and what it
      // yields is the input item, which Confirm Size recognises as "the table
      // was never touched". Left to throw instead, the whole branch dies and the
      // guest gets no answer at all; the message is only in the execution log
      // either way, because this node never attaches it to the item.
      //
      // executeOnce is gone with the screen-building that used to happen in
      // Update Size: that node emits exactly one item now, so there is nothing
      // left to run twice.
      { x: 740, y: 1420, alwaysOutputData: true, onError: 'continueRegularOutput' },
    ),
  );
  link('Update Size', 'Save Size');

  nodes.push(
    codeNode(
      'Confirm Size',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
const tap = $('Update Size').first().json;
// The Data Table update returns the rows it actually changed - not a count, the
// rows themselves - so the state after the write needs no second read. An update
// that matched nothing returns none of them, and alwaysOutputData turns that
// into one empty item, which is exactly the case worth telling the guest about.
const row = $input.all().map(i => i.json).find(r => r && r.telegram_user_id !== undefined);
// null is what modeNotice reads as "the table does not have it" - and a row that
// came back without the column reads the same way, because as far as the engine
// is concerned the setting is not stored either way.
const stored = row ? row.size_tolerance : null;

const ctx = { chatId: tap.chatId, messageId: tap.messageId, callbackQueryId: tap.callbackQueryId };
// Drawn from the stored value, so the radio can never mark a mode the engine
// will not use. The tap only decides what the notice compares against.
const requests = screenRequests(buildModeCard(stored, modeNotice(stored, tap.sizeValue)), ctx)
  // This branch does not answer its own callback - Build Ack does, the moment
  // the tap arrives, so no failure downstream can leave the button spinning.
  .filter(r => r.method !== 'answerCallbackQuery');

return requests.map(r => ({ json: { url: telegramApiUrl(r.method), body: r.body } }));
`,
      { x: 960, y: 1420 },
    ),
  );
  link('Save Size', 'Confirm Size');

  nodes.push(
    makeNode(
      'Send Size',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 1400, y: 1420 },
    ),
  );
  link('Confirm Size', 'Send Size');

  nodes.push(
    dataTableNode(
      'Save Blocklist',
      {
        operation: 'update',
        table: TABLES.sessions,
        // Same test as Save Size: this node's input is Update Blocklist's output.
        filters: [{ keyName: 'telegram_user_id', keyValue: '={{ $json.telegramUserId }}' }],
        columns: { blocked_brands: '={{ $json.blockedValue }}' },
      },
      // Same trap as the logout branch: a guest who never connected has no
      // session row, so the update touches nothing and the reply would be lost.
      // executeOnce because the screen is two API calls (ack, then draw) and the
      // list must be written once, not once per call.
      { x: 740, y: 1280, alwaysOutputData: true, executeOnce: true },
    ),
  );
  link('Update Blocklist', 'Save Blocklist');

  // Save Blocklist runs once and emits one item; the screen is two API calls.
  // This restores them after the write, so the list is persisted before it is
  // drawn and the guest can never see a state that was not saved.
  nodes.push(
    codeNode(
      'Brand Screen Requests',
      `
return $('Update Blocklist').all().map(i => ({ json: { url: i.json.url, body: i.json.body } }));
`,
      { x: 960, y: 1280 },
    ),
  );
  link('Save Blocklist', 'Brand Screen Requests');

  nodes.push(
    makeNode(
      'Send Blocklist',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 1180, y: 1280 },
    ),
  );
  link('Brand Screen Requests', 'Send Blocklist');

  /* --- logout branch: disconnect the Silpo account --------------------- */
  nodes.push(
    codeNode(
      'Prepare Logout',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
// Two steps on purpose: /logout only asks, the button clears. Both replies are
// built here so the branch needs a single outgoing call before the tables are
// touched.
//
// Confirming edits the prompt instead of sending a new message: that removes the
// keyboard, so the tap cannot be repeated while the deletion runs.
const route = $('Merge Session').first().json;
const base = { chatId: route.chatId, telegramUserId: route.telegramUserId };

if (route.logoutCancel) {
  return [{ json: { ...base, confirmed: false, url: telegramApiUrl('editMessageText'), body: {
    ...message(route.chatId, UI.logoutCancelled, { message_id: route.messageId }),
  }}}];
}

if (!route.authorized) {
  return [{ json: { ...base, confirmed: false, url: telegramApiUrl('sendMessage'), body: {
    ...message(route.chatId, UI.logoutNotConnected),
  }}}];
}

if (route.logoutConfirm) {
  return [{ json: { ...base, confirmed: true, url: telegramApiUrl('editMessageText'), body: {
    ...message(route.chatId, UI.logoutWorking, { message_id: route.messageId }),
  }}}];
}

return [{ json: { ...base, confirmed: false, url: telegramApiUrl('sendMessage'), body: {
  ...message(route.chatId, UI.logoutPrompt, { reply_markup: { inline_keyboard: logoutKeyboard() } }),
}}}];
`,
      { x: 520, y: 1440 },
    ),
  );
  link('Switch Action', 'Prepare Logout', 10);

  nodes.push(
    makeNode(
      'Send Logout Reply',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 740, y: 1440, onError: 'continueRegularOutput' },
    ),
  );
  link('Prepare Logout', 'Send Logout Reply');

  nodes.push(
    makeNode(
      'Logout Confirmed?',
      'n8n-nodes-base.if',
      {
        conditions: {
          options: { caseSensitive: true, version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'confirmed',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
            leftValue: "={{ $('Prepare Logout').first().json.confirmed }}",
            rightValue: '',
          }],
        },
        options: {},
      },
      { typeVersion: 2.2, x: 960, y: 1440 },
    ),
  );
  link('Send Logout Reply', 'Logout Confirmed?');

  // The row survives with its blocklist; only the credentials are wiped. Keeping
  // it also keeps `Save Blocklist` working, which updates an existing row.
  nodes.push(
    dataTableNode(
      'Clear Session',
      {
        operation: 'update',
        table: TABLES.sessions,
        // Named rather than $json, and this is the exception that proves the
        // rule: this node's input is not Prepare Logout's item, it is the
        // Telegram API response from Send Logout Reply. $json.telegramUserId is
        // undefined there, the filter matches no row, and the Data Table node
        // calls that a success - logout then confirmed itself while leaving the
        // tokens in place. The IF node beside it reads the same node for the
        // same reason.
        filters: [{ keyName: 'telegram_user_id', keyValue: "={{ $('Prepare Logout').first().json.telegramUserId }}" }],
        columns: { access_token_enc: '', refresh_token_enc: '', client_id: '', expires_at: '' },
      },
      // Row-returning writes emit one item per affected row and nothing at all
      // when they affect none, which would silently strand the rest of the
      // branch. alwaysOutputData keeps one empty item flowing.
      { x: 1180, y: 1440, alwaysOutputData: true },
    ),
  );
  link('Logout Confirmed?', 'Clear Session', 0);

  // Plans outlive the session they were built from, and `Validate Plan` only
  // checks that the tapper owns the plan. Without this, a plan computed for the
  // previous account would still be applicable against the next one's cart.
  nodes.push(
    dataTableNode(
      'Delete Plans',
      {
        operation: 'deleteRows',
        table: TABLES.plans,
        filters: [{ keyName: 'telegram_user_id', keyValue: "={{ $('Prepare Logout').first().json.telegramUserId }}" }],
      },
      // A guest with no stored plans deletes nothing, so without this the
      // confirmation never reaches them — which is exactly what happened.
      { x: 1400, y: 1440, alwaysOutputData: true },
    ),
  );
  link('Clear Session', 'Delete Plans');

  nodes.push(
    telegramNode(
      'Send Logged Out',
      {
        chatId: "={{ $('Prepare Logout').first().json.chatId }}",
        text: UI.logoutDone,
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      // Delete Plans emits one item per deleted row; without this the guest gets
      // one confirmation per plan they had stored.
      { x: 1620, y: 1440, executeOnce: true },
    ),
  );
  link('Delete Plans', 'Send Logged Out');

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
${TELEGRAM_API}
${UI_MODULE}
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

// Same ownership boundary as everywhere else a plan is touched.
if (!row || String(row.telegram_user_id) !== String(route.telegramUserId) || row.status !== 'pending') {
  return [{ json: { skip: true, url: telegramApiUrl('answerCallbackQuery'), body: {
    callback_query_id: route.callbackQueryId,
    text: UI.planGone,
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
const body = message(route.chatId, card.text, { message_id: route.messageId });
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

  /* --- alternatives branch: switch one line to a runner-up ------------- */
  //
  // Nothing here searches, judges or recomputes anything the run did not already
  // confirm. Both screens are drawn from the stored plan, and the pick is a swap
  // inside it: `applyAlternate` puts the chosen product in the primary slot and
  // the previous primary at the head of `alternates`, so the guest can change
  // their mind again for one more tap and apply keeps a fallback that already
  // cleared every check.
  nodes.push(
    dataTableNode(
      'Load Plan For Alternates',
      { operation: 'get', table: TABLES.plans, filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }] },
      { x: 520, y: 1600, alwaysOutputData: true },
    ),
  );
  link('Switch Action', 'Load Plan For Alternates', 18);

  nodes.push(
    codeNode(
      'Show Alternatives',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

// Same ownership boundary as every other branch that touches a plan.
if (!row || String(row.telegram_user_id) !== String(route.telegramUserId) || row.status !== 'pending') {
  return [{ json: { url: telegramApiUrl('answerCallbackQuery'), body: {
    callback_query_id: route.callbackQueryId,
    text: UI.planGone,
  }}}];
}

const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
plan.planId = row.plan_id;
const selected = Array.isArray(plan.selected) ? plan.selected : (plan.replacements || []).map((r, i) => i);

// «Інші варіанти» carries the line index; «Назад» carries none and redraws the
// card the guest came from - same message, same ticks, nothing re-run.
const card = route.altIndex == null
  ? buildSelectionCard(plan, selected)
  : buildAlternativesCard(plan, Number(route.altIndex));

const body = message(route.chatId, card.text, { message_id: route.messageId });
if (card.keyboard.length) body.reply_markup = { inline_keyboard: card.keyboard };

return [{ json: { url: telegramApiUrl('editMessageText'), body }}];
`,
      { x: 740, y: 1600 },
    ),
  );
  link('Load Plan For Alternates', 'Show Alternatives');

  // Edited in place, like the toggle: opening and closing a list of runners-up
  // must not leave a trail of dead menus in the chat.
  nodes.push(
    makeNode(
      'Show Alt Screen',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: "={{ $('Show Alternatives').first().json.url }}",
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify($('Show Alternatives').first().json.body) }}",
        options: {},
      },
      { typeVersion: 4.2, x: 960, y: 1600, onError: 'continueRegularOutput' },
    ),
  );
  link('Show Alternatives', 'Show Alt Screen');

  nodes.push(
    dataTableNode(
      'Load Plan For Pick',
      { operation: 'get', table: TABLES.plans, filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }] },
      { x: 520, y: 1760, alwaysOutputData: true },
    ),
  );
  link('Switch Action', 'Load Plan For Pick', 19);

  nodes.push(
    codeNode(
      'Pick Alternate',
      `
${READ_VAR}
${AI_RANKER}
${TELEGRAM_API}
${UI_MODULE}
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

if (!row || String(row.telegram_user_id) !== String(route.telegramUserId) || row.status !== 'pending') {
  return [{ json: { skip: true, url: telegramApiUrl('answerCallbackQuery'), body: {
    callback_query_id: route.callbackQueryId,
    text: UI.planGone,
  }}}];
}

const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
plan.planId = row.plan_id;
const index = Number(route.altIndex);
const selected = Array.isArray(plan.selected) ? plan.selected : (plan.replacements || []).map((r, i) => i);

// The swap and every figure it changes. The ticks are not touched: a guest who
// had this line on keeps it on, and one who had it off keeps it off - they chose
// a product, not whether to buy it.
const result = applyAlternate(plan, index, Number(route.altChoice));

// A tap that arrives at nothing is a keyboard from before a redraw. The guest
// stays on the list they were looking at, with a line saying what happened,
// rather than being bounced to a screen they did not ask for.
const card = result.ok
  ? buildSelectionCard(plan, selected)
  : buildAlternativesCard(plan, index,
      result.reason === 'no-saving' ? UI.alternateNoSaving : UI.alternateGone);

const body = message(route.chatId, card.text, { message_id: route.messageId });
if (card.keyboard.length) body.reply_markup = { inline_keyboard: card.keyboard };

return [{ json: {
  skip: false,
  planId: row.plan_id,
  // Written back on the failed path too, and deliberately: applyAlternate leaves
  // the plan untouched when it refuses, so this stores the same bytes it read.
  planJson: JSON.stringify(plan),
  url: telegramApiUrl('editMessageText'),
  body,
}}];
`,
      { x: 740, y: 1760 },
    ),
  );
  link('Load Plan For Pick', 'Pick Alternate');

  // The card, the stored row and the apply step have to agree about which
  // product this line is now, so the swap is persisted before the screen that
  // shows it goes out.
  nodes.push(
    dataTableNode(
      'Save Alternate',
      {
        operation: 'update',
        table: TABLES.plans,
        filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }],
        columns: { plan_json: '={{ $json.planJson }}' },
      },
      { x: 960, y: 1760 },
    ),
  );
  link('Pick Alternate', 'Save Alternate');

  nodes.push(
    makeNode(
      'Update Picked Card',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: "={{ $('Pick Alternate').first().json.url }}",
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify($('Pick Alternate').first().json.body) }}",
        options: {},
      },
      { typeVersion: 4.2, x: 1180, y: 1760, onError: 'continueRegularOutput' },
    ),
  );
  link('Save Alternate', 'Update Picked Card');

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
${UI_MODULE}
// Data Table filters only do equality, so ownership, status and age are checked
// here. Ownership is a security boundary: a leaked plan id must not be enough to
// modify somebody else's cart.
const PLAN_TTL_MINUTES = 30;
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

const reject = (text) => [{ json: { chatId: route.chatId, invalid: true, text } }];

if (!row) return reject(UI.planNotFound);
if (String(row.telegram_user_id) !== String(route.telegramUserId)) {
  return reject('Цей план належить іншому користувачу.');
}
if (row.status === 'applying') {
  return reject('Ці зміни вже застосовуються — зачекайте кілька секунд.\\n\\nПовторне натискання зробило б заміни двічі.');
}
if (row.status !== 'pending') {
  return reject(UI.planUsed);
}
const createdAt = new Date(row.createdAt || row.created_at || 0);
if (Date.now() - createdAt.getTime() > PLAN_TTL_MINUTES * 60 * 1000) {
  return reject(UI.planStale);
}

// Apply with every box unticked. Rejected here rather than in Apply Changes for
// one reason: this runs before Claim Plan, so the plan stays 'pending' and the
// guest can tick something and tap again. Caught later it would burn a plan on
// a mistap, and it would have reported "your cart moved on" - a plain untruth
// about a cart nothing had touched.
//
// This is also where Task 5.2 is guaranteed: deselecting everything cannot
// reach a write, because it never gets past this line.
const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
const selected = Array.isArray(plan.selected)
  ? plan.selected
  : (plan.replacements || []).map((r, i) => i);
if (!selected.length) return reject(UI.nothingSelected);

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
${AI_RANKER}

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

// The band the plan was judged against, not whatever the setting says now: the
// guest may have changed it while the card was on screen, and re-judging a plan
// they already approved against a different rule would be a surprise.
const band = sizeBand(plan.sizeTolerance);

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
    text: UI.cartMovedOn }}];
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
    slug: replacement.replacementSlug || null,
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
      if (factor > band.max || factor < band.min) {
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
    originalSlug: q.replacement.originalSlug || null,
    name: q.detail.name,
    originalRatio: q.detail.from,
    newRatio: q.detail.to,
    tried: q.attempt,
    available: q.options.length,
  }));
const stockRejected = queue.filter(q => !q.settled && q.reason === 'unavailable')
  .map(q => ({
    originalName: q.replacement.originalName,
    originalSlug: q.replacement.originalSlug || null,
    name: q.detail,
    tried: q.attempt,
    available: q.options.length,
  }));
for (const q of queue.filter(q => !q.settled && q.reason === 'add-failed')) {
  const option = q.options[Math.min(q.attempt, q.options.length - 1)];
  failed.push({ name: option.name, slug: option.slug || null, error: q.detail });
}
const substituted = confirmed.filter(q => q.chosen.fallbackUsed)
  .map(q => ({
    planned: q.replacement.replacementName,
    plannedSlug: q.replacement.replacementSlug || null,
    used: q.chosen.option.name,
    usedSlug: q.chosen.option.slug || null,
  }));


// Mandatory verification: the headline number must come from the cart itself.
const after = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId: plan.shoppingCartId });
const afterTotal = after.cart.calculation.total;
const afterItems = (after.cart.shipments || []).reduce((all, s) => all.concat(s.products || []), []);

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
  // Names for the receipt wish. Taken from the cart already read back here, so
  // the wish costs no extra MCP call.
  cartNames: afterItems.map(p => p.name),
  loyalty: after.loyalty || {},
  // The raw message is an i18n key; the product name lives in context and is
  // resolved here so ui.ts can write a sentence a guest can act on.
  validations: (after.cart.calculation.validations || []).map(v => {
    const pid = v.context && v.context.productId;
    const line = pid ? afterItems.find(i => i.productId === pid) : null;
    return {
      level: v.level, type: v.type, message: v.message,
      productName: line ? line.name : null,
      productSlug: line ? line.slug : null,
    };
  }),
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
        text: UI.applying,
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      { x: 1180, y: 240 },
    ),
  );
  link('Claim Plan', 'Send Applying');
  link('Send Applying', 'Apply Changes');

  nodes.push(
    telegramNode(
      'Send Plan Invalid',
      // parse_mode on every node that carries UI text, whether or not today's
      // copy happens to contain a tag: the copy changes, the node does not.
      { chatId: '={{ $json.chatId }}', text: '={{ $json.text }}', additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true } },
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
${READ_VAR}
${HTTP_HELPER}
${AI_RANKER}
${UI_MODULE}
// The headline number is the actual cart total after the change, read back from
// Silpo — never the prediction the card showed.
const result = $('Apply Changes').first().json;

if (result.expired) return [{ json: { chatId: result.chatId, text: result.text } }];

// The wish is the one model call that is allowed to fail quietly. The cart has
// already been changed at this point, so this message must reach the guest
// whatever happens; a static line is less personal, not wrong. Anything the
// model returns is validated first - a digit is rejected outright, because that
// is how an unverified number would reach a guest through the one channel
// nothing else checks.
let wish = null;
const wishKey = readVar('ANTHROPIC_API_KEY');
if (wishKey) {
  try {
    setFetcher(httpFetch);
    wish = validateWish(await generateWish(
      WISH_SYSTEM_PROMPT,
      buildWishPrompt(result.cartNames || [], result.applied),
      wishKey,
    ));
  } catch (e) {
    wish = null;
  }
}

const text = buildResultText(result, wish || pickWish(result.actualSaving, result.applied));

return [{ json: { chatId: result.chatId, text } }];
`,
      { x: 1180, y: 320 },
    ),
  );
  link('Mark Plan Applied', 'Format Result');

  nodes.push(
    telegramNode(
      'Send Result',
      {
        chatId: '={{ $json.chatId }}',
        text: '={{ $json.text }}',
        // Closes the loop: the obvious next question after "what changed?" is
        // "what does the cart look like now?".
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [{ row: { buttons: [{ text: BUTTON.cart, additionalFields: { type: 'callback_data', callback_data: 'cart:' } }] } }],
        },
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      { x: 1400, y: 320 },
    ),
  );
  link('Format Result', 'Send Result');

  /* --- cancel, help, errors ------------------------------------------- */
  nodes.push(
    telegramNode(
      'Send Cancelled',
      { chatId: '={{ $json.chatId }}', text: UI.cancelled, additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true } },
      { x: 520, y: 520 },
    ),
  );
  link('Switch Action', 'Send Cancelled', 3);

  /* --- navigation screens: home, settings, about ----------------------- */
  //
  // The three of them share one send node. Each builds a card, turns it into
  // Bot API requests and hands them over; navigation edits the tapped message
  // rather than appending a new one, so the chat does not fill with dead menus.
  const screenNode = (name: string, code: string, y: number) => {
    nodes.push(
      codeNode(
        name,
        `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
const route = $('Merge Session').first().json;
const ctx = { chatId: route.chatId, messageId: route.messageId, callbackQueryId: route.callbackQueryId };
${code}
return screenRequests(card, ctx).map(r => ({ json: { url: telegramApiUrl(r.method), body: r.body } }));
`,
        { x: 520, y },
      ),
    );
    link(name, 'Send Screen');
  };

  screenNode('Build Home', 'const card = buildHomeCard(route.authorized);', 660);
  screenNode(
    'Build Settings',
    'const card = buildSettingsCard(route.authorized, (route.blockedBrands || []).length, route.sizeTolerance);',
    780,
  );
  screenNode('Build About', 'const card = buildAboutCard();', 900);
  screenNode('Show Brands', 'const card = buildBrandsCard(route.blockedBrands || []);', 1020);
  screenNode('Show Sizes', 'const card = buildModeCard(route.sizeTolerance);', 1140);

  // /start and anything unrecognised land on home. The fallback output sits
  // after every rule, so its index shifts whenever a rule is added.
  link('Switch Action', 'Build Home', 15);
  link('Switch Action', 'Build Home', 20);
  link('Switch Action', 'Build Settings', 11);
  link('Switch Action', 'Show Sizes', 16);
  link('Switch Action', 'Build About', 12);
  link('Switch Action', 'Show Brands', 9);

  nodes.push(
    makeNode(
      'Send Screen',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 800, y: 780 },
    ),
  );

  nodes.push(
    dataTableNode(
      'Load Plan Details',
      { operation: 'get', table: TABLES.plans, filters: [{ keyName: 'plan_id', keyValue: '={{ $json.planId }}' }] },
      { x: 520, y: 1140, alwaysOutputData: true },
    ),
  );
  link('Switch Action', 'Load Plan Details', 4);

  nodes.push(
    codeNode(
      'Format Details',
      `
${READ_VAR}
${TELEGRAM_API}
${UI_MODULE}
// Full breakdown behind the «Деталі» button — the per-item reasoning the card
// deliberately leaves out. Ownership is re-checked here for the same reason as
// in Validate Plan: a plan id alone must not reveal another customer's cart.
const route = $('Merge Session').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.plan_id);
const row = rows.find(r => String(r.plan_id) === String(route.planId));

if (!row || String(row.telegram_user_id) !== String(route.telegramUserId)) {
  return [{ json: { url: telegramApiUrl('sendMessage'), body: {
    ...message(route.chatId, UI.planNotFound) } }}];
}

const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
const card = buildDetailsCard(plan, row.plan_id);

return [{ json: { url: telegramApiUrl('sendMessage'), body: {
  ...message(route.chatId, card.text, { reply_markup: { inline_keyboard: card.keyboard } }),
} }}];
`,
      { x: 740, y: 800 },
    ),
  );
  link('Load Plan Details', 'Format Details');

  nodes.push(
    makeNode(
      'Send Details',
      'n8n-nodes-base.httpRequest',
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: {},
      },
      { typeVersion: 4.2, x: 960, y: 800 },
    ),
  );
  link('Format Details', 'Send Details');

  /* --- cart branch: read-only view of what is in the cart right now ----- */
  nodes.push(
    codeNode(
      'Read Cart',
      `
${MCP_CLIENT}

${UI_MODULE}

const route = $('Merge Session').first().json;
if (!route.authorized) {
  return [{ json: { chatId: route.chatId, empty: true, text: UI.connectFirst }}];
}

const mcp = createMcp(route.session);
const { shoppingCartId } = await mcp.call('silpo_get_my_shopping_cart', {});
const response = await mcp.call('silpo_get_shopping_cart_by_id', { shoppingCartId });
const cart = response.cart;
const items = cart.shipments.flatMap(s => s.products);

if (!items.length) {
  return [{ json: { chatId: route.chatId, empty: true, text: UI.cartEmpty }}];
}

const loyalty = response.loyalty || {};

// The stale-slot warning this screen used to carry is gone - see buildCartCard
// for why. An expired slot is an unfinished checkout, not a fault, and it was
// true for nearly every guest nearly every time.
const card = buildCartCard(items, cart.calculation.total, {
  discount: cart.calculation.subDiscount,
  bonusAvailable: loyalty.bonusAvailable,
});

return [{ json: { chatId: route.chatId, empty: false, text: card.text } }];
`,
      { x: 520, y: 960, onError: 'continueErrorOutput' },
    ),
  );
  link('Switch Action', 'Read Cart', 5);
  link('Read Cart', 'Handle Error', 1);

  // «Оптимізувати кошик» leads nowhere when there is nothing in the cart — and
  // the same output carries the "connect your account first" message. The node's
  // keyboard is fixed at design time, so the two cases need two nodes.
  nodes.push(
    makeNode(
      'Cart View Empty?',
      'n8n-nodes-base.if',
      {
        conditions: {
          options: { caseSensitive: true, version: 2 },
          combinator: 'and',
          conditions: [{ id: 'empty', operator: { type: 'boolean', operation: 'true', singleValue: true }, leftValue: '={{ $json.empty === true }}', rightValue: '' }],
        },
        options: {},
      },
      { typeVersion: 2.2, x: 740, y: 960 },
    ),
  );
  link('Read Cart', 'Cart View Empty?', 0);

  nodes.push(
    telegramNode(
      'Send Empty Cart View',
      {
        chatId: '={{ $json.chatId }}',
        text: '={{ $json.text }}',
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      { x: 960, y: 1100 },
    ),
  );
  link('Cart View Empty?', 'Send Empty Cart View', 0);

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
                buttons: [{ text: BUTTON.optimize, additionalFields: { type: 'callback_data', callback_data: 'optimize:' } }],
              },
            },
          ],
        },
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
      { x: 960, y: 900 },
    ),
  );
  link('Cart View Empty?', 'Send Cart', 1);

  nodes.push(
    codeNode(
      'Handle Error',
      `
${UI_MODULE}
// Never leak a stack trace to the customer — map failures to plain guidance.
const failure = $input.first().json;

// n8n does not put a failed node's message in one predictable place: depending
// on version and node type it is json.error (a plain string), json.error.message,
// or an Error instance whose message is non-enumerable. Reading only one shape
// left this node with an empty string, which cost a live debugging session -
// the guest saw the generic message with no hint, and the hint below is the
// whole reason this branch exists. Try every shape before giving up.
function errText(value, depth) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || (depth || 0) > 3) return '';
  if (typeof value.message === 'string' && value.message) return value.message;
  if (typeof value.description === 'string' && value.description) return value.description;
  for (const key of ['error', 'cause', 'lastNodeExecuted', 'errorMessage']) {
    const nested = errText(value[key], (depth || 0) + 1);
    if (nested) return nested;
  }
  return '';
}

let raw = errText(failure, 0);
// $input carries the item; the execution-level error lives elsewhere again.
if (!raw) {
  try { raw = errText($execution && $execution.error, 0); } catch (e) { /* not exposed */ }
}
if (!raw) raw = 'no error message was reported by n8n';

// The failing node's name narrows it down far faster than the message alone.
let where = '';
try {
  where = (failure.error && failure.error.node && failure.error.node.name)
    || (failure.node && failure.node.name) || '';
} catch (e) { /* ignore */ }

const route = $('Merge Session').first().json;

let kind = 'unknown';
if (raw.includes('SILPO_REAUTH_REQUIRED') || raw.includes('REAUTH')) kind = 'auth';
else if (raw.includes('SILPO_FORBIDDEN')) kind = 'forbidden';
else if (raw.includes('SILPO_MCP_ERROR_429')) kind = 'rate';
else if (raw.includes('SILPO_MCP_ERROR_5') || raw.includes('SILPO_EMPTY_RESPONSE')) kind = 'upstream';
else if (raw.includes('TOKEN_ENCRYPTION_KEY')) kind = 'config';
else if (raw.includes('TOOL_ERROR')) kind = 'cart';

let text = buildErrorText(kind);
if (kind === 'unknown') {
  // Not a stack trace, but enough to identify the failure without digging
  // through Executions. Unknown errors are the ones worth surfacing.
  const hint = (where ? where + ': ' : '') + raw.replace(/\\s+/g, ' ');
  text += '\\n\\n<i>' + esc(hint.slice(0, 200)) + '</i>';
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
      { chatId: '={{ $json.chatId }}', text: '={{ $json.text }}', additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true } },
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
      {
        chatId: "={{ $('Exchange Code').first().json.chat_id }}",
        text: UI.connected,
        // The one action worth taking next, as a button: the guest has just come
        // back from a browser and should not have to find a command.
        replyMarkup: 'inlineKeyboard',
        inlineKeyboard: {
          rows: [
            { row: { buttons: [{ text: BUTTON.optimize, additionalFields: { type: 'callback_data', callback_data: 'optimize:' } }] } },
          ],
        },
        additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
      },
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
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1115;color:#e7e9ee"><div style="text-align:center;max-width:22rem;padding:2rem"><div style="width:44px;height:44px;margin:0 auto 1.5rem;border-radius:50%;border:1.5px solid #3ecf8e;display:grid;place-items:center;color:#3ecf8e;font-size:20px">✓</div><h1 style="font-size:1.25rem;font-weight:600;margin:0 0 .5rem">Акаунт підключено</h1><p style="margin:0;opacity:.6">Поверніться в Telegram — усе готово.</p></div></body>',
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
          '={{ "<!doctype html><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\"><body style=\\"font:16px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1115;color:#e7e9ee\\"><div style=\\"text-align:center;max-width:22rem;padding:2rem\\"><div style=\\"width:44px;height:44px;margin:0 auto 1.5rem;border-radius:50%;border:1.5px solid #d0763a\\"></div><h1 style=\\"font-size:1.25rem;font-weight:600;margin:0 0 .5rem\\">Не вдалося підключити</h1><p style=\\"margin:0;opacity:.6\\">" + $json.message + "</p></div></body>" }}',
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
