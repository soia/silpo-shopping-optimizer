/**
 * Executes a Code node's JavaScript straight out of the generated workflow JSON,
 * with n8n's globals stubbed and a live token from .secrets.
 *
 * This catches what static validation cannot: runtime errors, a broken inline of
 * the engine, wrong MCP arguments. Read-only — only the analysis branch is
 * exercised, never the write path.
 *
 *   npm run test:node
 *   npm run test:node -- "Route Request"
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { StoredAuth } from '../lib/mcp.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Prefer the deployable build when it exists; the template works too, since the
// Code nodes under test never touch table ids.
const WORKFLOW = ['.secrets/workflows/telegram-bot.json', 'workflows/telegram-bot.template.json']
  .map((p) => resolve(ROOT, p))
  .find((p) => existsSync(p))!;

const workflow = JSON.parse(readFileSync(WORKFLOW, 'utf8')) as {
  nodes: Array<{ name: string; parameters: { jsCode?: string } }>;
};
const auth = JSON.parse(readFileSync(resolve(ROOT, '.secrets/silpo-auth.json'), 'utf8')) as StoredAuth;

const nodeName = process.argv[2] ?? 'Optimize Cart';
const node = workflow.nodes.find((n) => n.name === nodeName);
if (!node?.parameters.jsCode) {
  console.error(`No Code node named "${nodeName}"`);
  process.exit(1);
}

/* n8n runtime stubs */
const session = {
  client_id: auth.client_id,
  access_token: auth.access_token,
  refresh_token: auth.refresh_token,
  expires_at: new Date(auth.expires_at).toISOString(),
};
const mergedSession = { chatId: 111, telegramUserId: 222, action: 'optimize', authorized: true, session };

const $ = (name: string) => ({
  first: () => ({ json: name === 'Merge Session' ? mergedSession : {} }),
  all: () => [{ json: name === 'Merge Session' ? mergedSession : {} }],
  item: { json: mergedSession },
});
const $env = { N8N_BASE_URL: 'https://example.app.n8n.cloud', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) };
const $input = { all: () => [{ json: mergedSession }], first: () => ({ json: mergedSession }) };

console.log(`\nRunning Code node "${nodeName}" against the live MCP server\n`);
const startedAt = Date.now();

const run = new Function('$', '$env', '$input', 'require', 'fetch', `return (async () => {\n${node.parameters.jsCode}\n})();`);
const output = (await run($, $env, $input, createRequire(import.meta.url), fetch)) as Array<{ json: any }>;

const result = output[0].json;
const money = (n: number) => `${Number(n).toFixed(2).replace('.', ',')} UAH`;

if (result.empty) {
  console.log('Cart is empty');
  process.exit(0);
}
if (!result.summary) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log('─'.repeat(64));
console.log(`Cart:       ${result.shoppingCartId}`);
console.log(`Branch:     ${result.branchId} (${result.deliveryType})`);
console.log(`Slot:       ${result.timeslotStart} → ${result.timeslotEnd}`);
console.log(`Promotions: ${result.promotionsCount} · coupons: ${result.couponsCount} · bonuses: ${result.loyalty.bonusAvailable}`);
console.log('─'.repeat(64));
console.log(`Before:     ${money(result.summary.originalTotal)}`);
console.log(`After:      ${money(result.summary.optimizedTotal)}`);
console.log(`Saving:     ${money(result.summary.saving)} (${result.summary.savingPct}%)`);
console.log(`Replaced:   ${result.summary.replacementsFound} of ${result.summary.itemsAnalyzed} items`);
console.log('─'.repeat(64));

for (const replacement of result.replacements) {
  console.log(`• ${replacement.originalName.slice(0, 40)}`);
  console.log(`  → ${replacement.replacementName.slice(0, 40)}  −${money(replacement.saving)}${replacement.verifySize ? '  [verify size]' : ''}`);
}

console.log(`\nCompleted in ${((Date.now() - startedAt) / 1000).toFixed(1)}s with no errors\n`);
