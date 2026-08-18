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
    additionalFields?: { parse_mode?: string; disable_web_page_preview?: boolean };
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
  buildModeCard: (mode?: string | null, notice?: string) => Card;
  modeNotice: (stored: string | null, requested: string) => string;
  buildCartCard: (lines: unknown[], total: number, extras?: unknown) => Card;
  buildSelectionCard: (plan: unknown, selected: number[]) => Card;
  buildAlternativesCard: (plan: unknown, index: number, notice?: string) => Card;
  defaultSelection: (replacements: Array<{ confident?: boolean; saving: number }>) => number[];
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
    'buildHomeCard', 'buildSettingsCard', 'buildAboutCard', 'buildBrandsCard', 'buildModeCard',
    'modeNotice', 'buildCartCard', 'buildSelectionCard', 'buildAlternativesCard', 'defaultSelection', 'buildDetailsCard', 'buildResultText',
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
  // Real slugs, in cart order. One line is deliberately left without one — the
  // fallback to plain text has to be visible on the screen, not only in a test.
].map(([name, price, ratio, oldPrice], index) => ({
  name, price, ratio, oldPrice,
  slug: index === 4 ? null : `tovar-${index + 1}-${100000 + index}`,
}));

/** Names carrying the three characters HTML parse mode cannot take raw. */
const HOSTILE_CART = [
  { name: 'Сир <Президент> 45% & вершки', price: 12.5, ratio: '200 г', oldPrice: 20, slug: 'syr-prezydent-45-1234' },
  // No slug: a hostile name that is also unlinkable, which is where an escaping
  // mistake and a fallback mistake would compound.
  { name: 'Кава "Jacobs" 3-в-1 <міцна>', price: 8, ratio: '18 г' },
];

const PLAN = {
  planId: 'k3f9a1zx4b',
  summary: {
    originalTotal: 1847.4, saving: 186.12, itemsAnalyzed: 12,
    bonusAvailable: 45, cartDiscount: 344.51, couponsAvailable: 2,
  },
  replacements: [
    {
      originalName: 'Молоко Яготинське 2,5% 900г', replacementName: 'Молоко Premia 2,5% 900г',
      originalSlug: 'moloko-iahotynske-2-5-900g-123456', replacementSlug: 'moloko-ultrapasteryzovane-premiia-2-5-799508',
      originalPrice: 52.9, replacementPrice: 44.9, saving: 8, savingPct: 15, quantity: 2,
      onPromotion: true, brand: 'PREMIA', confident: true,
      aiReason: 'Молоко тієї ж жирності 2,5%, той самий обʼєм',
      // Two confirmed runners-up and one the run kept but may not offer: the
      // «Інші варіанти» screen has to draw the first two and no button at all
      // for the third.
      alternates: [
        {
          productId: 'a1', companyId: 'c1', branchId: 'b1',
          name: 'Молоко «Простонаше» ультрапастеризоване 2,5% 900г',
          slug: 'moloko-prostonashe-ultrapasterizovane-2-5-900g-661234',
          price: 47.9, saving: 10, brand: 'Простонаше', confident: true, offerable: true,
          reason: 'Те саме молоко 2,5%, той самий обʼєм, інша марка',
        },
        {
          productId: 'a2', companyId: 'c1', branchId: 'b1',
          name: 'Молоко «Селянське» особливе ультрапастеризоване 2,5% 900г',
          slug: 'moloko-selianske-osoblyve-2-5-900g-661235',
          price: 49.9, saving: 6, brand: 'Селянське', confident: false, offerable: true,
          reason: 'Та сама жирність і фасування, дорожче за перший варіант',
        },
        {
          productId: 'a3', companyId: 'c1', branchId: 'b1',
          name: 'Напій мигдалевий «Alpro» 900мл', slug: 'napii-mygdalevyi-alpro-900ml-661236',
          price: 44.9, saving: 16, brand: 'Alpro', confident: false, offerable: false,
          reason: 'Рослинний напій, а не молоко',
        },
      ],
    },
    {
      originalName: 'Сметана Яготинська 15% 350г', replacementName: 'Сметана «Селянська_особлива» 15% 350г',
      // No replacementSlug: the second row shows a linked original beside an
      // unlinked replacement, which is the mixed case a real plan produces.
      originalSlug: 'smetana-iahotynska-15-350g-223344',
      originalPrice: 52.99, replacementPrice: 32.99, saving: 20, savingPct: 38, quantity: 1,
      verifySize: true, brand: 'Селянське', confident: false,
      aiReason: 'Та сама жирність, але фасування вказане неоднозначно',
    },
  ],
};

/**
 * Sixteen replacements — what a full weekly basket produces.
 *
 * The card had no length budget until the reason line was added to it, so this
 * fixture is the one that would have proved the omission: past 4096 characters
 * Telegram rejects the whole send, and the guest gets nothing at all rather than
 * a shortened list.
 */
