# Engine results and known limits

> **Superseded on 2026-08-17.** Everything below measures the deterministic
> scorer in `src/lib/optimizer.ts`, which has been removed. The model now makes
> every decision and code computes every figure (`src/lib/optimizer/`). The section
> at the end records the current measurements; the rest is kept because its
> failure analysis is what the new engine was built against.

Measured with `npm run optimize` against a live cart of 14 items at a Kyiv
store, on 2026-08-12.

---

## Result

```
Found 14 items totalling 1051.30 UAH
promotions: 9 · coupons: 0 · bonuses: 34.24

Before     1042.30 UAH
After       945.49 UAH
────────────────────────
Saving       96.81 UAH   9.29%

14 items · 5 replacements · 4 on promotion
22 MCP calls · 0 retries · 2.1 s
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

> It did, in v1.108.0 — and this prediction was wrong on the mechanism:
> `sizeOf()` reads `ratio`, which candidates do not have, so the field has to be
> read by name. See the 2026-08-17 section.

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

---

## 2026-08-17 — the all-model engine

`src/lib/optimizer.ts` was deleted. The model chooses each replacement and
computes `saving`, `savingPct` and the plan totals; there is no rule-based
fallback. Measured on a live 14-item cart totalling 1338.54 UAH.

| Engine | Saving | Replacements | Reproducible |
|---|---|---|---|
| Deterministic scorer + AI accept/reject | 100.50 UAH (7.51%) | 6 | yes |
| — of which defensible | 40.50 UAH | 2 | — |
| Keyword fallback only | 40.50 UAH (3.03%) | 2 | yes |
| All-model, run 1 | 40.00 UAH (2.99%) | 3 | **no** |
| All-model, run 2 | 37.50 UAH (2.80%) | 3 | **no** |

**The headline is 37.50–40.00 UAH.** Two things about that number:

- The old 100.50 was inflated. Four of its six replacements were «Моршинська»
  drinks flagged `verifySize` — same product name, 44% cheaper, which Silpo's
  own data now confirms means a smaller pack. Removing them leaves 40.50, so
  the hybrid engine never actually beat its own keyword fallback on this cart.
- The all-model engine rejects those four outright, because
  `displayRatio` (silpo-mcp-service v1.108.0) exposes candidate pack size for
  the first time. That is the quality ceiling lifting, not a regression.

### What got worse

**Reproducibility.** 40.00 and 37.50 on identical input. The deterministic
scorer returned the same figure every time; the model picks a different
candidate between runs. Any demo metric must be quoted as a range.

**Effort sensitivity.** At `effort: low` the model chose the most *similar*
candidate rather than the cheapest acceptable one and the saving collapsed to
**1.00 UAH** — it also selected three candidates that cost more than the
original. Both were fixed by saying "among acceptable options choose the
cheapest" in the prompt and raising effort to `medium`. Choosing from 30
candidates is not the cheap judgement it looked like.

**Cost and latency.** One model call per cart line plus one for totals: 15 calls
and ~33–49 s per analysis, against 1 call before. (The totals call was removed
three sections down, when the arithmetic moved back into code. Every cost figure
in this section counts it, so all of them are ceilings for the engine as it
stands.)

### Arithmetic

Verified digit-for-digit on two runs — all savings, percentages and totals
matched a deterministic recomputation, including a weighted line (199.00 →
189.00 at 0.1 kg = 1.00, not 10.00). It is **not** guaranteed: the discarded
`effort: low` run produced a negative saving and reported a real price increase
as 0.00.

### Not verified

The n8n workflow builds, validates and every Code node compiles, but the
deployed bot has **not** been run end to end against Telegram since the change.
The apply path in particular — 14 per-line model calls inside one Code node,
under n8n's own execution timeout — has never executed.

### Token cost, measured

One live 14-item run, `effort: medium`, prices at Sonnet 5 introductory rates
(\$2 / \$10 per MTok, through 2026-08-31):

```
prompt tokens        40 331   full price 18 995 · cache write 4 572 · cache read 16 764
output tokens         4 431
cost                 $0.097 per analysis   →  ~51 runs per $5
```

**Caching the selection system prompt saves 22%.** It is re-sent once per cart
line, byte-identical, and measures 1161 tokens — just over Sonnet 5's
1024-token minimum. 14 of the 15 calls read it from cache. A prompt edit that
trims ~140 tokens would drop it below the minimum and it would silently stop
caching, so `npm run optimize` prints `cache read` on every run.

Two things that were expected and turned out wrong:

- **A prediction of +47% more runs per \$5 was overstated; the real figure is
  +22%.** It came from measuring output on one easy call (80 tokens) and
  extrapolating. Across a full run output averages ~295 tokens per call, so
  output is 46% of the cost — and caching cannot touch output.
- **Raising `effort` from `low` to `medium` is free.** Measured on the same
  input: `in=3043 out=80` at `low`, `in=3043 out=82` at `medium`. The change
  that lifted the saving from 1.00 to 37.50 UAH cost nothing.

Cache warming (serialising the first call so the concurrent three do not all
pay the write premium) was considered and rejected: ~4 calls pay it, worth
about \$0.002 per run, against added latency and a special case in both hosts.

The receipt wish, if it is ever generated by a model instead of drawn from the
static list, measures 516 input tokens on Haiku 4.5 — **0.77% of a run**. Cost
is not an argument either way for that feature.

### The receipt wish

Moved out of a `build.ts` template literal into `src/lib/ui.ts` (working rule
12), then given a model. The static list stays as the guaranteed floor.

**This is the one place a model failure is answered with a silent fallback**,
and the reason is the inverse of why the engine's fallback was removed. A wish
carries no number and no claim, and it is written *after* the cart has already
been changed — the message has to reach the guest so they learn what happened.
A static line is less personal, not wrong. The engine's fallback made
unverifiable claims about money that looked identical to real ones.

Everything the model returns goes through `validateWish` first: a digit is an
outright reject (that check is what stands between a hallucinated figure and a
guest), plus limits on length, emoji and angle brackets. Verified against six
crafted inputs — digit, over-length, emoji, HTML, empty, clean — all classified
correctly.

**Model choice was got wrong first time.** Haiku 4.5 was picked on cost
reasoning, since a one-line wish looked easy. Over 8 generations roughly half
carried Ukrainian errors:

```
«Нехай у дома завжди буде місце…»              (у домі / удома)
«…прохолодний напиток…»                        (напій)
«Нехай ваш стіл буває щедрим…»                 (буде)
«…прохолодна піна при кожному ґлоткові»        (ковтку)
```

An explicit instruction to use literary Ukrainian and avoid russianisms fixed
«святком» and «прохлада» but not these. Sonnet 5 produced 8 clean lines out of
8, at \$0.002 per wish — about 2% of a run.

The lesson is not "use the bigger model". Cost was never the binding constraint
here (0.77% on Haiku, ~2% on Sonnet), so optimising for it was optimising the
wrong axis. The binding constraint was language quality in copy a Ukrainian
retailer's guest reads.

Cart item names for the prompt ride out of `Apply Changes`, which has already
read the cart back — the wish costs no extra MCP call.

### Arithmetic moved back into code

Measured on a live 22-item cart (4286.86 UAH, nine weighted lines), the model
computing its own savings got **2 of 16 wrong**:

```
qty 0.3   839.00 → 399.00    model 1.32      correct 132.00
qty 0.25  659.00 → 169.00    model 129.54    correct 122.50

