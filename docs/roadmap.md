# Roadmap

Product directions on top of the same Silpo MCP integration. Idea 2 is what this
repository implements; the rest reuse the existing OAuth, MCP client and
Telegram plumbing.

---

## 1. Fridge → cart

**Problem.** Planning a week of groceries is 20+ minutes of manual searching.

**Scenario.** The guest photographs their fridge or shelf, or just says
"four of us, one week, under 3000 UAH, no pork". The agent then:

```
get_my_family + get_my_food_restrictions + get_my_offline_orders   (what they actually buy)
        ↓
generate a 7-day menu
        ↓
find_products_batch          (up to 30 products in parallel)
        ↓
add_or_update_cart_products
        ↓
get_promotions + get_my_coupons     (price optimization)
        ↓
get_time_slots → checkoutMobileLink
```

**Why it is strong.** Uses roughly 15 of the 39 tools in one coherent agent
chain, and the value is obvious — time plus receipt.

**Validation.** Time-to-checkout against the manual flow; share of suggested
items the guest did not change.

---

## 2. Budget cart optimizer — implemented here

Takes an existing cart and lowers its cost without changing what the customer
buys: `get_shopping_cart_by_id` → `get_similar_products` / `get_replacements`
per line → cross-checked against `get_promotions`, `get_my_coupons`,
`get_promo_codes` and `loyalty.bonusAvailable` → replacements with a saving in
UAH.

**Demo metric.** "Saved 217 UAH (14%)" — the effect is measurable, which is what
makes it a good demo.

See [engine-findings.md](engine-findings.md) for what it actually produces on a
real cart.

---

## 3. Dietary and health agent

**Scenario.** Allergies, diabetes, baby food. `get_my_food_restrictions` +
`get_product_details` (composition, nutrition) checks the **entire cart** for
violations and proposes replacements. A parent of a child with an allergy is a
very concrete customer.

**Risk.** Medical claims need care — the agent should flag and inform rather
than advise.

**Note from this implementation.** `get_product_details` returns an `attributes`
map with allergens, brand and macros — for example `"Містить алергени": "СОЮ…"`,
`"Торгова марка": "Alpro"` — so the data for this exists. It costs one call per
product, so it should be applied to a shortlist rather than the whole catalog.

---

## 4. Predictive replenishment

**Scenario.** `get_my_offline_orders` + `get_my_online_orders` reveal
consumption cadence ("milk every 4 days"), and the agent proactively assembles a
cart and messages the guest: "looks like X, Y and Z are running out — I put a
cart together, slot tomorrow 18:00?"

**Why it stands out.** It acts **without being asked**, which is the clearest
difference between an agent and a chatbot.

---

## Improvements to the current optimizer

- **Wishes from the model.** The receipt-style closing line is drawn from a fixed
  pool. With the semantic layer enabled it could react to the actual cart —
  a line about coffee when coffee was the biggest saving — at the cost of one
  more model call and some latency.

- **Pack size before confirmation.** The apply step now verifies size through the
  cart and rolls back mismatches, but the recommendation card still cannot show a
  candidate's size. If `displayRatio` appears in search results, `sizeOf()` uses
  it with no other change.
- **Repair the cart's timeslot.** An expired slot makes Silpo report stock 0 for
  every line. The pipeline works around it for its own calls, but fixing the cart
  itself needs `update_shopping_cart` — a write, so it needs its own confirmation.
- **Apply loyalty bonuses.** `update_shopping_cart(bonusRequested)` is not wired
  up yet — it needs the full cart state mirrored back, which is why it was left
  out of the first pass.
- **Promo codes.** `get_promo_codes` is fetched and displayed but not applied to
  the cart.
- **Quantity-aware swaps.** Multi-buy promotions ("3 for the price of 2") are not
  modelled.
- **Token refresh job.** Refresh happens lazily on 401. A scheduled refresh would
  smooth out the first request after a long idle period.
