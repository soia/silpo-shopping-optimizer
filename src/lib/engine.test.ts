/**
 * Offline tests for the parts of the engine that must never be uncertain.
 *
 *   npm test
 *
 * Nothing here talks to Silpo or to the model. That is the point: the engine's
 * judgements are the model's and are not reproducible between runs (measured
 * spreads of 6-40% on identical input), but its *arithmetic* and its *gate* are
 * code, and code that decides what a guest is charged has to be pinned down.
 *
 * The products below are real rows from a live cart and its candidate pools,
 * copied out of a `npm run optimize -- --dump` fixture. Two of them are the pair
 * that produced the defect this suite exists to prevent regressing:
 * «Балик Ювілейний» is sold by weight at 799 per kilogram, «Полядвиця Глобино»
 * is a 100 g pack at 74.99, and the engine reported swapping one for the other
 * as a 90.61% saving.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rejectReason,
  filterCandidates,
  unitPrice,
  fatPercent,
  computeSaving,
  buildPlan,
  applyAlternate,
  sizeBand,
  minConfidence,
  confidentAt,
  resolveMode,
  selectSystemPrompt,
  buildSelectPrompt,
  MIN_SAVING,
  clipReason,
  type SelectedItem,
} from './optimizer/index.ts';
import {
  defaultSelection,
  buildSelectionCard,
  buildAlternativesCard,
  buildCartCard,
  buildDetailsCard,
  buildResultText,
  getProductUrl,
  productLink,
  message,
  screenRequests,
} from './ui.ts';
import type { CartItem, ProductCandidate } from './types.ts';

const BALANCED = sizeBand('balanced');

function cartItem(over: Partial<CartItem> = {}): CartItem {
  return {
    productId: 'p1', companyId: 'c1', branchId: 'b1', slug: 'slug-1',
    name: 'Молоко Яготинське 2,5%', ratio: '900г', quantity: 1,
    price: 52.9, subTotal: 52.9, subDiscount: 0, total: 52.9,
    stock: 10, weighted: false, addToBasketStep: 1,
    ...over,
  };
}

function candidate(over: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: 'p2', name: 'Молоко Premia 2,5%', slug: 'slug-2',
    price: 44.9, stock: 10, available: true, weighted: false,
    displayRatio: '900г', companyId: 'c1', branchId: 'b1',
    ...over,
  };
}

/* ------------------------------------------------------------ the hard gate */

test('a comparable, cheaper candidate is accepted', () => {
  assert.equal(rejectReason(cartItem(), candidate(), BALANCED), null);
});

test('the same product is never its own replacement', () => {
  // similar_products returns the original in every pool it produces.
  assert.equal(rejectReason(cartItem(), candidate({ id: 'p1' }), BALANCED), 'same product');
});

test('a candidate at the same price is not a replacement', () => {
  assert.equal(rejectReason(cartItem(), candidate({ price: 52.9 }), BALANCED), 'not cheaper');
});

test('a dearer candidate is not a replacement', () => {
  assert.equal(rejectReason(cartItem(), candidate({ price: 60 }), BALANCED), 'not cheaper');
});

test('a saving below the floor is not worth offering', () => {
  // A live run proposed changing the flavour of a sausage to save 0.60 UAH.
  const item = cartItem({ price: 65.99, quantity: 0.3, ratio: '100г' });
  const swap = candidate({ price: 63.99, displayRatio: '100г' });
  assert.equal(computeSaving(item, swap).saving, 0.6);
  assert.equal(rejectReason(item, swap, BALANCED), 'saving below the floor');
});

test('weighted and packaged prices are never compared', () => {
  // The real pair. 799 is per kilogram; 74.99 is one 100 g pack. Both carry the
  // label "100г", so nothing but the weighted flag tells them apart.
  const balyk = cartItem({
    name: 'Балик «Ювілейний» свинячий к/в в/ґ', weighted: true,
    ratio: '100г', price: 799, quantity: 0.1, total: 79.9,
  });
  const polyadvytsia = candidate({
    name: 'Полядвиця Глобино З печі зі свинини в/к в/ґ',
    weighted: false, displayRatio: '100г', price: 74.99,
  });

  assert.equal(rejectReason(balyk, polyadvytsia, BALANCED), 'price basis differs');
  // What the engine used to report for this pair, kept as the shape of the bug.
  assert.equal(computeSaving(balyk, polyadvytsia).savingPct, 90.61);
});

test('two weighted products of the same kind stay comparable', () => {
  const balyk = cartItem({ weighted: true, ratio: '100г', price: 799, quantity: 0.1 });
  const ham = candidate({ weighted: true, displayRatio: '100г', price: 649 });
  assert.equal(rejectReason(balyk, ham, BALANCED), null);
  assert.equal(computeSaving(balyk, ham).saving, 15);
});

test('a different grade is rejected on the percentage in the name', () => {
  const butter = cartItem({ name: 'Масло «Ферма» Екстра 82%', price: 99 });
  assert.equal(
    rejectReason(butter, candidate({ name: 'Масло селянське 72,5%', price: 79 }), BALANCED),
    'different grade',
  );
  // A rounding difference on the label is not a different grade.
  assert.equal(
    rejectReason(butter, candidate({ name: 'Масло «Президент» 82,5%', price: 79 }), BALANCED),
    null,
  );
  // Most names carry no percentage at all, and silence is not disagreement.
  assert.equal(rejectReason(butter, candidate({ name: 'Масло «Премія»', price: 79 }), BALANCED), null);
});

