/**
 * Everything the model is told, and nothing that interprets what it answers.
 *
 * The copy here is Ukrainian because it is read *by* the model that writes
 * Ukrainian for the guest, which working rule 12 keeps in the same language as
 * the strings it produces. It is not guest-facing copy, so it does not belong
 * in `../ui.ts`.
 *
 * Sizes are handed over as the raw strings Silpo returns ("1,5л", "180г") and
 * the model compares them directly — no parser stands between it and the label.
 * Prices are handed over already reduced to a common basis, because the one
 * thing the model must never do is divide (working rule 3).
 */

import type { CartItem, ProductCandidate } from '../types.ts';
import { round2, unitPrice } from './product-utils.ts';
import { MODES, resolveMode, sizeBand } from './optimization-modes.ts';

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
