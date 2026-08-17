/**
 * Presentation layer — every string the guest reads, and every keyboard.
 *
 * Why a module and not strings scattered through `build.ts`: the copy was spread
 * across fourteen nodes, half of it inside TypeScript template literals where a
 * newline has to be written `\\n` and a backtick ends the literal. Nothing about
 * wording deserves that hazard. This file is inlined into the Code nodes the same
 * way `optimizer.ts` is, so the text here is ordinary source: real `\n`, real
 * apostrophes, no double escaping.
 *
 * Two consumers:
 *   - Code nodes    — the module is transpiled and prepended (see UI_MODULE).
 *   - node params   — `build.ts` imports `UI` directly for static messages.
 *
 * Design rules this file follows:
 *   - Buttons are the interface. No screen prints a command: they are registered
 *     with `setMyCommands` (npm run setup:commands) and live under Telegram's «/»
 *     menu, which is where a fallback belongs.
 *   - Emoji mark, they do not decorate: one at the head of a screen title or a
 *     section, one as a status marker on a line (🎁 promotion, 💰 saving, 💳
 *     bonuses, ⏰ expired slot, 📦 pack size). Never two in a row, never mid
 *     sentence.
 *   - Lists keep a fixed rhythm. Long product names are clipped so every item is
 *     the same height and the price column stays a column.
 *   - One bold element per line — the number the guest is scanning for.
 *   - One screen, one job. Anything that is not a daily action moves behind
 *     Settings; anything not needed to decide moves behind «Деталі».
 *
 * Language: Ukrainian, per the project rule — these are strings Silpo guests read.
 */

/* --------------------------------------------------------------- primitives */

/** Non-breaking space: keeps "1 847 ₴" from wrapping mid-number on mobile. */
const NBSP = ' ';

/**
 * Money, the way a receipt prints it: grouped thousands, decimal comma, ₴.
 *
 * The sign is rendered with U+2212 rather than a hyphen so a saving reads as a
 * minus and not as a list bullet.
 */
export function money(value: number): string {
  const amount = Number(value) || 0;
  const fixed = Math.abs(amount).toFixed(2);
  const parts = fixed.split('.');
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return (amount < 0 ? '−' : '') + grouped + ',' + parts[1] + NBSP + '₴';
}

/** A saving, always written as a negative delta. */
export function delta(value: number): string {
  return '−' + money(Math.abs(Number(value) || 0));
}

/** One decimal, no trailing ",0" — percentages are context, not headline. */
export function percent(part: number, whole: number): string {
  if (!whole) return '';
  const value = Math.round((part / whole) * 1000) / 10;
  return String(value).replace('.', ',') + '%';
}

/**
 * Escapes text for HTML parse mode.
 *
 * The screens are HTML rather than Markdown for one reason: `<s>` — a struck-out
 * old price says "this is a discount" the way a price tag does, with no word and
 * no symbol to decode. Legacy Markdown has no strikethrough at all.
 *
 * Escaping is also saner here. Markdown needed every `_` and `*` in a product
 * name escaped or Telegram rejected the whole message with HTTP 400; HTML needs
 * exactly these three characters, and Telegram ignores unknown tags rather than
 * refusing the send.
 */
export function esc(text: unknown): string {
  return String(text).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
}

/** Bold — the one number per line the eye should land on. */
function b(text: string | number): string {
  return '<b>' + text + '</b>';
}

/** Italic — asides and caveats, never a fact the guest needs. */
function i(text: string | number): string {
  return '<i>' + text + '</i>';
}

/** Struck out — a price that no longer applies. */
function s(text: string | number): string {
  return '<s>' + text + '</s>';
}

/** A thin rule between a summary and its breakdown. */
const RULE = '─'.repeat(14);

/**
 * Commands registered with the Bot API, in menu order.
 *
 * Registering them is what lets every screen stop printing them. `/block` and
 * `/unblock` take an argument and are listed without one on purpose: sent bare,
 * they open the same force_reply prompt the «+ Додати марку» button opens.
 */
export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'optimize', description: 'Знайти, де можна зекономити' },
  { command: 'cart', description: 'Показати кошик' },
  { command: 'settings', description: 'Налаштування' },
  { command: 'blocked', description: 'Марки, які не пропонувати' },
  { command: 'block', description: 'Не пропонувати марку' },
  { command: 'unblock', description: 'Повернути марку' },
  { command: 'connect', description: 'Підключити акаунт «Сільпо»' },
  { command: 'logout', description: 'Від’єднати акаунт' },
];

/* ------------------------------------------------------------------- shapes */

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export type Keyboard = Button[][];

export interface Card {
  text: string;
  keyboard: Keyboard;
}

interface Replacement {
  originalName: string;
  replacementName: string;
  originalPrice: number;
  replacementPrice: number;
  saving: number;
  savingPct?: number;
  quantity?: number;
  onPromotion?: boolean;
  verifySize?: boolean;
  brand?: string;
  aiReason?: string;
}

interface PlanSummary {
  originalTotal: number;
  saving?: number;
  itemsAnalyzed?: number;
  bonusAvailable?: number;
}

interface Plan {
  planId?: string;
  replacements?: Replacement[];
  summary: PlanSummary;
  slotExpired?: boolean;
}

/* ------------------------------------------------------------ static copy */

/**
 * Messages with no dynamic parts.
 *
 * `build.ts` drops these straight into Telegram node parameters, so they are
 * plain values rather than functions.
 */