test('a smaller pack at a lower ticket price is not a saving', () => {
  // Silpo reuses one name across pack sizes, which is what makes a lower price
  // look like a bargain when it is only a smaller tub.
  const sourCream = cartItem({ name: 'Сметана Яготинська 15% стакан', ratio: '300г', price: 52.99 });

  // Inside the band, so the band cannot save us: 45.99 for 250 g is 0.1840 per
  // gram against the original's 0.1766. Cheaper to buy, dearer to eat.
  const shrunk = candidate({ name: 'Сметана Яготинська 15% стакан', displayRatio: '250г', price: 45.99 });
  assert.equal(rejectReason(sourCream, shrunk, BALANCED), 'worse per unit');

  // 180 g is 0.6 of the original — balanced refuses it on size alone, and `max`
  // allows that difference. This pair is the whole argument for keeping the
  // per-unit rule: without it `max` would call this a 38% saving.
  const tiny = candidate({ name: 'Сметана Яготинська 15% стакан', displayRatio: '180г', price: 32.99 });
  assert.equal(rejectReason(sourCream, tiny, sizeBand('balanced')), 'pack size out of band');
  assert.equal(rejectReason(sourCream, tiny, sizeBand('max')), 'worse per unit');

  // The same pack size at a lower price is exactly what the product is for.
  const same = candidate({ name: 'Сметана Простонаше 15%', displayRatio: '300г', price: 47.99 });
  assert.equal(rejectReason(sourCream, same, BALANCED), null);
});

test('a pack far outside the mode band is rejected before the model sees it', () => {
  const wine = cartItem({ name: 'Вино Castillo Lagomar red', ratio: '0,75л', price: 99 });
  const small = candidate({ name: 'Вино Beau-Rivage red', displayRatio: '0,187л', price: 94.99 });
  assert.equal(rejectReason(wine, small, BALANCED), 'pack size out of band');

  // Conservative refuses a difference balanced allows; max allows one balanced
  // refuses. The mode has to reach the gate, not only the prompt.
  const litre = cartItem({ name: 'Сік «Садочок»', ratio: '1л', price: 60 });
  const bigger = candidate({ name: 'Сік «Смачненький»', displayRatio: '1,2л', price: 55 });
  assert.equal(rejectReason(litre, bigger, sizeBand('conservative')), 'pack size out of band');
  assert.equal(rejectReason(litre, bigger, sizeBand('balanced')), null);

  const half = candidate({ name: 'Сік «Смачненький»', displayRatio: '0,7л', price: 39 });
  assert.equal(rejectReason(litre, half, sizeBand('balanced')), 'pack size out of band');
  assert.equal(rejectReason(litre, half, sizeBand('max')), null);
});

test('an unavailable or understocked candidate never reaches the prompt', () => {
  const item = cartItem({ quantity: 3 });
  assert.equal(rejectReason(item, candidate({ available: false }), BALANCED), 'unavailable');
  assert.equal(rejectReason(item, candidate({ stock: 2 }), BALANCED), 'not enough stock');
});

test('filterCandidates keeps the survivors and counts the rest', () => {
  const item = cartItem();
  const { kept, rejected } = filterCandidates(item, [
    candidate({ id: 'p1' }),
    candidate({ id: 'p3', price: 99 }),
    candidate({ id: 'p4', weighted: true }),
    candidate({ id: 'p5' }),
  ], BALANCED);

  assert.deepEqual(kept.map((c) => c.id), ['p5']);
  assert.deepEqual(rejected, { 'same product': 1, 'not cheaper': 1, 'price basis differs': 1 });
});

/* --------------------------------------------------------------- unit price */

test('unit price reads the basis from the weighted flag', () => {
  // Compared with a tolerance: these are raw IEEE doubles on purpose. The gate
  // compares two of them against each other and never shows one to a guest, so
  // rounding here would only throw away precision the comparison wants.
  const near = (actual: ReturnType<typeof unitPrice>, value: number, unit: string) => {
    assert.ok(actual, 'expected a unit price');
    assert.equal(actual!.unit, unit);
    assert.ok(Math.abs(actual!.value - value) < 1e-9, `${actual!.value} vs ${value}`);
  };

  // Per kilogram for weighted lines, per pack for everything else.
  near(unitPrice({ price: 799, weighted: true, ratio: '100г' }), 0.799, 'g');
  near(unitPrice({ price: 74.99, weighted: false, displayRatio: '100г' }), 0.7499, 'g');
  near(unitPrice({ price: 99, displayRatio: '0,75л' }), 0.132, 'ml');
  // An unparseable pack is reported as unknown, never guessed at.
  assert.equal(unitPrice({ price: 49.99, displayRatio: '30шт', name: 'Пакети' }), null);
});

test('fat percentage is read out of the name, Cyrillic and all', () => {
  assert.equal(fatPercent('Молоко Яготинське 2,5% 900г'), 2.5);
  assert.equal(fatPercent('Масло «Ферма» Екстра 82%'), 82);
  assert.equal(fatPercent('Ковбаса Алан Лікарська'), null);
});

/* ---------------------------------------------------------------- arithmetic */

test('savings are computed per line, including weighted and multi-buy lines', () => {
  // Plain single item.
  assert.deepEqual(computeSaving({ price: 52.9, quantity: 1 }, { price: 44.9 }), { saving: 8, savingPct: 15.12 });
  // Quantity above one multiplies, and the percentage does not.
  assert.deepEqual(computeSaving({ price: 52.9, quantity: 3 }, { price: 44.9 }), { saving: 24, savingPct: 15.12 });
  // The weighted line that the model used to get wrong: 0.3 kg, not 0.3 packs.
  assert.deepEqual(computeSaving({ price: 839, quantity: 0.3 }, { price: 399 }), { saving: 132, savingPct: 52.44 });
  // A free item cannot be a percentage of itself.
  assert.deepEqual(computeSaving({ price: 0, quantity: 1 }, { price: 0 }), { saving: 0, savingPct: 0 });
});

