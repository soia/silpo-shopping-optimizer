# Engine results and known limits

Measured with `npm run optimize` against a live cart of 14 items at a Kyiv
store, on 2026-08-12.

---

## Result

```
Found 14 items totalling 1051,30 UAH
promotions: 9 · coupons: 0 · bonuses: 34.24

Before:   1042,30 UAH
After:      945,49 UAH
SAVING:      96,81 UAH  (9.29%)

14 items analyzed · 5 replacements · 4 on promotion
MCP: 22 calls · 0 retries · 2.1s
```

22 calls for 14 items in about two seconds, with no rate limiting hit at
concurrency 3.

The deterministic layer alone finds **10 replacements worth 407.83 UAH**. The
semantic layer removes half of them on purpose — see below. The lower number is
the honest one.

---

## What the semantic layer rejects, and why that matters

Cheaper is not the goal; preserving the purchase is. These were all rejected
despite real savings:

| Original | Candidate | Rejected because |
|---|---|---|
| Valio PROfeel **protein** dessert | «Марійка» vanilla dessert | protein product replaced by a plain sweet — different purpose |
| Spraga **kombucha** cola | Elements orange juice | fermented drink replaced by juice |
| Активіа **no added sugar** | Яготинський plain | dietary constraint dropped |
| Alpro banana, −63% | Alpro Original | price drop too large to trust without a size |
| Морозиво Monaco, −69% | Monaco Sweet heart | same |

The deterministic filter had already discarded four more before this stage —
a pumpkin brittle offered halva, a kombucha offered an energy bar.

With an Anthropic key the model handles these cases with more nuance than the
rule-based fallback (it recognises Alpro Original as the same product line), so
the expected saving lands around 200–280 UAH rather than 96.

---

## Known limit: candidate pack size is not available

`ratio` — the pack size — exists **only on cart lines**. None of the three
candidate sources expose it:

| Source | Returns `ratio`? |
|---|---|
| `silpo_get_similar_products` | no |
| `silpo_get_products` | no |
| `silpo_find_products_batch` | no |
| `silpo_get_product_details` | `"шт"` — useless, and `attributes` has no volume |
| `silpo_get_product_sets` | no |
| `silpo_get_my_favorites` | no |
| `silpo_get_my_offline_orders` / `online_orders` | no |

silpo.ua shows "300г" under every search result, so the storefront has the data —
but it comes from the website's own API, and the hackathon rules rule out
anything but the MCP. Every product-returning tool was scanned for `ratio`,
`displayRatio`, `weight`, `volume`, `size` and `measure`. Only cart lines carry
it.

Parsing the size out of candidate names does not work either: **0 of 180
candidate names contained one.** Silpo keeps size in `ratio` and out of the name.

The field does exist in Silpo's data model — a promotional payload embedded in
`cart.calculation.validations` carries `displayRatio: "0,33л"` — but no search
tool returns it.

### Consequences

- `sizeMatchScore` is 0.5 for effectively every candidate, so the 10% size
  weight in the ranking formula does nothing.
- The "don't swap 1 L for 0.2 L" guard and the price-per-unit check cannot fire.
- The clearest example: Alpro 1 L at 184 UAH against Alpro Original at 68.99. The
  price is plausible for a litre (`oldPrice` 99), but it cannot be **proven** from
  the API — and it is 115 UAH, 28% of the raw saving.

### What is done instead

**Before applying** — two heuristics flag `verifySize`: a price drop of 50% or
more with unknown size, and — more precise — an **identical product name** with a
drop over 15%. Silpo lists one name across several pack sizes («Сметана
Яготинська 15% стакан» is both 300 g at 57.49 and 180 g at 32.99), so a matching
name and a materially lower price means a different pack, not a better deal. That flag is passed to the model (which is told
to cap confidence at 0.6), makes the rule-based fallback reject the replacement
outright, and renders as **⚠️ перевірте об'єм упаковки** in the Telegram card.

**While applying** — the guard becomes real. Cart lines *do* carry `ratio`, and
the replacement is added to the cart before the original is removed, so at that
moment its true pack size is finally readable:

```
round 1: add every first-choice candidate
         one cart read  →  ratio and stock are finally visible
         ├─ 0.8x..1.25x and in stock → settled
         └─ otherwise                → remove it, queue the runner-up
round 2: same, with each item's second choice
round 3: same, with the third
then:    remove the originals of everything that settled
```

Up to three candidates per line are confirmed during analysis and carried in the
plan, so a rejected first choice is replaced rather than abandoned. Batching by
round rather than by item keeps this at **three cart reads total**, however many
replacements there are.

Simulated end to end against an in-memory cart:

```
add c1 (180г) → read → 180 vs 300 ✗ → remove c1
add c2 (300г) → read → 300 vs 300 ✓ → remove original
result: Сметана Простонаше 300г, reported as "замість … взяв …"
```

When every candidate fails the original simply stays, and the message says which
pack sizes were refused.

The band started at 2x and was too loose. It let 300 g sour cream become 180 g:
4% cheaper per gram, but 40% less product — two packs would have cost *more*
than the original. Buying less is not saving, so the tolerance is now ±20-25%.

One extra cart read per run buys a hard check instead of a warning. A rollback
is reported explicitly: *"Alpro Original — 1л → 0,25л, залишив оригінал"*.

If Silpo ever exposes `displayRatio` in search results, `sizeOf()` picks it up
and the check moves earlier with no other change.

### A parser bug that hid all of this

`parseSize` ended its pattern with `\b`. Cyrillic letters are not word
characters in JavaScript regexes, so no boundary ever matches after "л" or "г"
and **every** size parse silently returned null — including cart lines, which do
carry the data. Replacing `\b` with a negative lookahead fixed it: cart lines
now parse **14 of 14**.