model plan total   1082.97
computed total     1206.61     short by 123.64 UAH
```

Both failures were weighted lines. The earlier 14-item cart had one weighted
line and was exact on two consecutive runs, which is why this stayed hidden —
the defect needed a basket with meat and cheese counters in it.

`computeSaving()` and `buildPlan()` now produce every figure from MCP prices.
The model still chooses the candidate, judges the purchase intent and the pack
size, and reads prices to pick the cheapest acceptable option; it returns
indices and words only. Re-measured on the same cart: **17 of 17 lines, every
percentage and every total exact.**

Two side effects, both good: the totals model call is gone (one fewer round trip
per run) and the response schema is smaller.

### Pack-size tolerance as a guest setting

Three presets in Settings — `strict` 0.95-1.05, `normal` 0.8-1.25, `loose`
0.6-1.7 — stored per guest in `silpo_sessions.size_tolerance`, enforced in the
prompt at selection and again at apply time against the cart's own `ratio`. Apply
reads the band **from the plan**, so changing the setting while a card is on
screen cannot re-judge a plan the guest already approved.

Measured on one cart, same basket, three runs:

| Preset | Saving | Replacements |
|---|---|---|
| strict | 818.90 UAH (19.1%) | 13 |
| normal | 1146.65 UAH (26.8%) | 18 |
| loose | 1524.07 UAH (35.6%) | 18 |

`loose` is only defensible because of a rule added with it: when the candidate's
pack is smaller, the price for the same quantity must actually be better. That
rule was impossible before `displayRatio` existed — there was no candidate pack
size to divide by.

Band verification on a 17-replacement plan at `normal`: 17 of 17 pairs
comparable, all within 0.80-1.20, none out of band, `verifySize` flagged zero
times. Presets rather than a typed number: a free-form value needs parsing,
validation and an error path, and "0.8" means nothing to a shopper.

---

## 2026-08-17 — the hard gate, and a saving that was not there

The engine had no deterministic stage at all: every candidate `similar_products`
returned went to the model, filtered only by "cheaper, in stock, not the same
product". Measured on a live 19-line cart (1970.96 UAH), that produced four
replacements worth **103.00 UAH**, and the number was wrong.

### Two price bases, compared as if they were one

```
Балик «Ювілейний»       weighted=true    ratio "100г"   price 799.00
  → Полядвиця Глобино   weighted=false   displayRatio "100г"   price 74.99
     reported: saving 72.40 UAH (−90.61%)