const BIG_PLAN = {
  planId: 'big1',
  summary: { originalTotal: 4286.86, saving: 620.5, itemsAnalyzed: 22, bonusAvailable: 34.24 },
  replacements: Array.from({ length: 16 }, (_, index) => ({
    originalName: `Ковбаса «Укрпромпостач» «Домашня» варена в/ґ, нарізка ${index + 1}`,
    replacementName: `Ковбаса Алан «Особлива» варено-копчена в/ґ, нарізка ${index + 1}`,
    originalSlug: `kovbasa-domashnia-varena-${300000 + index}`,
    replacementSlug: `kovbasa-alan-osoblyva-vareno-kopchena-${400000 + index}`,
    originalPrice: 129.9, replacementPrice: 99.9, saving: 30, savingPct: 23, quantity: 1,
    onPromotion: index % 3 === 0, confident: index % 4 !== 0, brand: 'Алан',
    aiReason: 'Та сама варена ковбаса, те саме фасування, дешевше',
  })),
};

/** A run where the model was sure of nothing: every box off, saving stated as possible. */
const CAUTIOUS_PLAN = {
  planId: 'c1',
  summary: { originalTotal: 980.5, saving: 41, itemsAnalyzed: 9 },
  replacements: [
    {
      originalName: 'Шинка Укрпромпостач для Сільпо Daniel с/к', replacementName: 'Рулька «Алан» «Особлива» свиняча в/к в/ґ',
      originalPrice: 799, replacementPrice: 549, saving: 25, savingPct: 31, quantity: 0.1,
      confident: false, aiReason: 'Копчений свинячий делікатес, але інша частина туші',
    },
    {
      originalName: 'Напій слабоалкогольний «Оболонь» «Бренді Кола»', replacementName: 'Напій слабоалкогольний Pangaia Lychee&Rose',
      originalPrice: 40.99, replacementPrice: 35.99, saving: 16, savingPct: 12, quantity: 1,
      confident: false, onPromotion: true, aiReason: 'Той самий формат банки 0,33 л, але зовсім інший смак',
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
    originalSlug: 'napii-sokovmisnyi-morshynska-lymon-555001',
    replacementSlug: 'napii-sokovmisnyi-morshynska-iabluko-555002',
    originalPrice: 33.99, replacementPrice: 19.99, saving: 14, savingPct: 41,
    onPromotion: true, brand: 'Моршинська',
  }],
};

const RESULT = {
  beforeTotal: 1847.4, afterTotal: 1686.5, actualSaving: 160.9, promisedSaving: 186.12,
  applied: 2, deselected: 1,
  substituted: [{
    planned: 'Сметана «Селянська» 15%', plannedSlug: 'smetana-selianska-15-661001',
    used: 'Сметана «Славія» 15%', usedSlug: 'smetana-slaviia-15-661002',
  }],
  sizeRejected: [{
    originalName: 'Масло Президент 82%', originalSlug: 'maslo-prezydent-82-671001',
    originalRatio: '200 г', newRatio: '180 г', tried: 2,
  }],
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
  ['results — sixteen replacements', ui.buildSelectionCard(BIG_PLAN, ui.defaultSelection(BIG_PLAN.replacements))],
  ['results — nothing confident', ui.buildSelectionCard(CAUTIOUS_PLAN, ui.defaultSelection(CAUTIOUS_PLAN.replacements))],
  ['results — colliding names', ui.buildSelectionCard(COLLIDING_PLAN, [0])],
  ['results — nothing found', ui.buildSelectionCard({ planId: 'x', summary: { originalTotal: 1847.4, itemsAnalyzed: 12, bonusAvailable: 45 }, replacements: [] }, [])],
  ['alternatives', ui.buildAlternativesCard(PLAN, 0)],
  ['alternatives — nothing left to offer', ui.buildAlternativesCard(PLAN, 1)],
  ['alternatives — stale tap', ui.buildAlternativesCard(PLAN, 0, ui.UI.alternateGone)],
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
  ['mode — balanced', ui.buildModeCard('balanced')],
  ['mode — legacy value «strict»', ui.buildModeCard('strict')],
  // Both drawn the way `Confirm Size` draws them: from the row read back after
  // the write, with the notice deciding whether it agrees with the tap.
  ['mode — after tap', ui.buildModeCard('max', ui.modeNotice('max', 'max'))],
  ['mode — the write did not land', ui.buildModeCard('balanced', ui.modeNotice('balanced', 'max'))],
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
    .replace(/<a href="[^"]*">/g, '[4;36m').replace(/<\/a>/g, '[24;39m')
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

const ALLOWED_TAGS = ['b', 'i', 's', 'u', 'code', 'pre', 'a'];
/**
 * Product links are the one tag carrying an attribute, so they need their own
 * pattern — and the href is checked rather than skipped: a link to anywhere but
 * a Silpo product page has no business on these screens.
 */
const ANCHOR = /<a href="([^"]*)">/g;
const PRODUCT_HREF = /^https:\/\/silpo\.ua\/product\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
// U+FE0F only ever styles the glyph before it, so it must not count on its own.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2139}]\u{FE0F}?/gu;

