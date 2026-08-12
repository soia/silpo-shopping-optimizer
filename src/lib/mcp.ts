/**
 * Silpo MCP client: JSON-RPC over Streamable HTTP.
 *
 * Handles token refresh on 401, exponential backoff on 429/5xx, and both
 * `application/json` and `text/event-stream` response encodings.
 *
 * This module is the reference implementation for the JS Code nodes in the
 * generated n8n workflows — same logic, different token source (database
 * instead of the local `.secrets` file).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AUTH_FILE = resolve(ROOT, '.secrets/silpo-auth.json');

export const MCP_URL = 'https://mcp.silpo.ua/mcp';
export const TOKEN_URL = 'https://mcp.silpo.ua/token';
export const ISSUER = 'https://mcp.silpo.ua';
export const PROTOCOL_VERSION = '2025-06-18';

export interface StoredAuth {
  client_id: string;
  access_token: string;
  refresh_token: string | null;
  token_type?: string;
  scope?: string | null;
  expires_at: number;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface CallStats {
  calls: number;
  retries: number;
  refreshes: number;
}

export const stats: CallStats = { calls: 0, retries: 0, refreshes: 0 };

let auth: StoredAuth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
let initialized = false;

/** Exchanges the refresh token for a fresh access token and persists it. */
async function refreshToken(): Promise<void> {
  if (!auth.refresh_token) {
    throw new Error('No refresh token available — run `npm run authorize` again');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: auth.client_id,
      resource: MCP_URL,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status} ${await res.text()}`);

  const token = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  auth = {
    ...auth,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? auth.refresh_token,
    expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  stats.refreshes++;
}

/** Single JSON-RPC round trip with retry policy. */
async function rpc(method: string, params: unknown, id = Math.floor(Math.random() * 1e9)): Promise<unknown> {
  const send = () =>
    fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${auth.access_token}`,
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  stats.calls++;
  let res = await send();
  if (res.status === 401) {
    await refreshToken();
    res = await send();
  }

  // Per-user rate limiting is documented; back off instead of hammering.
  for (let attempt = 0; (res.status === 429 || res.status >= 500) && attempt < 5; attempt++) {
    const waitMs = 2 ** attempt * 1000 + Math.random() * 250;
    stats.retries++;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await send();
  }
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const raw = await res.text();
  let message: JsonRpcResponse | undefined;

  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        if (parsed.id === id || parsed.error) message = parsed;
      } catch {
        // keep-alive frame, ignore
      }
    }
  } else {
    message = JSON.parse(raw) as JsonRpcResponse;
  }

  if (!message) throw new Error(`Empty response for ${method}`);
  if (message.error) throw new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`);
  return message.result;
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await rpc(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'silpo-shopping-optimizer', version: '1.0.0' },
    },
    1,
  );
  initialized = true;
}

/** Calls an MCP tool and unwraps `content[].text` into parsed JSON. */
export async function callTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureInitialized();
  const result = (await rpc('tools/call', { name, arguments: args })) as ToolResult;

  const textPart = result?.content?.find((c) => c.type === 'text');
  let data: unknown = result;
  if (textPart?.text) {
    try {
      data = JSON.parse(textPart.text);
    } catch {
      data = { raw: textPart.text };
    }
  }

  if (result?.isError) {
    const error = new Error(`${name}: ${JSON.stringify(data).slice(0, 200)}`);
    (error as Error & { isToolError?: boolean }).isToolError = true;
    throw error;
  }
  return data as T;
}

export interface Settled<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Runs tasks with bounded concurrency so we stay under the rate limit. */
export async function mapLimit<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<Array<Settled<TOut>>> {
  const out = new Array<Settled<TOut>>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          out[index] = { ok: true, value: await fn(items[index], index) };
        } catch (e) {
          out[index] = { ok: false, error: (e as Error).message };
        }
      }
    }),
  );
  return out;
}
