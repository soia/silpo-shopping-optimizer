/**
 * Registers the bot's command menu with Telegram.
 *
 * This is what lets the screens stop printing commands. Once registered, they
 * appear under the «/» button and in the input hints — discoverable when wanted,
 * invisible the rest of the time — which is where a fallback belongs. The list
 * itself lives in `src/lib/ui.ts` next to the copy it mirrors.
 *
 * Run once per bot, and again whenever COMMANDS changes:
 *
 *   TELEGRAM_BOT_TOKEN=… npm run setup:commands
 *
 * The token is read from the environment or from `.secrets/telegram.json`
 * ({ "botToken": "…" }). It is never written anywhere, and never logged.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../lib/ui.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET_FILE = resolve(ROOT, '.secrets/telegram.json');

function readToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  if (existsSync(SECRET_FILE)) {
    const parsed = JSON.parse(readFileSync(SECRET_FILE, 'utf8')) as { botToken?: string };
    if (parsed.botToken) return parsed.botToken;
  }
  console.error('No bot token. Set TELEGRAM_BOT_TOKEN or create .secrets/telegram.json with { "botToken": "…" }');
  process.exit(1);
}

const token = readToken();

async function call(method: string, body: unknown): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { ok: boolean; description?: string };
  // The token is in the URL, so the URL itself is never part of an error.
  if (!result.ok) throw new Error(`${method} failed: ${result.description ?? response.status}`);
}

await call('setMyCommands', { commands: COMMANDS });

// The menu button is what the guest actually taps to see them.
await call('setChatMenuButton', { menu_button: { type: 'commands' } });

console.log(`Registered ${COMMANDS.length} commands:`);
for (const { command, description } of COMMANDS) {
  console.log(`  /${command.padEnd(10)} ${description}`);
}
console.log('\nThey now appear under the "/" menu, so no screen has to print them.');