Re-measured with the working parser, candidate names still contain a size in
**0 of 178** cases, so that finding stands.

---

## First live apply

Run through the bot on a 2 283,80 UAH cart, six replacements proposed:

```
Before:  2292,80 UAH        (cart moved by 9 UAH between analysis and apply)
After:   2244,30 UAH
ACTUAL SAVING: 48,50 UAH

3 applied · 1 rolled back on size · 2 refused by Silpo
```

Three things this proved:

1. **The arithmetic is sound.** The three applied replacements were worth
   16.00 + 21.50 + 11.00 = exactly the 48.50 the cart confirmed.
2. **The size guard earns its keep.** «Смузі Fresh me Mango beauty» matched by
   name almost exactly — and turned out to be **700 ml → 250 ml**. It was rolled
   back, keeping the original, instead of quietly shrinking the purchase by two
   thirds for a claimed 81 UAH saving.
3. **Reporting the actual number matters.** The card promised 199.52; the cart
   delivered 48.50. Headlining the real figure is the difference between an
   honest agent and a demo.

Two adds were refused. The message said "probably out of stock" — a guess baked
into the code, and a wrong one: both products were in stock (53 and 30 units,
step 1, not weighted). The real reason was discarded before it reached the user.
Fixed: tool errors now carry Silpo's own text, writes retry tool-level failures,
and sequential writes are spaced apart.

---

## The cart is the only authority on a candidate

Two independent failures pointed the same way, and both are now handled in the
same place — the round trip after adding, before removing the original:

| What search claims | What the cart shows | Handling |
|---|---|---|
| «Смузі Fresh me Mango beauty», near-identical name | 700 ml → **250 ml** | rolled back on size |
| «Масло Молокія» `available: true`, stock > 0 | **«Очікується»**, stock 0 | rolled back on availability |

Neither is detectable before the write: search results carry no pack size, and
their availability does not match the cart's. Adding first and removing second —
originally a safety measure so a failed add could not leave the cart short — turns
out to be the only place where the truth is visible at all.

---

## Two signals the API does give: availability and grade

### `similar_products` availability is stale

Measured on the same product, at the same slot, in the same minute:

```
silpo_get_similar_products :  available=true,  stock=1
silpo_get_product_details  :  available=false, stock=0     ← matches the cart
```

The details call agrees with the cart, so the chosen candidate is confirmed
there before it is ever shown, and the next-best candidate is used when the check
fails. Cost: roughly one extra call per proposed replacement.

This removed a recurring annoyance where «Масло Молокія» was proposed, applied,
and rolled back on every single run.

### Fat percentage is in the name, and it matters

Unlike pack size, this signal is really present:

| | |
|---|---|
| candidate names carrying a percentage | **139 of 288** |
| pairs where both sides have one | 137 |
| of those, differing by more than 1 point | **74** |

Without a check, more than half of comparable pairs would swap grades. The
fallback for the unavailable butter did exactly that: «екстра **82%**» →
«селянське **72,5%**» — a different grade of butter, not a cheaper version of the
same one.

The brief states the requirement directly ("молоко 2.5% → інше молоко 2.5%"), so
`filterCandidates` now rejects a candidate when both names carry a percentage and
they differ by more than **1 point**. The tolerance absorbs label rounding
(2.5 vs 2.6) while separating grades (82 vs 72.5, sour cream 15 vs 20).

With the guard in place the same cart yields «Масло Ферма Екстра **82%**» —
30 UAH instead of the 50 UAH the wrong-grade swap claimed.

---

## Selection has to anticipate the veto

The deterministic layer picks the highest-scoring candidate; the semantic layer
then refuses anything flagged `verifySize`. While those two ignored each other, a
line could lose its replacement completely:

```
Сметана Яготинська 15% стакан, 300 г, 57.49
  32.99  score 0.90  ⚠️ same name, -43%   → chosen, then vetoed
  52.99  score 0.63  Яготинська термостатна 15%   → never considered
  47.99  score 0.61  Простонаше 15%               → never considered
```

Ordering now puts veto-prone candidates last, so the same cart proposes the
52.99 termostatna — same brand, same 300 g, a real 4.50 UAH saving — and keeps
the flagged one only as a last-resort alternate.

---

## Ranking formula

Taken verbatim from the brief:

```
finalScore = similarity   * 0.40
           + priceSaving  * 0.25
           + brandMatch   * 0.10
           + sizeMatch    * 0.10
           + promotion    * 0.10
           + availability * 0.05
```

Two notes on how it is implemented:

1. The brief lists `categoryMatchScore` but leaves it out of the formula — the
   weights already sum to 1.00. Category is folded into `similarityScore` via a
   head-noun match (the first meaningful word: «Напій», «Батончик», «Сирок»).
2. `sizeMatch` is inert for the reason above. The weights were left unchanged
   rather than redistributed silently.

Since there is no brand field, `brandMatchScore` uses shared Latin tokens in the
name as a proxy — which is why Snickers→Snickers and Alpro→Alpro score 1.0.

### Acceptance thresholds

```
similarity   ≥ 0.35     below this it is a different kind of product
finalScore   ≥ 0.55
saving       ≥ 1 UAH    smaller gains are not worth interrupting anyone
size ratio   0.8 .. 1.25 when both sizes are known
unit price   must not increase
```

---

## Reproducing

```bash
npm run optimize            # full pipeline, read-only
npm run optimize -- --json  # also writes .secrets/plan.json
npm run test:node           # runs the generated Code node against live MCP
```

`npm run optimize` never calls a write tool. Cart changes only happen through
the bot, after an explicit confirmation.