export const UI = {
  /** Shown when a command needs a cart and no account is connected yet. */
  connectFirst:
    '🔐 <b>Потрібен доступ до кошика</b>\n\n' +
    'Підключіть акаунт «Сільпо» — і я побачу, що у вашому кошику та які ціни діють саме для вас.',

  /**
   * The force_reply prompt behind «Додати марку».
   *
   * Its first line is also the routing marker: a reply whose
   * `reply_to_message.text` starts with it is treated as a brand name, so the
   * guest types «Яготинське» rather than «/block Яготинське». Changing this text
   * changes the marker — `Route Request` compares against BRAND_PROMPT_MARKER.
   */
  brandPrompt: '🚫 Напишіть назву марки, яку не пропонувати.\n\nНаприклад: Яготинське',

  connectPrompt:
    '🔗 <b>Підключення акаунта «Сільпо»</b>\n\n' +
    'Увійдіть за номером телефону і поверніться сюди. Я повідомлю, щойно все буде готово.\n\n' +
    '<i>Доступ зберігається зашифрованим на сервері й ніколи не потрапляє в Telegram.</i>',

  connected:
    '✅ <b>Акаунт підключено</b>\n\n' +
    'Тепер я бачу ваш кошик. Перевірити, де можна зекономити?',

  /**
   * Sent before the analysis starts.
   *
   * The previous version listed four steps with an emoji each, which promised a
   * progress indicator the workflow cannot deliver — nothing updates it. One
   * honest line about the wait does the same job.
   */
  analysing: '⏳ <b>Аналізую кошик…</b>\n\nПеревіряю аналоги, акції, купони та балабонуси. Це займає до хвилини.',

  cartEmpty:
    '🛒 <b>Кошик порожній</b>\n\n' +
    'Наповніть його в застосунку «Сільпо» — і я перевірю, де те саме коштує дешевше.',

  cartEmptyForOptimize:
    '🛒 <b>Кошик порожній</b>\n\n' +
    'Оптимізувати поки нічого. Наповніть кошик у застосунку «Сільпо» і поверніться сюди.',

  cancelled: '❌ Скасовано — кошик не змінювався.\n\nЗапустіть /optimize, коли будете готові.',

  logoutPrompt:
    '🚪 <b>Від’єднати акаунт «Сільпо»?</b>\n\n' +
    'Видалю збережений доступ і підготовлені плани. Ваш кошик і замовлення в «Сільпо» залишаться без змін.\n\n' +
    '<i>Список винятків за марками збережеться.</i>',

  logoutCancelled: '✅ Акаунт залишився підключеним.',

  logoutWorking: '🚪 Від’єдную акаунт…',

  logoutDone:
    '🚪 <b>Акаунт від’єднано</b>\n\n' +
    'Збережений доступ видалено, підготовлені плани стерто. Кошик у «Сільпо» не змінювався.\n\n' +
    'Підключити інший — /connect',

  logoutNotConnected: 'Акаунт «Сільпо» не підключений.\n\nЩоб підключити — /connect',

  /**
   * Sent the moment «Застосувати» is tapped, before the writes start.
   *
   * The duration is stated because the run genuinely takes minutes: each
   * replacement is added on its own, the cart is re-read to check the pack size
   * it only reveals once an item is in it, and the calls are spaced out because
   * Silpo starts refusing a burst. Silence for two minutes reads as a hang, and
   * a guest who thinks it hung taps the button again.
   */
  applying:
    '⏳ <b>Застосовую зміни до кошика…</b>\n\n' +
    'Зазвичай це триває від 1 до 3 хвилин: кожну заміну додаю окремо й перевіряю об’єм упаковки вже в кошику.\n\n' +
    '<i>Можна закрити чат — я напишу, щойно завершу.</i>',

  planGone: '⏳ План застарів. Запустіть /optimize ще раз.',

  planNotFound: '⏳ План не знайдено або він застарів.\n\nЗапустіть /optimize ще раз.',

  planUsed: '✅ Цей план уже застосований або скасований.\n\nЗапустіть /optimize, щоб порахувати заново.',

  planStale: '⏳ План застарів — ціни могли змінитися.\n\nЗапустіть /optimize ще раз.',

  cartMovedOn:
    '🔄 Кошик змінився з моменту аналізу — жодної із запропонованих позицій у ньому вже немає.\n\n' +
    'Запустіть /optimize ще раз.',
} as const;

/* ------------------------------------------------------------ button labels */

/**
 * Button labels.
 *
 * Emoji live here and nowhere else. On a button an emoji works the way an icon
 * works in an app — it makes the row scannable in a fifth of a second — while
 * the same emoji inside a paragraph is decoration. That is the whole policy:
 * icons on controls, none in prose.
 */
export const BUTTON = {
  login: '🔗 Увійти в «Сільпо»',
  connect: '🔗 Підключити «Сільпо»',
  optimize: '✨ Оптимізувати кошик',
  cart: '🛒 Мій кошик',
  settings: '⚙️ Налаштування',
  brands: '🚫 Марки, які не пропонувати',
  sizes: '📦 Різниця в фасуванні',
  brandAdd: '+ Додати марку',
  brandRemove: '✕',
  about: 'Як це працює',
  disconnect: 'Від’єднати акаунт',
  back: '‹ Назад',
  details: 'Деталі',
  apply: 'Застосувати',
  cancel: 'Скасувати',
  logoutYes: 'Так, від’єднати',
  logoutNo: 'Скасувати',
};

/**
 * The always-visible keyboard under the input field.
 *
 * This is the bot's chrome: the three actions stay reachable without scrolling
 * back to an old message. Telegram allows one `reply_markup` per message, so it
 * cannot ride along with a screen that has inline buttons — it is attached to
 * the messages that need no buttons of their own (the progress line, the
 * connected notice), which every guest passes through early.
 */
