/**
 * Renders every screen out of the generated workflow, and enforces the UI rules.
 *
 *   npm run preview          print all screens as Telegram will paint them
 *   npm run preview -- --check   assertions only, non-zero exit on a violation
 *
 * Why it reads the workflow JSON rather than importing `src/lib/ui.ts`: the copy
 * reaches the guest through the inlined module, and only what was emitted proves
 * anything. This is the same rule the engine follows — test the output, not the
 * source.
 *
 * What it catches, all of which happened at least once here:
 *
 *   - a message body assembled without `parse_mode`, which ships
 *     "<b>Аналізую кошик…</b>" to the guest, tags and all;
 *   - a Telegram node missing `parse_mode` in its parameters, same result;
 *   - an unclosed or unknown HTML tag, or a bare `<`/`&` in a product name,
 *     either of which makes Telegram reject the whole send;
 *   - two emoji on one line, where a product starts looking like a toy;
 *   - a list whose items are not all the same height;
 *   - clipped names that collide, turning four cart lines into four identical
 *     ones;
 *   - a command, button or callback that reaches no wired branch;
 *   - `callback_data` over Telegram's 64-byte cap, or a message over 4096.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(ROOT, 'workflows/telegram-bot.template.json');
const CHECK_ONLY = process.argv.includes('--check');

interface WorkflowNode {
  name: string;
  type: string;
  parameters: {
    jsCode?: string;
    text?: string;
    additionalFields?: { parse_mode?: string };
    rules?: { values: Array<{ outputKey: string }> };
  };
}

interface Workflow {
  nodes: WorkflowNode[];
  connections: Record<string, { main?: Array<Array<{ node: string }> | null> }>;
}

const workflow = JSON.parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
const nodeNamed = (name: string) => workflow.nodes.find((n) => n.name === name);

let failures = 0;
const fail = (message: string) => {
  console.log(`  FAIL  ${message}`);
  failures++;
};
const pass = (message: string) => console.log(`  ok    ${message}`);

/* ------------------------------------------------ load the emitted UI module */

