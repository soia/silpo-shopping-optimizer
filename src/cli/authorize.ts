/**
 * One-time authorization against the Silpo MCP server, plus a schema dump.
 *
 * Performs exactly what the n8n workflows do at runtime:
 *   1. read the authorization server metadata
 *   2. register a client through Dynamic Client Registration
 *   3. generate a PKCE pair and open /authorize in a browser
 *   4. receive the redirect on a local callback and exchange the code
 *   5. run MCP initialize + tools/list over Streamable HTTP
 *   6. write the real JSON Schemas to disk
 *
 * Tokens land in .secrets/silpo-auth.json (gitignored, mode 0600).
 *
 *   npm run authorize
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredAuth } from '../lib/mcp.ts';
import { ISSUER, MCP_URL, PROTOCOL_VERSION } from '../lib/mcp.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CALLBACK_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

const AUTH_FILE = resolve(ROOT, '.secrets/silpo-auth.json');
const TOOLS_JSON = resolve(ROOT, 'data/mcp-tools.json');
const TOOLS_MD = resolve(ROOT, 'docs/mcp-tools.md');

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    required?: string[];
    properties?: Record<string, { type?: string; description?: string; enum?: string[]; anyOf?: Array<{ type?: string }> }>;
  };
}

const log = (...args: unknown[]) => console.log(...args);
const die = (message: string): never => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

const base64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The URL is printed as well, so a failure here is not fatal.
  }
}

/** Serves a single GET on /callback and resolves with its query parameters. */
function waitForCallback(): Promise<Record<string, string>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => {
        server.close();
        rejectPromise(new Error('No redirect received within 5 minutes'));
      },
      5 * 60 * 1000,
    );

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const params = Object.fromEntries(url.searchParams) as Record<string, string>;
      const success = Boolean(params.code);

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8">
<body style="font:16px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:56px">${success ? '✅' : '⚠️'}</div>
  <h2>${success ? 'Authorized' : 'Authorization failed'}</h2>
  <p>${success ? 'You can close this tab and return to the terminal.' : `${params.error ?? 'unknown'}: ${params.error_description ?? ''}`}</p>