for (const [title, screen] of SCREENS) {
  const { text, keyboard } = typeof screen === 'string' ? { text: screen, keyboard: [] } : screen;

  for (const [, href] of text.matchAll(ANCHOR)) {
    if (!PRODUCT_HREF.test(href)) fail(`${title}: <a href="${href}"> is not a Silpo product page`);
  }

  const stack: string[] = [];
  for (const match of text.replace(ANCHOR, '<a>').matchAll(/<(\/?)([a-z]+)>/g)) {
    if (!ALLOWED_TAGS.includes(match[2])) fail(`${title}: unknown tag <${match[2]}>`);
    if (match[1]) {
      if (stack.pop() !== match[2]) fail(`${title}: <${match[2]}> closed out of order`);
    } else stack.push(match[2]);
  }
  if (stack.length) fail(`${title}: unclosed <${stack.join('>, <')}>`);

  const bare = text.replace(ANCHOR, '').replace(/<\/?[a-z]+>/g, '').replace(/&(amp|lt|gt);/g, '');
  if (/[<>&]/.test(bare)) fail(`${title}: unescaped < > or & — Telegram will reject the send`);

  // Telegram's cap applies to the text after entities are parsed, so the href
  // of a product link does not count towards it. Nothing else is discounted —
  // the tags that were counted before still are.
  const counted = text.replace(ANCHOR, '').split('</a>').join('').length;
  if (counted > 4096) fail(`${title}: ${counted} characters, over the Telegram limit`);

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
// Tags stripped first: two rows whose names collide now differ by their href,
// and comparing the raw lines would report a collision as no collision.
const cartNames = bigCart.text
  .split('\n')
  .filter((l) => /^\d+\. /.test(l))
  .map((l) => l.replace(/<[^>]+>/g, ''));
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
  // Product names are links, and Telegram answers the first one with a preview
  // card — a product photo and its shop blurb stapled under a full-screen
  // result. Every node that carries UI text has to turn it off, whether or not
  // today's copy happens to contain a link.
  if (node.parameters.additionalFields?.disable_web_page_preview !== true) {
    fail(`${node.name}: Telegram node would attach a link preview under the message`);
  }
}
pass(`${telegramNodes.length} Telegram nodes send with parse_mode HTML and no link preview`);

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
  ...['connect:', 'optimize:', 'cart:', 'settings:', 'about:', 'home:', 'brands:', 'bradd:', 'brx:2', 'sizes:', 'sizes:max',
    'apply:abc123', 'details:abc123', 'cancel:abc123', 't:abc123:4', 'logout:ask', 'logout:yes', 'logout:no',
    'alt:abc123:0', 'alt:abc123', 'altpick:abc123:0:1',
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

/* `screenRequests` decides between editing the screen in place and posting a new
   one by looking at `ctx.callbackQueryId`. A context that misspells the field is
   not an error anywhere — it is simply absent, and the screen silently starts
   sending instead of editing, unanswered. `Update Size` did this for three
   commits: tapping a mode looked like nothing happening at all. */
// The definition itself rides along inside the inlined UI module in every node,
// so only call sites count — anything but `function screenRequests(`.
const screenNodes = workflow.nodes.filter((n) =>
  (n.parameters.jsCode ?? '').replace('function screenRequests(', '').includes('screenRequests('));
for (const node of screenNodes) {
  if (!(node.parameters.jsCode ?? '').includes('callbackQueryId:')) {
    fail(`${node.name}: builds a screen context without callbackQueryId — it will send instead of edit`);
  }
}
pass(`${screenNodes.length} nodes draw a screen, all pass callbackQueryId through`);

/* A leaked plan id must never be enough to read or change somebody else's plan.
   Every node that opens `plan_json` therefore checks the tapper against
   `telegram_user_id` — the same boundary for the alternatives screens as for
   toggle, details and apply. */
const planReaders = workflow.nodes.filter((n) => {
  const jsCode = n.parameters.jsCode ?? '';
  // `Apply Changes` reads the row `Validate Plan` already vetted, and vetting it
  // there rather than here is deliberate — it runs before the plan is claimed.
  return jsCode.includes('plan_json') && !jsCode.includes("$('Validate Plan')");
});
for (const node of planReaders) {
  if (!(node.parameters.jsCode ?? '').includes('telegram_user_id')) {
    fail(`${node.name}: reads a stored plan without checking who owns it`);
  }
}
pass(`${planReaders.length} nodes read a stored plan, all check ownership`);

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