interface Card {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

interface UiModule {
  UI: Record<string, string>;
  BUTTON: Record<string, string>;
  COMMANDS: Array<{ command: string; description: string }>;
  BRAND_PROMPT_MARKER: string;
  buildHomeCard: (authorized: boolean) => Card;
  buildSettingsCard: (authorized: boolean, blocked: number) => Card;
  buildAboutCard: () => Card;
  buildBrandsCard: (brands: string[], notice?: string) => Card;
  buildSizesCard: (tolerance?: string | null, notice?: string) => Card;
  buildCartCard: (lines: unknown[], total: number, extras?: unknown) => Card;
  buildSelectionCard: (plan: unknown, selected: number[]) => Card;
  buildDetailsCard: (plan: unknown, planId: string) => Card;
  buildResultText: (result: unknown, wish: string) => string;
  buildErrorText: (kind: string) => string;
  brandToast: (kind: string, brand: string) => string;
  logoutKeyboard: () => Card['keyboard'];
  homeKeyboard: () => { keyboard: Array<Array<{ text: string }>> };
  screenRequests: (card: Card, ctx: unknown, toast?: string) => Array<{ method: string; body: Record<string, unknown> }>;
  brandPromptRequest: (ctx: unknown) => Array<{ method: string; body: Record<string, unknown> }>;
}

/**
 * The module sits at the top of every screen node, ahead of that node's own
 * code. `Build Home` is the smallest of them, and its first statement is the
 * boundary.
 */
function loadUi(): UiModule {
  const jsCode = nodeNamed('Build Home')?.parameters.jsCode ?? '';
  const boundary = jsCode.indexOf("const route = $('Merge Session')");
  if (boundary < 0) throw new Error('Build Home no longer starts with the route lookup — update the boundary marker');

  const names: Array<keyof UiModule> = [
    'UI', 'BUTTON', 'COMMANDS', 'BRAND_PROMPT_MARKER',
    'buildHomeCard', 'buildSettingsCard', 'buildAboutCard', 'buildBrandsCard', 'buildSizesCard',
    'buildCartCard', 'buildSelectionCard', 'buildDetailsCard', 'buildResultText',
    'buildErrorText', 'brandToast', 'logoutKeyboard', 'homeKeyboard',
    'screenRequests', 'brandPromptRequest',
  ];
  const factory = new Function(`${jsCode.slice(0, boundary)}\nreturn { ${names.join(', ')} };`) as () => UiModule;
  return factory();
}

const ui = loadUi();

/* --------------------------------------------------------------- fixtures */

/**
 * A real cart, including the cases that broke earlier versions: four names that
 * differ only past any sensible clip, two herrings that do the same, and a name
 * long enough to wrap twice.
 */
const CART = [
  ['Оселедець Norsk Delikatesse норвезький молодий слабосолений', 199, '100г', 299],
  ['Шинка Алан Куряча в/к в/г, нарізка', 69.99, '100г', 129],
  ['Напій сокoвмісний Моршинська зі смаком лимона негазований', 33.99, '1,5л', 40.99],
  ['Напій сокoвмісний Моршинська зі смаком яблука негазований', 33.99, '1,5л', 40.99],
  ['Напій сокoвмісний Моршинська Малина-Лаванда негазований', 33.99, '1,5л', 40.99],
  ["Напій сокoвмісний Моршинська Чорниця-М'ята негазований", 33.99, '1,5л', 40.99],
  ['Пиво Warsteiner світле с/п', 84.99, '0,33л', 96.99],
  ['Пакети для сміття «Премія»® з ручками 35 л', 49.99, '30шт', 61.99],
  ['Оселедець Norsk Delikatesse норвезький молодий слабосолоний, філе в упаковці', 379, '100г', 479],
  ['Вентилятор підлоговий Grunhelm GFS-4010', 799, 'шт', 1199],
].map(([name, price, ratio, oldPrice]) => ({ name, price, ratio, oldPrice }));

/** Names carrying the three characters HTML parse mode cannot take raw. */
const HOSTILE_CART = [
  { name: 'Сир <Президент> 45% & вершки', price: 12.5, ratio: '200 г', oldPrice: 20 },
  { name: 'Кава "Jacobs" 3-в-1 <міцна>', price: 8, ratio: '18 г' },
];

const PLAN = {
  planId: 'k3f9a1zx4b',
  summary: { originalTotal: 1847.4, saving: 186.12, itemsAnalyzed: 12, bonusAvailable: 45 },
  replacements: [
    {
      originalName: 'Молоко Яготинське 2,5% 900г', replacementName: 'Молоко Premia 2,5% 900г',
      originalPrice: 52.9, replacementPrice: 44.9, saving: 8, savingPct: 15, quantity: 2,
      onPromotion: true, brand: 'PREMIA', aiReason: 'Той самий відсоток жиру та обʼєм',
    },
    {
      originalName: 'Сметана Яготинська 15% 350г', replacementName: 'Сметана «Селянська_особлива» 15% 350г',
      originalPrice: 52.99, replacementPrice: 32.99, saving: 20, savingPct: 38, quantity: 1,
      verifySize: true, brand: 'Селянське',
    },
  ],
};

/** The pair from a real run whose clipped names came out identical. */
const COLLIDING_PLAN = {
  planId: 'z1',
  summary: { originalTotal: 1437.39, saving: 14, itemsAnalyzed: 15 },
  replacements: [{
    originalName: 'Напій соковмісний Моршинська зі смаком лимона негазований',
    replacementName: 'Напій соковмісний Моршинська зі смаком яблука негазований',
    originalPrice: 33.99, replacementPrice: 19.99, saving: 14, savingPct: 41,
    onPromotion: true, brand: 'Моршинська',
  }],
};

const RESULT = {
  beforeTotal: 1847.4, afterTotal: 1686.5, actualSaving: 160.9, promisedSaving: 186.12,
  applied: 2, deselected: 1,
  substituted: [{ planned: 'Сметана «Селянська» 15%', used: 'Сметана «Славія» 15%' }],
  sizeRejected: [{ originalName: 'Масло Президент 82%', originalRatio: '200 г', newRatio: '180 г', tried: 2 }],
  loyalty: { bonusAvailable: 45 }, validations: [],
};

const bigCart = ui.buildCartCard(CART, 1437.39, { discount: 608.51, bonusAvailable: 34.24 });
const card = ui.buildSelectionCard(PLAN, [0]);

const SCREENS: Array<[string, Card | string]> = [
  ['home — not connected', ui.buildHomeCard(false)],
  ['home — connected', ui.buildHomeCard(true)],
  ['connect', { text: ui.UI.connectPrompt, keyboard: [[{ text: ui.BUTTON.login, url: 'https://…' }]] }],
  ['connected', ui.UI.connected],
  ['cart — ten real items', bigCart],
  ['cart — names hostile to HTML', ui.buildCartCard(HOSTILE_CART, 20.5, {})],
  ['cart — empty', ui.UI.cartEmpty],
  ['analysing', ui.UI.analysing],
  ['results', card],
  ['results — colliding names', ui.buildSelectionCard(COLLIDING_PLAN, [0])],
  ['results — nothing found', ui.buildSelectionCard({ planId: 'x', summary: { originalTotal: 1847.4, itemsAnalyzed: 12, bonusAvailable: 45 }, replacements: [], slotExpired: true }, [])],
  ['details', ui.buildDetailsCard(PLAN, PLAN.planId)],
  ['applying', ui.UI.applying],
  ['applied', ui.buildResultText(RESULT, 'Дрібні заощадження мають звичку перетворюватися на великі радощі.')],
  ['settings', ui.buildSettingsCard(true, 2)],
  ['settings — not connected', ui.buildSettingsCard(false, 0)],
  ['about', ui.buildAboutCard()],
  ['logout', { text: ui.UI.logoutPrompt, keyboard: ui.logoutKeyboard() }],
  ['brands', ui.buildBrandsCard(['Премія', 'Ascania', 'Лавка традицій Lago'])],
  ['brands — empty', ui.buildBrandsCard([])],
  ['brands — after /block', ui.buildBrandsCard(['Премія', 'Ascania'], ui.brandToast('added', 'Ascania'))],
  ['sizes', ui.buildSizesCard('normal')],
  ['sizes — strict', ui.buildSizesCard('strict')],
  ['sizes — after tap', ui.buildSizesCard('loose', 'Збережено: вільно')],
  ['brand prompt', ui.UI.brandPrompt],
  ...['auth', 'rate', 'upstream', 'cart', 'unknown'].map(
    (kind) => [`error — ${kind}`, ui.buildErrorText(kind)] as [string, string],
  ),
];

/* ----------------------------------------------------------------- preview */

/** Approximates what Telegram paints, so a screen can be judged by eye. */
const paint = (text: string) =>
  text
    .replace(/<b>/g, '[1m').replace(/<\/b>/g, '[22m')
    .replace(/<i>/g, '[3m').replace(/<\/i>/g, '[23m')
    .replace(/<s>/g, '[9;2m').replace(/<\/s>/g, '[29;22m')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

if (!CHECK_ONLY) {
  for (const [title, screen] of SCREENS) {
    const { text, keyboard } = typeof screen === 'string' ? { text: screen, keyboard: [] } : screen;
    console.log(`\n[7m ${title} [0m`);
    console.log(paint(text));
    for (const row of keyboard) {
      console.log(`[36m  ${row.map((b) => `[ ${b.text} ]`).join('  ')}[0m`);
    }
  }
  console.log(`\n[2mpersistent keyboard: ${ui.homeKeyboard().keyboard.map((r) => r.map((b) => b.text).join(' · ')).join(' | ')}`);
  console.log(`«/» menu: ${ui.COMMANDS.map((c) => '/' + c.command).join(' ')}[0m\n`);
}

/* ------------------------------------------------------------------ checks */

console.log('\nscreens');

const ALLOWED_TAGS = ['b', 'i', 's', 'u', 'code', 'pre'];
// U+FE0F only ever styles the glyph before it, so it must not count on its own.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2139}]\u{FE0F}?/gu;

for (const [title, screen] of SCREENS) {
  const { text, keyboard } = typeof screen === 'string' ? { text: screen, keyboard: [] } : screen;

  const stack: string[] = [];
  for (const match of text.matchAll(/<(\/?)([a-z]+)>/g)) {
    if (!ALLOWED_TAGS.includes(match[2])) fail(`${title}: unknown tag <${match[2]}>`);
    if (match[1]) {
      if (stack.pop() !== match[2]) fail(`${title}: <${match[2]}> closed out of order`);
    } else stack.push(match[2]);
  }
  if (stack.length) fail(`${title}: unclosed <${stack.join('>, <')}>`);

  const bare = text.replace(/<\/?[a-z]+>/g, '').replace(/&(amp|lt|gt);/g, '');
  if (/[<>&]/.test(bare)) fail(`${title}: unescaped < > or & — Telegram will reject the send`);

  if (text.length > 4096) fail(`${title}: ${text.length} characters, over the Telegram limit`);

  for (const line of text.split('\n')) {
    const hits = line.match(EMOJI) ?? [];
    if (hits.length > 1) fail(`${title}: ${hits.length} emoji on one line — ${line.trim().slice(0, 44)}`);
  }

  for (const row of keyboard) {
    for (const button of row) {
      if (button.callback_data && Buffer.byteLength(button.callback_data) > 64) {
        fail(`${title}: callback_data ${Buffer.byteLength(button.callback_data)} bytes, cap is 64`);
      }
    }
  }
}
pass(`${SCREENS.length} screens: tags closed and escaped, within limits, one emoji per line`);

/* Every item of a list must be the same height, or the price stops being a
   column. Measured on the cart, which is the longest list the bot renders.
   Only the item region counts: the summary above and the notes below sit
   outside the rules that fence it, and counting them made this check fail
   itself the first time it ran. */
const itemRegion = bigCart.text.split('─'.repeat(14))[1] ?? '';
const heights = new Set<number>();
let height = 0;
for (const line of itemRegion.split('\n')) {
  if (/^\d+\. /.test(line)) {
    if (height) heights.add(height);
    height = 1;
  } else if (line.trim() && height) height++;
}
if (height) heights.add(height);
if (heights.size > 1) fail(`cart items are ${[...heights].join(' and ')} lines tall — the rhythm is broken`);
else pass(`cart rhythm: every item is ${[...heights][0]} lines`);

/* A clip that collides with another one hides the only word telling two
   products apart. Both lists below contain such a pair by construction. */
const cartNames = bigCart.text.split('\n').filter((l) => /^\d+\. /.test(l));
if (new Set(cartNames).size !== cartNames.length) fail('cart: two lines render identically after clipping');
else pass('cart: no two lines are identical after clipping');

const collided = ui.buildSelectionCard(COLLIDING_PLAN, [0]).text;
if (collided.includes('лимона') && collided.includes('яблука')) pass('selection card: colliding names kept in full');
else fail('selection card: the clip hid the word that tells the two products apart');

/* Nothing may build a Bot API body by hand: message() is what sets parse_mode,
   and a body without it ships raw <b> tags to the guest. */
let handBuilt = 0;
for (const node of workflow.nodes) {
  const jsCode = node.parameters.jsCode ?? '';
  if (!jsCode.includes('chat_id:')) continue;
  const bodies = [...jsCode.matchAll(/chat_id:/g)].length - (jsCode.includes('function message(') ? 1 : 0);
  if (bodies > 0) {
    fail(`${node.name}: ${bodies} message body built by hand, bypassing message()`);
    handBuilt += bodies;
  }
}
if (!handBuilt) pass('every Bot API body goes through message()');

/* The Telegram node carries parse_mode as a parameter, where it is just as easy
   to forget. Applied to every node with text, whether or not today's copy
   happens to contain a tag — the copy changes, the node does not. */
const telegramNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.telegram' && n.parameters.text);
for (const node of telegramNodes) {
  const mode = node.parameters.additionalFields?.parse_mode;
  if (mode !== 'HTML') fail(`${node.name}: Telegram node sends text with parse_mode=${mode ?? 'unset'}`);
}
pass(`${telegramNodes.length} Telegram nodes send with parse_mode HTML`);

/* ---------------------------------------------------------------- routing */

console.log('\nrouting');

const routeCode = nodeNamed('Route Request')?.parameters.jsCode ?? '';
const switchKeys = nodeNamed('Switch Action')?.parameters.rules?.values.map((r) => r.outputKey) ?? [];
const wiredOutputs = new Set(
  (workflow.connections['Switch Action']?.main ?? [])
    .map((branch, index) => (branch && branch.length ? index : -1))
    .filter((index) => index >= 0),
);

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  message: { text, chat: { id: 1 }, from: { id: 2, first_name: 'Микита' }, message_id: 9, ...extra },
});
const tap = (data: string) => ({
  callback_query: { id: 'q', data, from: { id: 2 }, message: { chat: { id: 1 }, message_id: 9 } },
});