function selection(confidence: number, over: Partial<SelectedItem['selection'] & object> = {}) {
  return { chosen: 0, accept: true, confidence, reason: 'причина', verifySize: false, alternates: [], ...over };
}

test('the plan states promotions and coupons without adding them to the saving', () => {
  const item = cartItem({ price: 52.9, quantity: 2, total: 105.8 });
  const selected: SelectedItem[] = [{ item, candidate: candidate({ oldPrice: 60 }), selection: selection(0.9) }];

  const plan = buildPlan([item], selected, {
    loyalty: { bonusAvailable: 34.24 },
    cartDiscount: 344.51,
    couponsAvailable: 2,
    mode: 'balanced',
  });

  assert.equal(plan.summary.saving, 16);
  assert.equal(plan.summary.optimizedTotal, 89.8);
  // Money the guest already has, stated beside the saving and not inside it.
  assert.equal(plan.summary.cartDiscount, 344.51);
  assert.equal(plan.summary.couponsAvailable, 2);
  assert.equal(plan.summary.bonusAvailable, 34.24);
  assert.equal(plan.summary.promotionsUsed, 1);
});

test('a saving below the floor is rejected even when the model accepted it', () => {
  const item = cartItem({ price: 10, quantity: 1, total: 10 });
  const plan = buildPlan([item], [{ item, candidate: candidate({ price: 9 }), selection: selection(0.95) }], {});
  assert.equal(plan.replacements.length, 0);
  assert.equal(plan.rejectedByAI?.length, 1);
  assert.ok(MIN_SAVING > 1);
});

/* --------------------------------------------------------------- confidence */

test('each mode has its own bar for offering and for ticking', () => {
  assert.equal(minConfidence('conservative'), 0.75);
  assert.equal(confidentAt('conservative'), 0.85);
  assert.equal(minConfidence('balanced'), 0.6);
  assert.equal(confidentAt('balanced'), 0.8);
  assert.equal(minConfidence('max'), 0.55);
  // Bolder means shown more, never applied more: the tick bar does not drop.
  assert.equal(confidentAt('max'), confidentAt('balanced'));
});

test('confidence decides whether a line is offered, and whether it is ticked', () => {
  const item = cartItem();
  const plan = (confidence: number, mode: string) =>
    buildPlan([item], [{ item, candidate: candidate(), selection: selection(confidence) }], { mode });

  assert.equal(plan(0.5, 'balanced').replacements.length, 0, 'below the bar: not offered at all');

  const cautious = plan(0.65, 'balanced');
  assert.equal(cautious.replacements.length, 1, 'above the bar: offered');
  assert.equal(cautious.replacements[0].confident, false, 'but not ticked');
  assert.deepEqual(defaultSelection(cautious.replacements), []);

  const sure = plan(0.9, 'balanced');
  assert.equal(sure.replacements[0].confident, true);
  assert.deepEqual(defaultSelection(sure.replacements), [0]);

  // The same answer is merely plausible in conservative and sure in balanced.
  assert.equal(plan(0.82, 'conservative').replacements[0].confident, false);
  assert.equal(plan(0.82, 'balanced').replacements[0].confident, true);
  assert.equal(plan(0.7, 'conservative').replacements.length, 0);
});

test('a model rejection is a rejection whatever its confidence', () => {
  const item = cartItem();
  const plan = buildPlan(
    [item],
    [{ item, candidate: candidate(), selection: selection(0.99, { accept: false }) }],
    {},
  );
  assert.equal(plan.replacements.length, 0);
});

/* --------------------------------------------------------------------- mode */

test('legacy pack-size presets resolve to the mode carrying the same band', () => {
  assert.equal(resolveMode('strict'), 'conservative');
  assert.equal(resolveMode('normal'), 'balanced');
  assert.equal(resolveMode('loose'), 'max');
  assert.equal(resolveMode('balanced'), 'balanced');
  // Anything unrecognised falls back to the default, never to the boldest mode.
  assert.equal(resolveMode(''), 'balanced');
  assert.equal(resolveMode(null), 'balanced');
  assert.equal(resolveMode('something-new'), 'balanced');
});

test('the mode reaches the prompt, and the prompt stays cacheable', () => {
  const conservative = selectSystemPrompt('conservative');
  const max = selectSystemPrompt('max');

  assert.ok(conservative.includes('0,95'), 'the band is stated in the prompt');
  assert.ok(max.includes('1,7'));
  assert.ok(conservative.includes('той самий бренд'));
  assert.ok(max.includes('Бренд не має значення'));
  // The JSON examples in the prompt contain braces of their own, so this looks
  // for the placeholders by name rather than for the character.
  for (const placeholder of ['{MIN}', '{MAX}', '{BRAND}']) {
    assert.ok(!conservative.includes(placeholder), `${placeholder} was never filled in`);
  }

  // Byte-identical across the calls of one run is what makes the system prompt
  // cacheable, and it has to stay comfortably over the 1024-token minimum —
  // roughly 3 characters a token for Ukrainian, so this is a floor with room.
  assert.equal(selectSystemPrompt('max'), max);
  assert.ok(max.length > 3000, `system prompt is ${max.length} characters`);
});

test('the prompt hands the model comparable numbers, never a division to do', () => {
  const balyk = cartItem({
    name: 'Балик «Ювілейний»', weighted: true, ratio: '100г', price: 799, quantity: 0.1,
  });
  const prompt = buildSelectPrompt(balyk, [candidate({ name: 'Шинка Argal', weighted: true, price: 649 })]);

  assert.ok(prompt.includes('ваговий, ціна за кг'));
  assert.ok(prompt.includes('за 100 г: 79.9'), 'the original, per 100 g');
  assert.ok(prompt.includes('за 100 г: 64.9'), 'the candidate, on the same basis');
});