```

Both rows say «100г». Nothing else in either payload says they are quoted
differently — and they are. A weighted line's `price` is **per kilogram**; a
packaged one's is **for one pack**. So the real comparison is 799.00 per kg
against 749.90 per kg: about 6%, not 90%.

The derivation is from the fixture rather than from documentation, which says
nothing about it. In the «Шинка Daniel» pool the weighted hams price at
299–649 while the packaged ones sit at 95.99 per 170 g, i.e. 565 per kg.
Weighted prices only land in that range read as per-kilogram; read as per-100 g
the same ham would be 5 490 per kg, ten times its own shelf neighbours.

**72.40 of the 103.00 UAH headline was this one swap.** Of the rest, 0.60 UAH
was a sausage flavour change and 25.00 UAH was sliced ham offered a pork knuckle.

The same defect reached further than the number. `Apply Changes` adds a
replacement with the original line's quantity, so a weighted 0.1 kg line would
have added **0.1 of a pack** of the packaged substitute.

### What the gate rejects, and what it refuses to decide

`rejectReason()` runs before the prompt and again on the confirmed price after
`get_product_details`. Every rule is a fact the API states:

| rule | why it is safe to decide in code |
|---|---|
| same product | `similar_products` returns the original in every pool |
| unavailable / not enough stock | stated per candidate |
| **price basis differs** | `weighted` differs, so no saving can be derived |
| not cheaper | a replacement that does not save is not one |
| saving below 2.00 UAH | measured: a 0.60 UAH swap changed a sausage flavour |
| different grade | fat percentage in the name, differing by over 1 point |
| pack size out of band | both sizes parse, the ratio is outside the mode's band |
| worse per unit | a smaller pack at a lower ticket price is not a saving |

Nothing about what a product is *for* is decided here. Whether kombucha may
become juice stays the model's judgement, because a rule engine for that would
be brittle and wrong. What the model gets instead is a shorter pool and, for the
first time, prices it can actually compare: the prompt now carries the price per
100 g or per litre, computed in code, and marks a weighted line as such.

### Measured on the same cart, before and after

```
                    before      after
saving              103.00      20.00 UAH
replacements             4          2
of which defensible      1          2
candidates rejected      —        468
model calls             11          6
run time              19.9 s     12.7 s
```

The drop is the correction. Both survivors came back at `confidence 0.65`, so
the card opens with **nothing ticked** and headlines «Можлива економія 20,00 ₴».

Rejection tally over 468 candidates: 252 not cheaper, 148 price basis differs,
39 pack size out of band, 19 same product, 6 below the saving floor, 4 stock.

**Two rules did not fire on this basket**: `worse per unit` and
`different grade`. This cart is cured meat and spirits — no fat percentages in
the names, few multi-size families. They are covered by `npm test` rather than
by live evidence, and that distinction is the honest one to record.

### Confidence, measured before it was used

The brief proposed 0.85 and 0.65. Measured first: the four replacements of the
baseline run came back at 0.55, 0.60, 0.60 and 0.70, and **nothing in that run
reached 0.80**. An 0.85 floor would have emptied every card while proving
nothing about quality.

So the bands are set where this model's answers fall, and they do different
things rather than the same thing at different strengths:

```
>= confidentAt   offered and ticked
>= minConfidence offered, explained, and NOT ticked
<  minConfidence not offered at all
```

Presenting the middle band unticked is the change. Before it, a 0.55 swap and a
0.95 swap arrived as two identical rows, both ticked, and Apply took both.

### One control, not three

The pack-size presets became modes, because pack size turned out to be one face
of a single question — how far a replacement may travel from the original.

| mode | pack size | offered from | ticked from | brand |
|---|---|---|---|---|
| `conservative` | 0.95–1.05 | 0.75 | 0.85 | prefers the same |
| `balanced` | 0.8–1.25 | 0.60 | 0.80 | free |
| `max` | 0.6–1.7 | 0.55 | 0.80 | free, and said so |

The tick bar deliberately does **not** move outside `conservative`: a guest
asking for bigger savings is asking to be shown more, not to have more applied
while they are not reading. `MIN_SAVING` does not move either.

The three old preset names still sit in `silpo_sessions.size_tolerance`, and
`resolveMode()` folds them onto the mode carrying the same band. Nothing was
migrated and no table changed.

### Promotions, coupons, bonuses — what the data actually supports

Cart lines carry the promotion **already applied**:

```
Віскі William Lawson's   price 349.00   oldPrice 599.00
                         subTotal 599.00   subDiscount 250.00   total 349.00