export function homeKeyboard(): { keyboard: Array<Array<{ text: string }>>; resize_keyboard: boolean; is_persistent: boolean } {
  return {
    keyboard: [[{ text: BUTTON.optimize }], [{ text: BUTTON.cart }, { text: BUTTON.settings }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * Selection glyphs.
 *
 * ✅ against ☐ rather than two typographic marks: the checkbox pair is the one
 * place where a filled, coloured glyph beats a subtle one, because the guest is
 * scanning a column of them to see what is still ticked.
 */
const ON = '✅';
const OFF = '☐';

/* ----------------------------------------------------------------- screens */

/**
 * Home — the product, not its documentation.
 *
 * Four lines and three buttons. No command is printed anywhere: they are
 * registered with `setMyCommands` instead, so Telegram lists them under the «/»
 * menu where a fallback belongs. Anything that is not a daily action — brands,
 * the account, how it works — sits one tap away behind Settings rather than
 * competing with the primary action for the first screen.
 */
export function buildHomeCard(authorized: boolean): Card {
  if (!authorized) {
    return {
      text:
        '🛒 <b>Оптимізатор кошика «Сільпо»</b>\n\n' +
        'Знайду дешевші аналоги, акції та купони для вашого кошика — без змін у суті покупки.\n\n' +
        'Підключіть акаунт, щоб я побачив ваш кошик.',
      keyboard: [
        [{ text: BUTTON.connect, callback_data: 'connect:' }],
        [{ text: BUTTON.about, callback_data: 'about:' }],
      ],
    };
  }

  return {
    text:
      '🛒 <b>Оптимізатор кошика «Сільпо»</b>\n\n' +
      'Знайду дешевші аналоги, акції та купони для вашого кошика — без змін у суті покупки.\n\n' +
      '🔒 Нічого не змінюю без вашого підтвердження.',
    keyboard: [
      [{ text: BUTTON.optimize, callback_data: 'optimize:' }],
      [
        { text: BUTTON.cart, callback_data: 'cart:' },
        { text: BUTTON.settings, callback_data: 'settings:' },
      ],
    ],
  };
}

/**
 * Settings — everything that is not a daily action.
 *
 * Each row states its current value rather than only its name, so the screen
 * answers "what is set right now" without a further tap.
 */
export function buildSettingsCard(authorized: boolean, blockedCount: number, tolerance?: string | null): Card {
  const brandsRow = blockedCount
    ? BUTTON.brands + ' · ' + blockedCount
    : BUTTON.brands;

  const keyboard: Keyboard = [[{ text: brandsRow, callback_data: 'brands:' }]];
  keyboard.push([{ text: BUTTON.sizes + ' · ' + toleranceLabel(tolerance), callback_data: 'sizes:' }]);
  keyboard.push([{ text: BUTTON.about, callback_data: 'about:' }]);
  keyboard.push([
    authorized
      ? { text: BUTTON.disconnect, callback_data: 'logout:ask' }
      : { text: BUTTON.connect, callback_data: 'connect:' },
  ]);
  keyboard.push([{ text: BUTTON.back, callback_data: 'home:' }]);

  return {
    text:
      '⚙️ <b>Налаштування</b>\n\n' +
      '👤 Акаунт «Сільпо»: ' + (authorized ? 'підключено' : 'не підключено') + '\n' +
      '🚫 Марок у винятках: ' + blockedCount + '\n' +
      '📦 Різниця в фасуванні: ' + toleranceLabel(tolerance),
    keyboard,
  };
}

/**
 * How it works — the explanation the home screen no longer carries.
 *
 * It exists because the guest deserves to know what a replacement is allowed to
 * change before they tap Apply, and because the pack-size caveat is easier to
 * accept when it was explained once, calmly, rather than only at rollback time.
 */
/**
 * How much the pack size may differ, as three presets.
 *
 * Presets rather than a number the guest types: a free-form value needs parsing,
 * validation and an error path, and «0.8» means nothing to a shopper. Each option
 * says what it does in the words of the thing being bought.
 *
 * The percentages here are derived from the same table the engine enforces, so
 * the screen cannot drift from the behaviour.
 */
export const TOLERANCE_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'strict', label: 'Строго', hint: 'тільки те саме фасування' },
  { key: 'normal', label: 'Звичайно', hint: 'до чверті більше або менше' },
  { key: 'loose', label: 'Вільно', hint: 'помітно інше фасування, якщо ціна за 100 г краща' },
];

export function toleranceLabel(tolerance?: string | null): string {
  const found = TOLERANCE_OPTIONS.find((o) => o.key === (tolerance || 'normal'));
  return found ? found.label.toLowerCase() : 'звичайно';
}

export function buildSizesCard(tolerance?: string | null, notice?: string): Card {
  const active = tolerance || 'normal';

  let text =
    '📦 <b>Різниця в фасуванні</b>\n\n' +
    'Наскільки заміна може відрізнятися за обсягом або вагою від того, що у вашому кошику.\n\n';
  text += TOLERANCE_OPTIONS.map(
    (o) => (o.key === active ? '● ' : '○ ') + b(o.label) + ' — ' + o.hint,
  ).join('\n');
  text +=
    '\n\n' +
    i('Менша упаковка за меншу ціну — це не економія, тому за будь-якого налаштування я порівнюю ціну за однакову кількість.');
  if (notice) text += '\n\n' + i(notice);

  const keyboard: Keyboard = TOLERANCE_OPTIONS.map((o) => [
    { text: (o.key === active ? '● ' : '○ ') + o.label, callback_data: 'sizes:' + o.key },
  ]);
  keyboard.push([{ text: BUTTON.back, callback_data: 'settings:' }]);

  return { text, keyboard };
}

export function buildAboutCard(): Card {
  return {
    text:
      '💡 <b>Як це працює</b>\n\n' +
      'Я читаю ваш кошик у «Сільпо» і для кожної позиції шукаю дешевший аналог: інша марка того самого товару, акція, купон або балабонуси.\n\n' +
      'Суть покупки не змінюється — обсяг, жирність і призначення лишаються ті самі. Молоко 2,5% замінюю тільки на молоко 2,5%.\n\n' +
      'Ви бачите кожну заміну окремо й обираєте, що застосувати. Без вашого підтвердження кошик не змінюється.\n\n' +
      'Обсяг упаковки звіряю одразу — і ще раз перевіряю в кошику перед тим, як лишити заміну. Якщо він відрізняється, повертаю оригінал.',
    keyboard: [[{ text: BUTTON.back, callback_data: 'settings:' }]],
  };
}

/**
 * Brand preferences.
 *
 * One row per brand with its own ✕, so removing one is a tap rather than a
 * command with an argument typed correctly. Adding goes through a force_reply
 * prompt for the same reason: the guest types a name, not a syntax.
 */
export function buildBrandsCard(brands: string[], notice?: string): Card {
  let text = brands.length
    ? '🚫 <b>Марки, які не пропоную</b>\n\n' +
      'Ці марки не з’являться серед замін. Ваш кошик вони не змінюють.'
    : '🚫 <b>Марки, які не пропоную</b>\n\n' +
      'Список порожній — пропоную заміни будь-яких марок.\n\n' +
      'Марку кожної заміни видно в картці оптимізації, тож виключити невдалу можна одразу після аналізу.';

  // A command (/block Премія) has no callback to toast into, so the same
  // confirmation is shown on the screen itself.
  if (notice) text += '\n\n' + notice;

  // Only the ✕ removes. The name beside it redraws the same screen, because a
  // row that deletes wherever you touch it is a trap, not a control.
  const keyboard: Keyboard = brands.slice(0, 20).map((brand, i) => [
    { text: trim(brand, 28), callback_data: 'brands:' },
    { text: BUTTON.brandRemove, callback_data: 'brx:' + i },
  ]);
  keyboard.push([{ text: BUTTON.brandAdd, callback_data: 'bradd:' }]);
  keyboard.push([{ text: BUTTON.back, callback_data: 'settings:' }]);

  return { text, keyboard };
}

/** Confirmation shown in the callback toast after a brand is added or removed. */
export function brandToast(kind: 'added' | 'removed' | 'duplicate', brand: string): string {
  if (kind === 'added') return brand + ' більше не пропонуватиму';
  if (kind === 'removed') return brand + ' повернуто в пошук';
  return brand + ' вже у списку';
}

/* -------------------------------------------------------------- cart view */

interface CartLine {
  name: string;
  price: number;
  quantity?: number;
  ratio?: string;
  oldPrice?: number;
}

/**
 * The cart as it stands right now — a statement, not a proposal.
 *
 * Fifteen lines of a real cart are what this screen has to survive, and the
 * first version did not. Three things fixed it:
 *
 *   - **A fixed rhythm.** Every item is exactly two lines, because a name that
 *     wraps onto a third one collides with the price beneath it and the eye
 *     loses the column. Long names are clipped at a word; the full name is a tap
 *     away in the Silpo app.
 *   - **One bold element per item.** The price is what the guest scans for, so
 *     it is the only weight on the line and the rest recedes around it.
 *   - **A price tag, not a formula.** "🎁 −100,00 ₴" needed decoding: minus what,
 *     off what? The line now reads the way a shelf label does — the price you
 *     pay, then the price you would have paid, struck out. Nobody has to be told
 *     what that means.
 */
export function buildCartCard(
  lines: CartLine[],
  total: number,
  extras: { discount?: number; bonusAvailable?: number; slotBroken?: boolean } = {},
): Card {
  const LIMIT = 30;
  const shown = lines.slice(0, LIMIT);

  let text =
    '🛒 <b>Ваш кошик</b>\n' +
    lines.length + ' ' + plural(lines.length, 'товар', 'товари', 'товарів') +
    ' · <b>' + money(total) + '</b>\n' +
    RULE + '\n';

  const names = clipAll(shown.map((item) => item.name), 38);

  text += shown
    .map((item, index) => {
      // Price first and bold, old price struck out right after it: the two
      // numbers explain each other, so neither needs a label.
      const meta = [b(money(item.price))];
      if (item.oldPrice && item.oldPrice > item.price) meta.push(s(money(item.oldPrice)));
      const tail = [];
      if (item.quantity && item.quantity > 1) tail.push('× ' + item.quantity);
      if (item.ratio) tail.push(esc(item.ratio));
      return (
        (index + 1) + '. ' + names[index] + '\n     ' +
        meta.join(' ') + (tail.length ? ' · ' + tail.join(' · ') : '')
      );
    })
    .join('\n');

  if (lines.length > shown.length) {
    text += '\n\n<i>…і ще ' + (lines.length - shown.length) + ' ' + plural(lines.length - shown.length, 'позиція', 'позиції', 'позицій') + '.</i>';
  }

  const notes: string[] = [];
  if (extras.discount && extras.discount > 0) notes.push('🎁 Знижок уже враховано · <b>' + money(extras.discount) + '</b>');
  if (extras.bonusAvailable && extras.bonusAvailable > 0) notes.push('💳 Балабонуси · ' + money(extras.bonusAvailable));
  if (notes.length) text += '\n' + RULE + '\n' + notes.join('\n');

  if (extras.slotBroken) {
    text += '\n\n⏰ <i>Слот доставки протух — оберіть новий у застосунку, інакше кошик не оформиться.</i>';
  }

  return { text, keyboard: [[{ text: BUTTON.optimize, callback_data: 'optimize:' }]] };
}

/* --------------------------------------------------------- selection card */

/**
 * The main screen: what the run found, and what the guest can do about it.
 *
 * Structure, in order of what a person needs to decide:
 *   1. the saving, as a headline number;
 *   2. before → after, one line;
 *   3. the replacements, three lines each;
 *   4. everything else — caveats, bonuses — as quiet trailing notes.
 *
 * The per-item caveats that used to sit here (pack size, brand hint) moved into
 * a single trailing sentence and the «Деталі» screen: they matter, but not while
 * the guest is ticking boxes.
 */
export function buildSelectionCard(plan: Plan, selected: number[]): Card {
  const replacements = plan.replacements || [];
  const originalTotal = plan.summary.originalTotal;

  if (!replacements.length) {
    let text =
      '✅ <b>Кошик уже оптимальний</b>\n\n' +
      (plan.summary.itemsAnalyzed || 0) +
      ' ' +
      plural(plan.summary.itemsAnalyzed || 0, 'товар', 'товари', 'товарів') +
      ' · <b>' +
      money(originalTotal) +
      '</b>\n\n' +
      'Дешевших аналогів, які зберігають суть покупки, не знайшов.';
    if (plan.slotExpired) {
      text += '\n\n<i>Слот доставки протух, тож наявність могла зчитатися неточно. Оберіть новий слот у застосунку і спробуйте ще раз.</i>';
    }
    if (plan.summary.bonusAvailable && plan.summary.bonusAvailable > 0) {
      text += '\n\n💳 Балабонуси · ' + money(plan.summary.bonusAvailable) + ' — застосуйте при оформленні.';
    }
    return { text, keyboard: [] };
  }

  const chosen = replacements.filter((r, i) => selected.indexOf(i) !== -1);
  const saving = chosen.reduce((sum, r) => sum + r.saving, 0);
  const share = percent(saving, originalTotal);

  let text =
    '💰 <b>Заощадите ' + money(saving) + '</b>\n' +
    'Кошик ' + money(originalTotal) + ' → ' + b(money(originalTotal - saving)) +
    (share ? ' · −' + share : '') + '\n' +
    RULE + '\n';

  // Both names are clipped against one list, originals and replacements
  // together: a replacement is usually the same product from another brand, so
  // «Напій … зі смаком лимона» and «Напій … Малина-Лаванда» collide exactly
  // where it matters, and the guest is left comparing two identical rows.
  const clipped = clipAll(
    replacements.map((r) => r.originalName).concat(replacements.map((r) => r.replacementName)),
    34,
  );

  replacements.forEach((r, index) => {
    const on = selected.indexOf(index) !== -1;

    // The old line was «33,99 ₴ → 19,99 ₴ · −14,00 ₴ · 🎁 акція»: the third
    // number restated the first two and read as a third price. Now the prices
    // sit on the line of the product they belong to, the new one struck through
    // the old the way a price tag does, and the only bare number left is the
    // saving — which says «економія» beside it.
    const priceLine = s(money(r.originalPrice)) + ' → ' + b(money(r.replacementPrice));
    const facts = ['💰 економія ' + money(r.saving)];
    if (r.onPromotion) facts.push('за акцією');
    if (r.brand) facts.push('марка ' + esc(r.brand));

    text +=
      (on ? ON : OFF) + ' ' + b(index + 1 + '.') + ' ' + clipped[index] + '\n' +
      '      ➜ ' + clipped[replacements.length + index] + '\n' +
      '      ' + priceLine + '\n' +
      '      ' + facts.join(' · ') + '\n';
  });

  // «Торкніться позначки» named nothing the guest can see: the ✅ in the text is
  // not tappable, the buttons under the message are. Say which, and say what
  // happens after — the instruction is useless without the step it leads to.
  text +=
    RULE + '\n' +
    'ℹ️ Кнопки під повідомленням вмикають і вимикають заміни.\n' +
    'Залиште ✅ на тих, які застосувати, і натисніть ' + b('«Застосувати»') + '.\n';

  // Each caveat is its own paragraph. Run together they read as one long
  // disclaimer and get skipped as a block.
  const notes: string[] = [];
  // There used to be an unconditional note here explaining that Silpo does not
  // expose pack size in search, so it could only be checked from the cart. That
  // stopped being true in silpo-mcp-service v1.108.0: `displayRatio` is present
  // on every candidate (measured 361 of 361), so pack size is compared before a
  // replacement is ever proposed. A caveat that no longer applies is worse than
  // none — the rare line that genuinely could not be compared says so on its own
  // row instead.
  if (plan.slotExpired) {
    notes.push('⏰ <i>Слот доставки протух — наявність може відрізнятися.</i>');
  }
  if (plan.summary.bonusAvailable && plan.summary.bonusAvailable > 0) {
    notes.push('💳 <i>Балабонуси · ' + money(plan.summary.bonusAvailable) + ' — застосуйте при оформленні.</i>');
  }
  text += '\n' + notes.join('\n\n');

  const keyboard: Keyboard = replacements.map((r, i) => [
    {
      text: (selected.indexOf(i) !== -1 ? ON : OFF) + ' ' + (i + 1) + '. ' + trim(r.originalName, 26),
      callback_data: 't:' + plan.planId + ':' + i,
    },
  ]);

  keyboard.push([
    { text: BUTTON.apply + ' · ' + chosen.length, callback_data: 'apply:' + plan.planId },
    { text: BUTTON.details, callback_data: 'details:' + plan.planId },
  ]);
  keyboard.push([{ text: BUTTON.cancel, callback_data: 'cancel:' + plan.planId }]);

  return { text, keyboard };
}

/* ------------------------------------------------------------ details view */

/**
 * The full reasoning behind each line — progressive disclosure for the card.
 *
 * This is where the per-item detail the card sheds ends up: quantity, the exact
 * percentage, the model's reason, the pack-size caveat, the brand to block.
 */
export function buildDetailsCard(plan: Plan, planId: string): Card {
  const replacements = plan.replacements || [];
  const saving = plan.summary.saving || 0;

  let text =
    '🔍 <b>Деталі оптимізації</b>\n' +
    money(plan.summary.originalTotal) + ' → <b>' + money(plan.summary.originalTotal - saving) + '</b>' +
    ' · економія <b>' + money(saving) + '</b>\n' +
    RULE + '\n\n';

  // The details view is the one place a full product name is worth its space:
  // the guest opened it precisely to read what the card abbreviated.
  const blocks = replacements.map((r, i) => {
    const lines = [
      '<b>' + (i + 1) + '.</b> ' + esc(r.originalName),
      // Struck through here too, so the card and its details tell the same
      // visual story: this price is the one being left behind.
      '      ' + s(money(r.originalPrice)) + (r.quantity && r.quantity > 1 ? ' × ' + r.quantity : ''),
      '      ⬇',
      '      ' + esc(r.replacementName),
      '      <b>' + money(r.replacementPrice) + '</b>' + (r.onPromotion ? ' · 🎁 акція' : ''),
      '      💰 економія ' + money(r.saving) + (r.savingPct ? ' · −' + r.savingPct + '%' : ''),
    ];
    if (r.brand) lines.push('      🏷 марка ' + esc(r.brand));
    if (r.aiReason) lines.push('      💬 <i>' + esc(r.aiReason) + '</i>');
    // Rare now: fires when the two pack sizes are not comparable at all — a
    // count against a volume ("30шт" vs "1,5л") — not because the data is missing.
    if (r.verifySize) lines.push('      📦 <i>фасування не звірити — перевірю в кошику</i>');
    return lines.join('\n');
  });

  // Telegram caps a message at 4096 characters.
  const LIMIT = 3900;
  const kept: string[] = [];
  for (const block of blocks) {
    if ((text + kept.join('\n\n') + block).length > LIMIT) break;
    kept.push(block);
  }
  text += kept.join('\n\n');
  if (kept.length < blocks.length) {
    text += '\n\n<i>…і ще ' + (blocks.length - kept.length) + ' замін — не вмістилися в повідомлення.</i>';
  }

  return {
    text,
    keyboard: [
      [
        { text: BUTTON.apply, callback_data: 'apply:' + planId },
        { text: BUTTON.cancel, callback_data: 'cancel:' + planId },
      ],
    ],
  };
}

/* ------------------------------------------------------------- apply result */

interface ApplyResult {
  beforeTotal: number;
  afterTotal: number;
  actualSaving: number;
  promisedSaving: number;
  applied: number;
  failed?: Array<{ name: string; error: unknown }>;
  stockRejected?: Array<{ originalName: string; tried?: number }>;
  sizeRejected?: Array<{ originalName: string; originalRatio: string; newRatio: string; tried?: number }>;
  substituted?: Array<{ planned: string; used: string }>;
  vanished?: number;
  deselected?: number;
  loyalty?: { bonusAvailable?: number };
  validations?: Array<{ level: string; message: string; productName?: string | null }>;
}

/**
 * Silpo's cart validations, turned into something a guest can act on.
 *
 * `message` is an i18n key, not a sentence — a live cart returned
 * `product.offer.stock.max`, and the bot printed exactly that under
 * "Кошик потребує уваги". The useful part sits in `context`, which names the
 * product and its stock, and was being discarded.
 *
 * An unrecognised key never reaches the guest: it degrades to one plain line.
 * Warnings are shown only when they are known and actionable, so an unmapped
 * warning stays out of the way instead of adding noise.
 */
export function validationLines(
  validations: Array<{ level: string; message: string; productName?: string | null }>,
): string[] {
  const lines: string[] = [];
  let unknownErrors = 0;

  for (const v of validations) {
    const key = String(v.message || '');
    const name = v.productName ? ' — ' + v.productName : '';

    if (key.indexOf('product.offer.stock') === 0) {
      lines.push('Товар закінчився' + name + '. Приберіть або замініть його, щоб оформити замовлення.');
    } else if (key === 'order.adult.is_not_confirmed') {
      lines.push('У кошику є алкоголь — підтвердьте повноліття у застосунку «Сільпо».');
    } else if (key.indexOf('timeslot') !== -1) {
      lines.push('Час доставки минув — оберіть новий у застосунку «Сільпо».');
    } else if (key.indexOf('order.min') === 0) {
      lines.push('Сума замовлення менша за мінімальну для доставки.');
    } else if (v.level === 'error') {
      unknownErrors++;
    }
  }

  if (unknownErrors) {
    lines.push(
      unknownErrors === 1
        ? 'Одна позиція потребує уваги — перевірте кошик у застосунку «Сільпо».'
        : unknownErrors + ' позиції потребують уваги — перевірте кошик у застосунку «Сільпо».',
    );
  }
  return lines;
}

/**
 * A wish printed under the result, the way Silpo prints one at the bottom of a
 * till receipt.
 *
 * Written for this project in that spirit — the real receipt texts are Silpo's
 * own, produced by their in-house authors, and are not reproduced here.
 *
 * These lived in a template literal in `build.ts` until 2026-08-17, which broke
 * working rule 12: guest-facing copy there is escaped twice, and the array only
 * survived because every apostrophe in it happened to be the typographic `’`.
 * One ordinary `'` in a new line would have ended the JS string mid-array.
 */
export const WISHES = [
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
  'Смак дому не залежить від ціни. Але приємно, коли він ще й вигідний.',
];

/**
 * The guaranteed wish.
 *
 * Three branches react to a fact rather than to taste, so they stay in code:
 * code decides them for free and more reliably than a model would. Everything
 * else is drawn at random, and this is also the floor a failed model call falls
 * back to — see `wishPrompt`.
 */
export function pickWish(saving: number, applied: number): string {
  if (applied === 0) return 'Ваш кошик уже такий, як треба. Як і цей день.';
  if (saving >= 150) return 'Такою економією можна пишатися. Або мовчки купити собі каву.';
  if (saving > 0 && saving < 10) return 'Навіть маленька економія — це привід зробити собі щось приємне.';
  return WISHES[Math.floor(Math.random() * WISHES.length)];
}

/**
 * The prompt that writes a wish, kept here with the copy it produces.
 *
 * Working rule 12 puts the model prompt for guest-facing text in this file, not
 * in the engine: it is Ukrainian copy that a reader has to judge by tone, and it
 * belongs next to the static lines it replaces.
 *
 * The digit ban is the load-bearing rule. Without it the model reaches for the
 * saving it was told about, and an unverified number lands in a guest message
 * through a channel nothing else checks.
 */
export const WISH_SYSTEM_PROMPT = `Ти пишеш одне побажання під чеком супермаркету «Сільпо» — у дусі тих, що друкують на паперових чеках.

ПРАВИЛА:
- Рівно одне речення, до 90 символів.
- Тепло й просто, без пафосу і без звертання на «ти».
- ЖОДНИХ цифр, сум, відсотків і слів про знижку чи економію.
- Без емодзі.
- Можеш спертися на те, що людина купила, якщо з цього виходить гарний образ.
  Не перелічуй товари і не називай бренди.

МОВА — це найважливіше. Літературна українська, без русизмів і без калік.
Перевір кожне слово: «прохолода», а не «прохлада»; «святом», а не «святком».
Якщо сумніваєшся в слові — візьми простіше, у якому впевнений. Одне неправильне
слово гірше, ніж нудне побажання.

Відповідай виключно JSON: {"wish":"..."}`;

export function buildWishPrompt(itemNames: string[], applied: number): string {
  return [
    'Людина щойно оновила свій кошик. Ось що в ньому:',
    ...itemNames.slice(0, 20).map((n) => n.slice(0, 60)),
    '',
    `Замін застосовано: ${applied}`,
  ].join('\n');
}

/**
 * Accepts a model-written wish, or rejects it so the caller falls back.
 *
 * Deliberately strict: a wish is decoration, so anything questionable is thrown
 * away rather than repaired. A digit is an outright reject — that is the check
 * standing between a hallucinated figure and a guest.
 */
export function validateWish(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const wish = text.trim();
  if (wish.length < 10 || wish.length > 120) return null;
  if (/\d/.test(wish)) return null;
  // One emoji would put two on the line, which rule 11 rules out — the section
  // heading already carries 🧾.
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(wish)) return null;
  if (wish.includes('<') || wish.includes('>')) return null;
  return wish;
}

/**
 * What actually happened — read back from the cart, never predicted.
 *
 * The saving leads; the exceptions follow in plain sections. Each exception says
 * what was left alone, because "nothing changed" is the reassuring part.
 */
export function buildResultText(result: ApplyResult, wish: string): string {
  let text =
    '🎉 <b>Готово · зекономлено ' + money(result.actualSaving) + '</b>\n\n' +
    'Було ' + money(result.beforeTotal) + '\n' +
    'Стало <b>' + money(result.afterTotal) + '</b>\n' +
    RULE + '\n' +
    '✅ ' + result.applied + ' ' + plural(result.applied, 'заміна', 'заміни', 'замін') + ' застосовано';

  if (result.deselected) {
    text += '\n☐ ' + result.deselected + ' ' + plural(result.deselected, 'заміну', 'заміни', 'замін') + ' ви не обрали';
  }
  if (result.vanished) {
    text += '\n↩️ ' + result.vanished + ' ' + plural(result.vanished, 'позиції', 'позицій', 'позицій') + ' уже не було в кошику';
  }

  if (result.substituted && result.substituted.length) {
    text += '\n\n' + RULE + '\n🔄 <b>Взяв інший товар</b>\n';
    text += result.substituted
      .map((item) => '· замість ' + esc(item.planned) + '\n  взяв ' + esc(item.used))
      .join('\n');
  }

  if (result.stockRejected && result.stockRejected.length) {
    text += '\n\n' + RULE + '\n🚫 <b>Доступної заміни не знайшов</b>\n';
    text += result.stockRejected
      .map((item) =>
        '· ' + esc(item.originalName) + '\n  ' +
        (item.tried && item.tried > 1
          ? 'перебрав ' + item.tried + ' варіанти — усі виявились недоступні'
          : 'залишив оригінал'))
      .join('\n');
    text += '\n\n<i>У пошуку «Сільпо» вони значилися доступними, але кошик показав інше. Кошик тут головніший.</i>';
  }

  if (result.sizeRejected && result.sizeRejected.length) {
    text += '\n\n' + RULE + '\n📦 <b>Заміни того ж об’єму не знайшов</b>\n';
    text += result.sizeRejected
      .map((item) =>
        '· ' + esc(item.originalName) + ' (' + esc(item.originalRatio) + ')\n  найближче було ' +
        esc(item.newRatio) + ' — не підійшло' + (item.tried && item.tried > 1 ? ', перебрав ' + item.tried + ' варіанти' : '') +
        '\n  залишив оригінал')
      .join('\n');
    // Reworded once search started exposing pack size: the check is no longer
    // "the only place I can see it", it is the second, authoritative look. What
    // the guest needs to understand is unchanged — a smaller pack is not a saving.
    text += '\n\n<i>Фасування в кошику виявилося не тим, що показував пошук. Менша упаковка за меншу ціну це не економія: дві такі коштуватимуть дорожче за оригінал.</i>';
  }

  if (result.failed && result.failed.length) {
    text += '\n\n' + RULE + '\n⚠️ <b>Не вдалося застосувати</b>\n';
    text += result.failed
      .map((item) => '· ' + esc(item.name) + '\n  <i>' + esc(String(item.error).slice(0, 140)) + '</i>')
      .join('\n');
  }

  if (Math.abs(result.actualSaving - result.promisedSaving) > 1) {
    text += '\n\nℹ️ <i>Фактична економія відрізняється від прогнозу — ціни або наявність змінилися.</i>';
  }

  const bonus = (result.loyalty && result.loyalty.bonusAvailable) || 0;
  if (bonus > 0) {
    text += '\n\n💳 Балабонуси · ' + money(bonus) + ' — застосуйте при оформленні.';
  }

  const issues = validationLines(result.validations || []);
  if (issues.length) {
    text += '\n\n⚠️ <b>Кошик потребує уваги</b>\n' + issues.map((line) => esc(line)).join('\n');
  }

  // The receipt wish closes the message the way a till slip closes a purchase.
  text += '\n\n' + RULE + '\n🧾 <b>Побажання до вашого чека</b>\n<i>' + esc(wish) + '</i>';

  return text;
}

/* ------------------------------------------------------------------ errors */

/**
 * Failures, mapped to what the guest can do next.
 *
 * No emoji and no apology theatre: a calm sentence and the one action that
 * helps. The server's own wording is preserved where it is the only honest
 * explanation available.
 */
export function buildErrorText(kind: string): string {
  if (kind === 'auth') {
    return '🔐 <b>Доступ втратив силу</b>\n\nУвійдіть у «Сільпо» ще раз — /connect';
  }
  if (kind === 'forbidden') {
    return '⛔ Ваш акаунт «Сільпо» не має доступу до цієї операції.';
  }
  if (kind === 'rate') {
    return '⏳ Забагато запитів до «Сільпо». Зачекайте хвилину і спробуйте ще раз.';
  }
  if (kind === 'upstream') {
    return '🔧 Сервіс «Сільпо» тимчасово недоступний. Спробуйте за кілька хвилин.';
  }
  if (kind === 'config') {
    return '⚙️ Помилка конфігурації бота. Зверніться до адміністратора.';
  }
  if (kind === 'cart') {
    return '🛒 «Сільпо» не змогло виконати операцію з кошиком.\n\nПеревірте кошик у застосунку та спробуйте ще раз.';
  }
  return '😔 Щось пішло не так. Спробуйте ще раз — /optimize';
}

/* ------------------------------------------------------- screen transport */

interface ScreenContext {
  chatId: number | string;
  messageId?: number | null;
  callbackQueryId?: string | null;
}

export interface ScreenRequest {
  method: 'sendMessage' | 'editMessageText' | 'answerCallbackQuery';
  body: Record<string, unknown>;
}

/**
 * Every Bot API message body, built in one place.
 *
 * `parse_mode` is not optional here and that is the point: a body assembled by
 * hand without it renders `<b>Аналізую кошик…</b>` literally, tags and all, and
 * the omission is invisible until a guest sees it. One node was built that way
 * and shipped exactly that. Nothing constructs a message body directly any more.
 */
export function message(chatId: number | string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { chat_id: chatId, text, parse_mode: 'HTML', ...extra };
}

/**
 * Turns a card into the Bot API calls that put it on screen.
 *
 * Navigation between screens edits the message the guest tapped instead of
 * appending a new one — that is the difference between an app and a chat log,
 * and it keeps the history from filling with dead menus. A command has no
 * message to edit, so it sends.
 *
 * The callback is always acknowledged first: an unanswered tap leaves a spinner
 * on the button, which reads as a hang and invites a second press.
 */
export function screenRequests(card: Card, ctx: ScreenContext, toast?: string): ScreenRequest[] {
  const requests: ScreenRequest[] = [];

  if (ctx.callbackQueryId) {
    requests.push({
      method: 'answerCallbackQuery',
      body: toast
        ? { callback_query_id: ctx.callbackQueryId, text: toast }
        : { callback_query_id: ctx.callbackQueryId },
    });
  }

  const body = message(ctx.chatId, card.text, { reply_markup: { inline_keyboard: card.keyboard } });

  if (ctx.callbackQueryId && ctx.messageId) {
    body.message_id = ctx.messageId;
    requests.push({ method: 'editMessageText', body });
  } else {
    requests.push({ method: 'sendMessage', body });
  }

  return requests;
}

/** The force_reply prompt: Telegram pre-fills the reply, so the guest just types. */
export function brandPromptRequest(ctx: ScreenContext): ScreenRequest[] {
  const requests: ScreenRequest[] = [];
  if (ctx.callbackQueryId) {
    requests.push({ method: 'answerCallbackQuery', body: { callback_query_id: ctx.callbackQueryId } });
  }
  requests.push({
    method: 'sendMessage',
    body: message(ctx.chatId, UI.brandPrompt, {
      reply_markup: { force_reply: true, input_field_placeholder: 'Назва марки' },
    }),
  });
  return requests;
}

/**
 * First line of the brand prompt, used by `Route Request` to recognise a reply
 * to it. Kept next to the prompt so the two cannot drift apart.
 */
export const BRAND_PROMPT_MARKER = UI.brandPrompt.split('\n')[0];

/* --------------------------------------------------------------- keyboards */

export function logoutKeyboard(): Keyboard {
  return [
    [
      { text: BUTTON.logoutYes, callback_data: 'logout:yes' },
      { text: BUTTON.logoutNo, callback_data: 'logout:no' },
    ],
  ];
}

/* ----------------------------------------------------------------- helpers */

/** Ukrainian has three plural forms; "12 товарів" reads wrong as "12 товар". */
function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(count) % 100;
  if (n >= 11 && n <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Clips a whole list of names at once, and escapes them.
 *
 * Clipping one name is easy; clipping a list is not. Silpo writes a family of
 * products as one long prefix and one distinguishing word — «Напій сокoвмісний
 * Моршинська зі смаком лимона» against «…зі смаком яблука» — and the word that
 * tells them apart sits past any sensible cut. Clipped independently they become
 * two identical rows, which is worse than a wrapped line.
 *
 * So the clip is decided by the list: a result that collides with another one is
 * thrown away and both items keep their full name. Ambiguity is a property of
 * the set, not of a single string, and no amount of cleverness inside one name
 * can detect it.
 */
function clipAll(names: string[], max: number): string[] {
  const clipped = names.map((name) => trim(name, max));
  const count: Record<string, number> = {};
  for (const name of clipped) count[name] = (count[name] || 0) + 1;
  return names.map((name, index) => esc(count[clipped[index]] > 1 ? name : clipped[index]));
}

/** Button labels are clipped by Telegram, so clip them where a word ends. */
function trim(text: string, max: number): string {
  const value = String(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max - 8 ? cut.slice(0, space) : cut).trim() + '…';
}