/* ----------------------------------------------------------------------- ui */

test('a card with nothing ticked offers the saving rather than promising zero', () => {
  const plan = {
    planId: 'x', mode: 'balanced',
    summary: { originalTotal: 1000, itemsAnalyzed: 9, saving: 41 },
    replacements: [
      { originalName: 'А', replacementName: 'Б', originalPrice: 100, replacementPrice: 75, saving: 25, confident: false, aiReason: 'причина' },
      { originalName: 'В', replacementName: 'Г', originalPrice: 50, replacementPrice: 34, saving: 16, confident: false, aiReason: 'причина' },
    ],
  };
  const card = buildSelectionCard(plan, defaultSelection(plan.replacements));

  assert.ok(card.text.includes('Можлива економія'));
  assert.ok(card.text.includes('41,00'));
  assert.ok(!card.text.includes('Заощадите 0,00'));
  // The legend, not a per-row marker: the empty box is explained once, under
  // the list, and the row itself carries only facts about the goods.
  assert.ok(card.text.includes('тут вирішувати вам'));
  assert.ok(!card.text.includes('економія 25,00 ₴ ·'), 'no marker trails the facts line');

  // A blank line between items. It is the only thing separating two blocks of
  // four near-identical indented lines, so it is easy to lose to a later edit
  // of the length budget — which is exactly why it is asserted here.
  assert.ok(card.text.includes('\n\n☐ <b>2.</b>'), 'items are separated by a blank line');
  assert.ok(card.text.includes('Режим · збалансований'));
});

test('a long card is trimmed to something Telegram will accept', () => {
  const plan = {
    planId: 'big', mode: 'max',
    summary: { originalTotal: 9000, itemsAnalyzed: 40, saving: 900, bonusAvailable: 34.24 },
    replacements: Array.from({ length: 40 }, (_, index) => ({
      originalName: `Ковбаса «Укрпромпостач» «Домашня» варена в/ґ, нарізка ${index}`,
      replacementName: `Ковбаса Алан «Особлива» варено-копчена в/ґ, нарізка ${index}`,
      originalPrice: 129.9, replacementPrice: 99.9, saving: 30, confident: true,
      aiReason: 'Та сама варена ковбаса в нарізці, те саме фасування, нижча ціна за 100 г',
    })),
  };
  const card = buildSelectionCard(plan, defaultSelection(plan.replacements));

  assert.ok(card.text.length <= 4096, `card is ${card.text.length} characters`);
  assert.ok(card.text.includes('і ще'), 'the guest is told the list was cut');
  // The instruction and the stats survive the trim: they are what the buttons
  // below the message mean.
  assert.ok(card.text.includes('Застосувати'));
  assert.ok(card.text.includes('Перевірено 40'));
});

test('callback data stays inside Telegram cap on a large plan', () => {
  const plan = {
    planId: 'k3f9a1zx4b', summary: { originalTotal: 100 },
    replacements: Array.from({ length: 30 }, (_, index) => ({
      originalName: 'Дуже довга назва товару, яку Telegram однаково обріже ' + index,
      replacementName: 'Інша дуже довга назва товару ' + index,
      originalPrice: 10, replacementPrice: 5, saving: 5, confident: true,
    })),
  };
  for (const row of buildSelectionCard(plan, [0]).keyboard) {
    for (const button of row) {
      if (button.callback_data) {
        assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
      }
    }
  }
});

/* ------------------------------------------------------- runners-up */

test('a runner-up carries its own verdict, not the top pick apology', () => {
  // The kefir case from a live card: Silpo could not confirm the first choice,
  // the second was promoted, and it used to arrive saying «Запасний варіант —
  // основний виявився недоступним» at a confidence floored to 0.6 — unexplained
  // and unticked however good it was.
  const item = cartItem({ name: 'Кефір ПростоНаше 2,5% пет', price: 66.49, ratio: '900г' });
  const alternate = {
    index: 1,
    reason: 'Той самий кефір 2,5%, інша марка, дешевше',
    confidence: 0.88,
  };

  const promoted = {
    item,
    candidate: candidate({ name: 'Кефір «Яготинський» 2,5% п/е', price: 59.99, displayRatio: '900г' }),
    selection: selection(0.9, { reason: 'про основний вибір', alternates: [alternate] }),
  };
  // What the pipeline does when it falls through to the runner-up.
  promoted.selection = { ...promoted.selection, reason: alternate.reason, confidence: alternate.confidence };

  const plan = buildPlan([item], [promoted], { mode: 'balanced' });
  assert.equal(plan.replacements[0].aiReason, 'Той самий кефір 2,5%, інша марка, дешевше');
  assert.equal(plan.replacements[0].confident, true, 'a good runner-up is ticked like any other');
  assert.deepEqual(defaultSelection(plan.replacements), [0]);
});

test('a reason too long to fit one phone line is cut at a word', () => {
  // The live card that wrapped to the left margin and broke the block.
  const long = 'Той самий безлактозний кисломолочний сир 5%, схоже фасування, дешевше за акцією';
  const clipped = clipReason(long);

  assert.ok(clipped.length <= 61, `${clipped.length} characters`);
  assert.ok(clipped.endsWith('…'));
  assert.ok(!clipped.includes('фасуванн…'), 'never cut mid-word');
  // Short reasons pass through untouched, ellipsis and all.
  assert.equal(clipReason('Ті самі вершки 15%, однакове фасування 200г, дешевше'),
    'Ті самі вершки 15%, однакове фасування 200г, дешевше');
  assert.equal(clipReason(null), '');
});