```

`total = price × quantity` and `subTotal = oldPrice × quantity`, so
`calculation.subDiscount` is money the guest already has. It is stated beside
the saving — «🎁 Акції вже в ціні кошика · 344,51 ₴» — and never added to it.
Adding it would have inflated this cart's headline seventeenfold.

Coupons and personal promos could not be verified at all:

```
silpo_get_my_coupons  → { "coupons": [] }
silpo_get_promo_codes → { "promoCodes": [] }
silpo_get_my_promos   → { "promos": [] }
```

Empty on this account, so applicability cannot be proven and value cannot be
computed. The card therefore shows a **count**, never a sum, and says to apply
them at checkout. Applying one needs `update_shopping_cart`, which requires the
whole cart state mirrored back — a write, and out of scope by decision.

Loyalty bonuses are shown the same way and stay out of the saving: only a
checkout response can confirm them.

### Quantity promotions exist in the data, and are not modelled

`specialPrices` is real and structured, not free text:

```
Шинка Argal    specialPrices: [{ "price": 47.90, "count": 0.3, "type": "from" }]
Кабаноси       specialPrices: [{ "price": 119.00, "count": 2,  "type": "from" }]
```

Present on **4 of 73** candidates in the fixture, and absent from cart lines
altogether. So the data exists for "buy 2 at 119 each" but the cart side of the
comparison does not, and acting on it would change what the guest buys. Left
unmodelled and recorded here rather than approximated.

### A card that would not have sent

Adding the reason line to the selection card exposed that it had **no length
budget at all**. Telegram rejects anything over 4096 characters outright, so a
basket with fifteen replacements would have produced no message whatsoever.
The card now drops reasons first, then trims the list with «…і ще N замін», and
`npm test` holds a 40-replacement plan against the cap.

### Unticking everything used to lie

With every line ticked by default, Apply-with-nothing-selected was hard to
reach. It is now the ordinary opening state of a cautious run — and it fell
through to «Кошик змінився з моменту аналізу», which was untrue about a cart
nothing had touched. It is rejected in `Validate Plan` instead, **before**
`Claim Plan`, so the plan stays `pending` and a mistap costs nothing.

---

## 2026-08-18 — the runner-up the guest can take

Selection already asked the model for up to two acceptable alternates beside its
pick, and they had exactly one reader: the apply step, which reached for the next
one when the cart refused the first. The guest never saw them, so a card that
proposed the wrong thing offered no way out except unticking the line.

They are now a screen. Every replacement with confirmed runners-up carries
«Інші варіанти»; choosing one promotes it to primary and demotes the previous
pick to the head of that line's alternates, so the swap is reversible in one more
tap.

### Nothing is judged twice

The tap costs **no MCP call and no model call**. That is only defensible because
the alternates were confirmed during the original run: `Optimize Cart` walks the
whole option list through `get_product_details`, applies `rejectReason()` to each
on its confirmed price, and keeps up to `MAX_OPTIONS` survivors. A runner-up on
the card has therefore passed the same gate on the same evidence as the pick.

The CLI deliberately does not do this — it stops at the first confirmation,
because it renders no card and the extra calls would buy nothing.

### The verdict travels with the candidate, not with the slot

The first version had the promoted candidate inherit the primary's `reason` and
`confidence`. That is code inventing a judgement about a product the model never
wrote those words about. Before that it was worse: a placeholder string
(«Запасний варіант, основний виявився недоступним») and a confidence floored at
0.6, which left a perfectly good kefir unticked and unexplained.

So each alternate carries the model's own `reason` and `confidence` for *itself*,
returned in the same single call. A promoted runner-up can say why it is there,
in words written about it.

### What does not move

The checkbox. Promoting a runner-up changes which product the line proposes, not
whether the guest agreed to it — re-ticking an unticked line on the guest's
behalf would be the tick bar sliding sideways. `buildPlan()` recomputes the
saving and the headline from the new candidate's price, as it does for every
other figure.

`npm test` covers the promotion: the demoted pick lands at the head of
`alternates` and stays reachable without re-running anything, the saving follows
the new primary, and a stale tap — a keyboard from before a redraw — is rejected
rather than applied to whatever now sits at that index. `applyAlternate()` checks
`offerable` for exactly that reason: an index alone cannot tell the difference
between a button the guest saw and one the redraw removed. A tap naming a line
the plan no longer has gets a screen with a way back, not a crash and not an
empty message.

The figures are recomputed from the two prices rather than carried over from the
alternate's stored `saving`, because quantity belongs to the line and not to the
candidate — the same reason `buildPlan()` owns every other number.