</div></body>`);

      clearTimeout(timer);
      setTimeout(() => server.close(), 200);
      resolvePromise(params);
    });

    server.on('error', (e: NodeJS.ErrnoException) =>
      rejectPromise(e.code === 'EADDRINUSE' ? new Error(`Port ${CALLBACK_PORT} is busy — free it and retry`) : e),
    );
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
}

async function registerClient(metadata: AuthServerMetadata): Promise<RegisteredClient> {
  const res = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Silpo Shopping Optimizer (CLI)',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  const body = await res.text();
  if (!res.ok) die(`Dynamic Client Registration failed: HTTP ${res.status}\n${body}`);
  return JSON.parse(body) as RegisteredClient;
}

/* ---------------------------------------------------------------- MCP calls */

let sessionId: string | null = null;

async function rpc(token: string, method: string, params: unknown, id: number, notify = false): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const payload = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });

  const returnedSession = res.headers.get('mcp-session-id');
  if (returnedSession) sessionId = returnedSession;

  if (notify) return null;
  if (!res.ok) die(`${method} → HTTP ${res.status}\n${await res.text()}`);

  const raw = await res.text();
  let message: { result?: any; error?: { code: number; message: string }; id?: number } | undefined;

  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed.id === id || parsed.error) message = parsed;
      } catch {
        // keep-alive frame
      }
    }
    if (!message) die(`${method}: no JSON-RPC payload in the SSE stream\n${raw.slice(0, 500)}`);
  } else {
    message = JSON.parse(raw);
  }

  if (message!.error) die(`${method} → JSON-RPC ${message!.error.code}: ${message!.error.message}`);
  return message!.result;
}

/* --------------------------------------------------------------------- main */

log('\nSilpo MCP authorization\n');

let auth: StoredAuth | null = null;
if (existsSync(AUTH_FILE)) {
  const cached = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as StoredAuth;
  const stillValid = cached.expires_at > Date.now() + 60_000;
  log(stillValid ? 'Reusing the stored token' : 'Stored token expired — re-authorizing');
  if (stillValid) auth = cached;
}

if (!auth) {
  log('1/5  Reading authorization server metadata');
  const metadata = (await (await fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json()) as AuthServerMetadata;
  if (!metadata.code_challenge_methods_supported?.includes('S256')) die('Server does not advertise S256 support');

  log('2/5  Registering client (Dynamic Client Registration)');
  const client = await registerClient(metadata);
  log(`     client_id = ${client.client_id}`);

  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: MCP_URL,
  }).toString();

  log('\n3/5  Opening the browser — sign in with your Silpo phone number and OTP.');
  log('     If no tab opened, copy this URL:\n');
  log(`     ${authUrl}\n`);
  openBrowser(authUrl.toString());

  const callback = waitForCallback();
  log(`     Waiting for the redirect on ${REDIRECT_URI}`);
  const params = await callback;

  if (params.error) die(`Authorization rejected: ${params.error} — ${params.error_description ?? ''}`);
  if (params.state !== state) die('State mismatch — possible CSRF, aborting');

  log('4/5  Exchanging the code for tokens');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: MCP_URL,
  });
  if (client.client_secret) form.set('client_secret', client.client_secret);

  const tokenRes = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!tokenRes.ok) die(`Token exchange failed: HTTP ${tokenRes.status}\n${await tokenRes.text()}`);

  const token = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string };
  auth = {
    client_id: client.client_id,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? null,
    token_type: token.token_type ?? 'Bearer',
    scope: token.scope ?? null,
    expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
  };

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  log(`     Tokens saved (expires_in=${token.expires_in ?? '?'}s, refresh_token=${auth.refresh_token ? 'yes' : 'no'})`);
}

log('\n5/5  MCP initialize');
const init = await rpc(auth.access_token, 'initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'silpo-optimizer-cli', version: '1.0.0' },
}, 1);
log(`     server: ${init.serverInfo?.name} v${init.serverInfo?.version} (protocol ${init.protocolVersion})`);
log(`     session id: ${sessionId ?? 'not used by this server'}`);

await rpc(auth.access_token, 'notifications/initialized', {}, 0, true);

log('     tools/list');
let tools: McpTool[] = [];
let cursor: string | undefined;
do {
  const page = await rpc(auth.access_token, 'tools/list', cursor ? { cursor } : {}, Date.now());
  tools = tools.concat(page.tools ?? []);
  cursor = page.nextCursor;
} while (cursor);

log(`\nRetrieved ${tools.length} tools\n`);

mkdirSync(dirname(TOOLS_JSON), { recursive: true });
writeFileSync(
  TOOLS_JSON,
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      serverInfo: init.serverInfo,
      protocolVersion: init.protocolVersion,
      capabilities: init.capabilities,
      toolCount: tools.length,
      tools,
    },
    null,
    2,
  ),
);

const markdown = [
  '# Silpo MCP — actual tool schemas',
  '',
  `Retrieved ${new Date().toISOString()} via \`tools/list\` — generated, do not edit by hand.`,
  `Server: ${init.serverInfo?.name} v${init.serverInfo?.version}, protocol ${init.protocolVersion}. Tools: **${tools.length}**.`,
  '',
  '---',
  '',
  ...tools.flatMap((tool) => {
    const required = tool.inputSchema?.required ?? [];
    const properties = tool.inputSchema?.properties ?? {};
    const rows = Object.entries(properties).map(([name, schema]) => {
      const type = schema.type ?? (schema.anyOf ? schema.anyOf.map((x) => x.type).join('\\|') : schema.enum ? 'enum' : '?');
      const enumValues = schema.enum ? ` (${schema.enum.join(', ')})` : '';
      const description = (schema.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return `| \`${name}\` | ${type}${enumValues} | ${required.includes(name) ? '**yes**' : 'no'} | ${description} |`;
    });

    return [
      `## \`${tool.name}\``,
      '',
      tool.description ?? '_No description._',
      '',
      rows.length ? ['| Parameter | Type | Required | Description |', '|---|---|---|---|', ...rows].join('\n') : '_No parameters._',
      '',
    ];
  }),
].join('\n');
writeFileSync(TOOLS_MD, markdown);

log('  data/mcp-tools.json  — raw schemas, the source of truth for the workflows');
log('  docs/mcp-tools.md    — readable parameter tables\n');

const names = tools.map((t) => t.name).sort();
const required = [
  'silpo_get_my_shopping_cart',
  'silpo_get_shopping_cart_by_id',
  'silpo_get_time_slots',
  'silpo_get_similar_products',
  'silpo_get_replacements',
  'silpo_get_promotions',
  'silpo_get_my_coupons',
  'silpo_get_promo_codes',
  'silpo_get_my_promos',
  'silpo_get_loyalty_info',
  'silpo_add_or_update_cart_products',
  'silpo_remove_cart_products',
  'silpo_update_shopping_cart',
];
const missing = required.filter((name) => !names.includes(name));
log(missing.length ? `Missing from tools/list: ${missing.join(', ')}` : 'All tools required by the optimizer are present.\n');