test('a stale delivery slot is never mentioned on any screen', () => {
  // Two separate warnings used to fire on it, and both are gone. The run
  // fetches a fresh slot before it asks Silpo anything, so «availability may
  // differ» described a problem already worked around; and on the cart screen
  // «pick a new slot or this will not check out» was true for everyone who
  // filled a basket yesterday, because choosing a slot *is* checking out.
  const plan = {
    planId: 'x', mode: 'balanced',
    summary: { originalTotal: 1000, itemsAnalyzed: 9 },
    replacements: [{
      originalName: 'А', replacementName: 'Б', originalPrice: 100,
      replacementPrice: 75, saving: 25, confident: true, aiReason: 'причина',
    }],
  };
  assert.ok(!buildSelectionCard(plan, [0]).text.includes('протух'));
  assert.ok(!buildSelectionCard({ ...plan, replacements: [] }, []).text.includes('протух'));
  assert.ok(!buildCartCard([{ name: 'Молоко', price: 30 }], 30, { discount: 4 }).text.includes('протух'));
});

test('a full cart with the blank lines still fits one Telegram message', () => {
  // buildCartCard caps the list at 30 items but has no character budget of its
  // own, and the gap between items pushed it 29 lines taller. These are the
  // longest real names in the fixture, kept unclipped by a deliberate collision.
  const lines = Array.from({ length: 30 }, (_, index) => ({
    name: `Оселедець Norsk Delikatesse норвезький молодий слабосолоний, філе в упаковці ${index}`,
    price: 379, oldPrice: 479, ratio: '100г', quantity: 2,
  }));
  const card = buildCartCard(lines, 11370, { discount: 3000, bonusAvailable: 34.24 });

  assert.ok(card.text.length <= 4096, `cart card is ${card.text.length} characters`);
  assert.ok(card.text.includes('\n\n2. '), 'items are separated by a blank line');
});

/* ------------------------------------------------------------ product links */

/**
 * The product page, and why it is built rather than fetched.
 *
 * `silpo_get_product_details` returns the page as `product.url`, and on every
 * product checked live it is this prefix plus the product's own slug — checked
 * against «fintonic» too, which has no trailing id, so the rule is the slug and
 * not the number. Every payload the bot already reads carries a slug, so no
 * line costs an MCP call to become clickable.
 */
test('a product page is the canonical Silpo URL for the slug', () => {
  assert.equal(
    getProductUrl({ slug: 'proshutto-galbani-krudo-1027028' }),
    'https://silpo.ua/product/proshutto-galbani-krudo-1027028',
  );
  // Live-verified: a slug with no trailing product id resolves the same way.
  assert.equal(getProductUrl({ slug: 'fintonic' }), 'https://silpo.ua/product/fintonic');
  assert.equal(getProductUrl(cartItem({ slug: 'slug-1' })), 'https://silpo.ua/product/slug-1');
});

test('no slug means no link, never a guessed one', () => {
  // Working rule 2: a fabricated identifier lands the guest on «Resource not
  // found», which is worse than a name that simply is not tappable.
  for (const product of [undefined, null, {}, { slug: null }, { slug: '' }, { slug: '   ' }]) {
    assert.equal(getProductUrl(product as { slug?: string | null }), null);
  }
});

test('anything outside Silpo slug alphabet is refused rather than linked', () => {
  const refused = [
    'Молоко Яготинське',                         // a name that leaked into the field
    'https://evil.example/x',                    // an absolute URL
    '../../admin',                               // a path fragment
    'slug with spaces',
    'Slug-With-Capitals',
    'slug"onmouseover=x',                        // an attribute break-out
    'slug-1?utm=1',
    'slug-1#frag',
  ];
  for (const slug of refused) assert.equal(getProductUrl({ slug }), null, slug);
});

test('a product name is escaped inside its link, and reads back unchanged', () => {
  const name = 'Молоко <2.5%> & вершки "Преміум" — 1’л';
  const html = productLink(name, { slug: 'moloko-2-5-123' });

  assert.equal(
    html,
    '<a href="https://silpo.ua/product/moloko-2-5-123">' +
      'Молоко &lt;2.5%&gt; &amp; вершки "Преміум" — 1’л</a>',
  );
  // What Telegram paints is the original name, character for character.
  const shown = html.replace(/<[^>]+>/g, '')
    .split('&lt;').join('<').split('&gt;').join('>').split('&amp;').join('&');
  assert.equal(shown, name);
  // No bare < > & survives outside a tag — Telegram rejects the whole send.
  assert.ok(!/[<>&]/.test(html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt);/g, '')));
});

test('a name with no link is plain escaped text, not an empty anchor', () => {
  const html = productLink('Кава "Jacobs" <міцна> & Co', null);
  assert.equal(html, 'Кава "Jacobs" &lt;міцна&gt; &amp; Co');
  assert.ok(!html.includes('<a'));
  assert.ok(!/undefined|null/.test(html));
});

test('cart lines link when they have a slug and stay plain text when they do not', () => {
  const card = buildCartCard(
    [
      { name: 'Молоко <Яготинське> & Co', slug: 'moloko-iahotynske-1', price: 52.9, ratio: '900г' },
      { name: 'Сметана', price: 32.99, ratio: '350г' },
    ],
    85.89,
  );

  assert.ok(card.text.includes('<a href="https://silpo.ua/product/moloko-iahotynske-1">'));
  assert.ok(card.text.includes('Молоко &lt;Яготинське&gt; &amp; Co</a>'));
  // The unlinked line is present, and present only once — not as an empty anchor.
  assert.ok(card.text.includes('2. Сметана\n'));
  assert.equal((card.text.match(/<a href=/g) || []).length, 1);
  // Prices, quantities and the total are the card's, untouched by the link.
  assert.ok(card.text.includes('<b>52,90 ₴</b>'));
  assert.ok(card.text.includes('<b>85,89 ₴</b>'));
});