const ENTRY_POINTS: Array<[string, unknown]> = [
  ['/start', message('/start')],
  ['/optimize', message('/optimize')],
  ['/cart', message('/cart')],
  ['/settings', message('/settings')],
  ['/blocked', message('/blocked')],
  ['/block Премія', message('/block Премія')],
  ['/block, no argument', message('/block')],
  ['/unblock Премія', message('/unblock Премія')],
  ['/connect', message('/connect')],
  ['/logout', message('/logout')],
  ['unrecognised text', message('привіт')],
  ...['optimize', 'cart', 'settings'].map(
    (key) => [`keyboard: ${ui.BUTTON[key]}`, message(ui.BUTTON[key])] as [string, unknown],
  ),
  ...['connect:', 'optimize:', 'cart:', 'settings:', 'about:', 'home:', 'brands:', 'bradd:', 'brx:2', 'sizes:', 'sizes:loose',
    'apply:abc123', 'details:abc123', 'cancel:abc123', 't:abc123:4', 'logout:ask', 'logout:yes', 'logout:no',
  ].map((data) => [`button ${data}`, tap(data)] as [string, unknown]),
  ['reply to the brand prompt', message('Яготинське', { reply_to_message: { text: ui.BRAND_PROMPT_MARKER + '\n\nНаприклад: Яготинське' } })],
];