test('both names on a replacement row link to their own product page', () => {
  const plan = {
    planId: 'x',
    summary: { originalTotal: 1000, itemsAnalyzed: 9 },
    replacements: [{
      originalName: 'Молоко Яготинське', originalSlug: 'moloko-iahotynske-1',
      replacementName: 'Молоко Premia', replacementSlug: 'moloko-premiia-2',
      originalPrice: 52.9, replacementPrice: 44.9, saving: 8, savingPct: 15,
      confident: true, aiReason: 'Та сама жирність',
    }],
  };
  const text = buildSelectionCard(plan, [0]).text;

  assert.ok(text.includes('<a href="https://silpo.ua/product/moloko-iahotynske-1">Молоко Яготинське</a>'));
  assert.ok(text.includes('<a href="https://silpo.ua/product/moloko-premiia-2">Молоко Premia</a>'));
  // The figures are the plan's, unchanged by the links.
  assert.ok(text.includes('Заощадите 8,00 ₴'));
  assert.ok(text.includes('<s>52,90 ₴</s> → <b>44,90 ₴</b>'));
  assert.ok(text.includes('економія 8,00 ₴'));
  // The buttons are labels, not links: callback_data still drives the toggle.
  assert.equal(buildSelectionCard(plan, [0]).keyboard[0][0].callback_data, 't:x:0');
});

test('a plan row missing a slug loses its link and nothing else', () => {
  const plan = {
    planId: 'x',
    summary: { originalTotal: 1000, itemsAnalyzed: 9 },
    replacements: [{
      originalName: 'Сметана Яготинська', originalSlug: 'smetana-1',
      replacementName: 'Сметана «Селянська»',
      originalPrice: 52.99, replacementPrice: 32.99, saving: 20, savingPct: 38,
      confident: false, aiReason: 'Та сама жирність',
    }],
  };
  const card = buildSelectionCard(plan, []);
  const details = buildDetailsCard({ ...plan, summary: { ...plan.summary, saving: 20 } }, 'x');

  for (const text of [card.text, details.text]) {
    assert.equal((text.match(/<a href=/g) || []).length, 1);
    assert.ok(text.includes('Сметана «Селянська»'));
    assert.ok(!text.includes('href="null"') && !text.includes('href=""'));
  }
  assert.ok(details.text.includes('економія 20,00 ₴'));
});

test('the result message links the products it names', () => {
  const text = buildResultText({
    beforeTotal: 1000, afterTotal: 900, actualSaving: 100, promisedSaving: 100, applied: 2,
    substituted: [{
      planned: 'Сметана «Селянська»', plannedSlug: 'smetana-selianska-1',
      used: 'Сметана «Славія»', usedSlug: 'smetana-slaviia-2',
    }],
    sizeRejected: [{
      originalName: 'Масло Президент', originalSlug: 'maslo-prezydent-3',
      originalRatio: '200г', newRatio: '180г', tried: 2,
    }],
    stockRejected: [{ originalName: 'Кефір' }],
    failed: [{ name: 'Хліб <свіжий>', error: 'boom' }],
  }, 'Гарного дня.');

  for (const slug of ['smetana-selianska-1', 'smetana-slaviia-2', 'maslo-prezydent-3']) {
    assert.ok(text.includes('<a href="https://silpo.ua/product/' + slug + '">'), slug);
  }
  // The two without slugs are named in plain, escaped text.
  assert.equal((text.match(/<a href=/g) || []).length, 3);
  assert.ok(text.includes('· Кефір\n'));
  assert.ok(text.includes('Хліб &lt;свіжий&gt;'));
  // The verified numbers are still the cart's own.
  assert.ok(text.includes('зекономлено 100,00 ₴'));
});

test('links do not cost the card any of the rows it used to show', () => {
  // Telegram counts the text after entities are parsed, so an href is free.
  // Counted raw, the links halved this card — sixteen replacements showed
  // fifteen rows before they existed and eight after.
  const plan = {
    planId: 'big',
    summary: { originalTotal: 4286.86, saving: 620.5, itemsAnalyzed: 22 },
    replacements: Array.from({ length: 16 }, (_, index) => ({
      originalName: `Ковбаса «Укрпромпостач» «Домашня» варена в/ґ, нарізка ${index + 1}`,
      replacementName: `Ковбаса Алан «Особлива» варено-копчена в/ґ, нарізка ${index + 1}`,
      originalSlug: `kovbasa-domashnia-${300000 + index}` as string | null,
      replacementSlug: `kovbasa-alan-osoblyva-${400000 + index}` as string | null,
      originalPrice: 129.9, replacementPrice: 99.9, saving: 30, savingPct: 23,
      confident: true, aiReason: 'Та сама варена ковбаса, те саме фасування',
    })),
  };
  const rows = (p: typeof plan) =>
    (buildSelectionCard(p, defaultSelection(p.replacements)).text.match(/^      ➜ /gm) || []).length;

  // The same plan with the slugs stripped is the control: whatever the budget
  // lets through, the links must not take a row off it.
  const unlinked = {
    ...plan,
    replacements: plan.replacements.map((r) => ({ ...r, originalSlug: null, replacementSlug: null })),
  };
  assert.equal(rows(plan), rows(unlinked));

  const text = buildSelectionCard(plan, defaultSelection(plan.replacements)).text;
  const counted = text.replace(/<a href="[^"]*">/g, '').split('</a>').join('').length;
  assert.ok(counted <= 4096, `card counts ${counted} characters`);
});

test('a cart-validation warning links the product it names', () => {
  // These lines are HTML now — the sentence is fixed copy, the product is not.
  const text = buildResultText({
    beforeTotal: 100, afterTotal: 100, actualSaving: 0, promisedSaving: 0, applied: 0,
    validations: [
      { level: 'error', message: 'product.offer.stock.not_enough', productName: 'Молоко & Co', productSlug: 'moloko-1' },
      { level: 'error', message: 'product.offer.stock.not_enough', productName: 'Кефір' },
    ],
  }, 'Гарного дня.');

  assert.ok(text.includes('<a href="https://silpo.ua/product/moloko-1">Молоко &amp; Co</a>'));
  assert.ok(text.includes('Товар закінчився — Кефір.'));
  assert.equal((text.match(/<a href=/g) || []).length, 1);
  // The sentence itself is not double-escaped into visible &lt;b&gt; noise.
  assert.ok(!text.includes('&lt;a'));
});

test('no message invites Telegram to paste a product preview under it', () => {
  // The links made Telegram staple a photo of the cream, its shop blurb and its
  // SEO title beneath a card that already filled the screen. message() is the
  // only thing that sets parse_mode, so it is the only thing that has to say no.
  assert.deepEqual(message(1, 'текст').link_preview_options, { is_disabled: true });

  for (const request of screenRequests({ text: 'текст', keyboard: [] }, { chatId: 1 })) {
    assert.deepEqual(request.body.link_preview_options, { is_disabled: true });
  }
  // A caller may still override it deliberately; nothing does today.
  assert.equal(message(1, 'текст', { link_preview_options: null }).link_preview_options, null);
});

/* ------------------------------------------- picking a runner-up by hand */

/**
 * The guest's own choice among the runners-up.
 *
 * Everything below is offline on purpose: the run already confirmed each of
 * these candidates against `get_product_details`, and picking one is a swap
 * inside the stored plan — no search, no model call, no new plan. What has to be
 * pinned down is that the swap is *complete*: after it, the picked product is an
 * ordinary replacement, its figures are recomputed from the two prices, and the
 * ticks the guest set are untouched.
 */

function alternate(over: Partial<import('./types.ts').Alternate> = {}) {
  return {
    productId: 'a1', companyId: 'c1', branchId: 'b1',
    name: 'Масло «Ферма» 82%', slug: 'maslo-ferma-82-111222',
    price: 95, saving: 25, brand: 'Ферма',
    reason: 'Те саме масло 82%, інша марка', confident: true, offerable: true,
    ...over,
  };
}

function butterPlan() {
  return {
    planId: 'plan1',
    selected: [0],
    summary: { originalTotal: 500, saving: 80 },
    replacements: [
      {
        originalProductId: 'o1', originalName: 'Масло «Президент» 82%', originalSlug: 'maslo-prezydent-82-111000',
        originalPrice: 120, originalRatio: '180г', quantity: 1,
        replacementProductId: 'p1', replacementCompanyId: 'c1', replacementBranchId: 'b1',
        replacementName: 'Масло «Яготинське» 82%', replacementSlug: 'maslo-iahotynske-82-111111',
        replacementPrice: 90, replacementRatio: '180г', onPromotion: false, brand: 'Яготинське',
        saving: 30, savingPct: 25, verifySize: false, confident: true,
        aiReason: 'Те саме масло 82%, те саме фасування',
        alternates: [alternate(), alternate({ productId: 'a2', name: 'Масло «Селянське» 82%', price: 99, saving: 21, slug: null })],
      },
      {
        originalProductId: 'o2', originalName: 'Сир «Президент» 45%', originalSlug: null,
        originalPrice: 200, originalRatio: '200г', quantity: 1,
        replacementProductId: 'p2', replacementCompanyId: 'c1', replacementBranchId: 'b1',
        replacementName: 'Сир «Премія» 45%', replacementSlug: null,
        replacementPrice: 150, replacementRatio: '200г', onPromotion: false, brand: 'PREMIA',
        saving: 50, savingPct: 25, verifySize: false, confident: false,
        aiReason: 'Той самий сир 45%',
        // Typed rather than bare: an empty literal infers never[], and the union
        // with the line above it then hides every field from the assertions.
        alternates: [] as Array<ReturnType<typeof alternate>>,
      },
    ],
  };
}

test('«Інші варіанти» appears only where there is something behind it', () => {
  const plan = butterPlan();
  const rows = buildSelectionCard(plan, [0]).keyboard;

  // Row 0 is the line with two runners-up, row 1 the line with none. The rest
  // of the keyboard is Apply/Details/Cancel and is not per-replacement.
  assert.equal(rows[0].length, 2, 'a line with alternates carries the second button');
  assert.equal(rows[0][1].callback_data, 'alt:plan1:0');
  assert.equal(rows[1].length, 1, 'a line with none must not offer an empty screen');
});

test('a runner-up below the confidence bar is never put on a button', () => {
  // Working rule 3d: under minConfidence it stays in the array for apply-time
  // fallback and off every screen.
  const plan = butterPlan();
  plan.replacements[0].alternates = [alternate({ offerable: false })];

  assert.equal(buildSelectionCard(plan, [0]).keyboard[0].length, 1);
  const card = buildAlternativesCard(plan, 0);
  assert.ok(!card.text.includes('Масло «Ферма»'));
  assert.equal(card.keyboard.length, 1, 'only «Назад» is left');
});

test('the alternatives screen names one line, cheapest option first', () => {
  const card = buildAlternativesCard(butterPlan(), 0);

  assert.ok(card.text.includes('Масло «Президент» 82%'), 'the original, for reference');
  assert.ok(card.text.includes('Масло «Яготинське» 82%'), 'what is chosen right now');
  assert.ok(card.text.indexOf('Масло «Ферма» 82%') < card.text.indexOf('Масло «Селянське» 82%'));
  // Name, price and saving for each — the three things the choice is made on.
  assert.ok(card.text.includes('95,00'));
  assert.ok(card.text.includes('економія 25,00'));
  // Two picks and a way back, nothing else.
  assert.deepEqual(
    card.keyboard.map((row) => row[0].callback_data),
    ['altpick:plan1:0:0', 'altpick:plan1:0:1', 'alt:plan1'],
  );
  for (const row of card.keyboard) {
    assert.ok(Buffer.byteLength(row[0].callback_data ?? '') <= 64);
  }
});