const route = new Function('$input', routeCode) as (input: unknown) => Array<{ json: { action: string } }>;
let unrouted = 0;
for (const [label, update] of ENTRY_POINTS) {
  const { action } = route({ all: () => [{ json: update }] })[0].json;
  const index = switchKeys.indexOf(action);
  // A rule that matches nothing falls through to the fallback output, which sits
  // after every rule — its index shifts whenever a rule is added.
  if (!wiredOutputs.has(index === -1 ? switchKeys.length : index)) {
    fail(`${label} → "${action}" reaches no wired branch`);
    unrouted++;
  }
}
if (!unrouted) pass(`${ENTRY_POINTS.length} entry points all reach a wired branch`);

/* One intent, one branch. Wiring an action to two branches sends the screen
   twice — /blocked did exactly that once. */
for (const [index, key] of switchKeys.entries()) {
  const targets = workflow.connections['Switch Action']?.main?.[index] ?? [];
  if (targets && targets.length > 1) {
    fail(`"${key}" is wired to ${targets.length} branches: ${targets.map((t) => t.node).join(', ')}`);
  }
}
pass(`${switchKeys.length} switch outputs, none wired twice`);

console.log(failures ? `\n${failures} problem(s) found\n` : '\nAll screens render correctly\n');
process.exit(failures ? 1 : 0);