test('a picked runner-up becomes an ordinary replacement', () => {
  const plan = butterPlan();
  assert.equal(applyAlternate(plan, 0, 0).ok, true);
  const line = plan.replacements[0];

  assert.equal(line.originalName, 'Масло «Президент» 82%', 'the original never moves');
  assert.equal(line.replacementName, 'Масло «Ферма» 82%');
  assert.equal(line.replacementProductId, 'a1');
  assert.equal(line.replacementPrice, 95);
  // Its own words and its own verdict travel with it — not the demoted pick's.
  assert.equal(line.aiReason, 'Те саме масло 82%, інша марка');
  assert.equal(line.brand, 'Ферма');
});

test('the saving is recomputed from the two prices, per unit and in total', () => {
  const plan = butterPlan();
  applyAlternate(plan, 0, 0);
  assert.equal(plan.replacements[0].saving, 25, '120 − 95, not the 30 it used to be');
  assert.equal(plan.replacements[0].savingPct, 20.83);

  // Quantity belongs to the line, and the stored figure on the alternate is not
  // trusted to know it.
  const two = butterPlan();
  two.replacements[0].quantity = 2;
  applyAlternate(two, 0, 0);
  assert.equal(two.replacements[0].saving, 50);
});

test('the headline follows the line that changed', () => {
  const plan = butterPlan();
  // 30 + 50 on the two lines; the first becomes 25.
  applyAlternate(plan, 0, 0);
  assert.equal(plan.summary.saving, 75);
});

test('switching a product does not switch it on or off', () => {
  // The guest chose a product, not whether to buy it.
  const on = butterPlan();
  applyAlternate(on, 0, 0);
  assert.deepEqual(on.selected, [0], 'a ticked line stays ticked');
  assert.ok(buildSelectionCard(on, on.selected).text.includes('✅'));

  const off = butterPlan();
  off.selected = [1];
  applyAlternate(off, 0, 0);
  assert.deepEqual(off.selected, [1], 'an unticked line stays unticked');
});

test('the demoted pick stays reachable without re-running anything', () => {
  const plan = butterPlan();
  applyAlternate(plan, 0, 0);
  const alternates = plan.replacements[0].alternates ?? [];

  assert.equal(alternates[0].name, 'Масло «Яготинське» 82%', 'the old primary leads the list');
  assert.equal(alternates[0].price, 90);
  assert.equal(alternates[0].saving, 30, 'with the figure it was offered at');
  assert.equal(alternates[0].offerable, true);
  assert.equal(alternates.length, 2, 'the picked one left the list, nothing else did');
  assert.ok(!alternates.some((a) => a.productId === 'a1'));

  // And one more tap puts it back, with its own figures.
  assert.equal(applyAlternate(plan, 0, 0).ok, true);
  assert.equal(plan.replacements[0].replacementName, 'Масло «Яготинське» 82%');
  assert.equal(plan.replacements[0].saving, 30);
  assert.equal(plan.summary.saving, 80);
});

test('apply reads the guest choice, because there is nothing else left to read', () => {
  // The apply step builds its queue from replacementProductId/CompanyId/BranchId
  // and falls back through `alternates`. After a pick, both point at the chosen
  // product — which is why the swap is done in the plan rather than stored as a
  // «selectedAlternateIndex» that every reader would have to know about.
  const plan = butterPlan();
  applyAlternate(plan, 0, 1);
  const line = plan.replacements[0];

  assert.equal(line.replacementProductId, 'a2');
  assert.equal(line.replacementCompanyId, 'c1');
  assert.equal(line.replacementBranchId, 'b1');
  assert.equal(line.replacementSlug, null, 'a candidate with no slug renders as plain text');
  // Pack size was confirmed for the demoted pick, not for this one; apply reads
  // it from the cart, so inheriting a stale string would be a small lie.
  assert.equal(line.replacementRatio, null);
  assert.equal((line.alternates ?? [])[0].productId, 'p1', 'the fallback list is still validated candidates only');
});

test('a tap that arrives at nothing changes nothing', () => {
  const gone = butterPlan();
  assert.deepEqual(applyAlternate(gone, 0, 7), { ok: false, reason: 'no-alternate' });
  assert.equal(gone.replacements[0].replacementName, 'Масло «Яготинське» 82%');
  assert.equal(gone.summary.saving, 80);

  assert.equal(applyAlternate(gone, 9, 0).reason, 'no-replacement');
  // A stale keyboard pointing at something that was never offered.
  const hidden = butterPlan();
  hidden.replacements[0].alternates = [alternate({ offerable: false })];
  assert.equal(applyAlternate(hidden, 0, 0).reason, 'no-alternate');

  // And one that no longer clears the floor every other proposal has to clear.
  const dear = butterPlan();
  dear.replacements[0].alternates = [alternate({ price: 119.5, saving: 0.5 })];
  assert.equal(applyAlternate(dear, 0, 0).reason, 'no-saving');
  assert.equal(dear.replacements[0].replacementName, 'Масло «Яготинське» 82%');
});

test('the alternatives screen survives a plan that moved on', () => {
  // The card was redrawn and this line is gone: a screen with a way back, not a
  // crash and not an empty message.
  const card = buildAlternativesCard(butterPlan(), 9);
  assert.ok(card.text.includes('вже не в плані'));
  assert.deepEqual(card.keyboard, [[{ text: '‹ Назад', callback_data: 'alt:plan1' }]]);
});
