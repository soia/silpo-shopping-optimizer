# Architecture

How the pieces fit together, and why each decision was made. Every claim about
the Silpo MCP server below was verified against the live server, not taken from
its documentation.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          TELEGRAM USER                              │
└───────────────┬───────────────────────────────────▲─────────────────┘
                │ /commands, button taps            │ messages, inline keyboards
                ▼                                   │
┌─────────────────────────────────────────────────────────────────────┐
│                        TELEGRAM BOT API                             │
└───────────────┬───────────────────────────────────▲─────────────────┘
                │ webhook                           │ sendMessage
                ▼                                   │
╔═════════════════════════════════════════════════════════════════════╗
║                              n8n                                    ║
║                                                                     ║
║  telegram-bot.json            oauth-callback.json                   ║
║  ┌──────────────────┐         ┌──────────────────────────┐          ║
║  │ Telegram Trigger │         │ Webhook /silpo/callback  │◄─── guest ║
║  │        ↓         │         │        ↓                 │   browser ║
║  │ Route Request    │         │ code + state → /token    │          ║
║  │        ↓         │         │        ↓                 │          ║
║  │ Merge Session ───┼────────►│ encrypt and store        │          ║
║  │        ↓         │         └──────────┬───────────────┘          ║
║  │ Switch Action    │                    │                          ║
║  │        ↓         │         ┌──────────▼───────────────┐          ║
║  │ Optimize Cart    │◄───────►│  n8n data tables         │          ║
║  │  gate → model →  │         │  telegram_user_id →      │          ║
║  │  plan arithmetic │         │  encrypted tokens ·      │          ║
║  │        ↓         │         │  plans · oauth state     │          ║
║  │ Format Recommend │         └──────────────────────────┘          ║
║  │        ↓         │                                               ║
║  │ user confirmation│  ← ticks, «Інші варіанти», ✅ / ❌             ║
║  │        ↓         │                                               ║
║  │ Apply Changes    │  ← the only node that writes                  ║
║  │        ↓         │                                               ║
║  │ verify + report  │                                               ║
║  └────────┬─────────┘                                               ║
╚═══════════╪═════════════════════════════════════════════════════════╝
            │ JSON-RPC 2.0 over Streamable HTTP
            │ Authorization: Bearer <per-guest token>
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│              SILPO MCP   https://mcp.silpo.ua/mcp                   │
│   cart · products · promotions · coupons · loyalty · delivery       │
└─────────────────────────────────────────────────────────────────────┘
            ▲
            │ OAuth 2.1 + PKCE (S256)
┌───────────┴─────────────────────────────────────────────────────────┐
│  /register (DCR) · /authorize · /token   →  auth.silpo.ua (OTP)     │
└─────────────────────────────────────────────────────────────────────┘
```

## Responsibilities

**Telegram** is presentation only: commands, progress updates, the
recommendation card, confirmation buttons, the final result. It never holds a
token and contains no logic.

**n8n** holds the business logic, split across two workflows:

- `telegram-bot.json` — routing, the optimization pipeline, the write path and
  verification.
- `oauth-callback.json` — the public webhook Silpo redirects to; exchanges the
  authorization code for tokens and stores them encrypted.

**The model** makes every judgement, on data that is already assembled. Per cart
line it **chooses** the replacement, decides whether the purchase intent
survives, judges whether the pack size is acceptable, returns a confidence, names
up to two runners-up, and phrases the reason the customer reads. It reads prices
in order to choose the cheapest acceptable option.

What it does not do is arithmetic. It returns indices and words — `chosen`,
`accept`, `confidence`, `reason`, `verifySize`, `alternates` — and
`computeSaving()` / `buildPlan()` derive every figure from MCP prices. It also
never builds MCP parameters and never sees a token.

That split is measured, not stylistic. Given the arithmetic as well, the model
got **2 of 16 savings wrong on a live 22-item cart**, both on weighted lines, and
its plan total came out 123.64 UAH short of the sum of its own lines. After the
change: 17 of 17 lines, every percentage and every total exact. The earlier
14-item cart had one weighted line and was exact twice, which is why the defect
stayed hidden for as long as it did.

Two consequences follow from the model owning selection:

- **Results are not reproducible** — 6–40% spreads on identical input. Every
  figure this project publishes is a range.
- **There is no rule-based fallback.** An API failure raises `AIUnavailableError`
  and the run stops rather than proposing something a rule invented. The one
  deliberate exception is the receipt wish: it carries no number and is written
  after the cart has already changed, so a static line is less personal, not
  wrong.

---

## Authorization

Verified against the live server on 2026-08-11:

```json
// GET /.well-known/oauth-authorization-server
{"issuer":"https://mcp.silpo.ua",
 "authorization_endpoint":"https://mcp.silpo.ua/authorize",
 "token_endpoint":"https://mcp.silpo.ua/token",
 "registration_endpoint":"https://mcp.silpo.ua/register",
 "grant_types_supported":["authorization_code","refresh_token"],
 "token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],
 "code_challenge_methods_supported":["plain","S256"]}
```

| Fact | Consequence |
|---|---|
| `registration_endpoint` works (`POST /register` → **201**) | No application has to be registered by hand; the workflow obtains its own `client_id` |
| No `client_secret` is returned | Public client with PKCE — nothing secret to store for the client itself |
| `S256` supported | Used; `plain` is never used |
| `refresh_token` supported, `expires_in` = **2592000** | Access tokens live 30 days, so re-authorization is rare |

Flow:

```
1. Guest taps "Connect Silpo" in Telegram
2. Build Auth URL registers a client and generates a PKCE pair + state
3. {state → telegram_user_id, code_verifier} is stored with a 10-minute TTL
4. Guest signs in at auth.silpo.ua (phone + OTP)
5. Browser hits https://<n8n>/webhook/silpo/callback?code=…&state=…
6. Exchange Code validates state, swaps the code for tokens
7. Tokens are AES-256-GCM encrypted and written to the sessions table
8. Every MCP call carries that guest's bearer token
9. On 401 the refresh token is used; if that fails the guest re-connects
```

### Disconnecting

`/logout` asks for confirmation, and only the button clears anything. The
confirmation edits the prompt in place, so the keyboard disappears before the
deletion runs and the tap cannot be repeated.

Confirming wipes `client_id`, both encrypted tokens and `expires_at` from the
session row and deletes every plan belonging to that Telegram user. The row
itself survives because it also carries the brand blocklist, which is a chat
preference rather than an account one.

The plans go because `Validate Plan` only checks that the tapper owns the plan:
a plan computed for the previous account would otherwise still be applicable
against the next account's cart.

Silpo exposes no revocation endpoint, so this removes our stored copy of the
token rather than invalidating it at the provider.

### Presentation layer

Everything the guest reads lives in `src/lib/ui.ts` and nowhere else. It is
inlined into the Code nodes exactly the way the engine modules are, and
`build.ts` imports the same module for the handful of messages that sit in
Telegram node parameters. One copy of every string, one place to change the
wording.

Copy is ordinary TypeScript source there, so a newline is `\n` and an apostrophe
needs no escape — the double-escaping trap that applies to code written inside
the generator's template literals does not apply to text.

Business logic stays where it was: the module receives numbers already computed
by `plan-builder.ts` and formats them. It performs no arithmetic of its own.

`npm run preview` renders every screen out of the generated JSON the way Telegram
paints it, and `npm run preview -- --check` runs its assertions as part of
`npm run check`. Three defects in this project's history were invisible in the
source and obvious in that output: raw `<b>` tags reaching a guest, four cart
lines clipped to the same text, and a message that read as a formula.

### Screens, not messages

The bot is built as a small app rather than a chat script, using the three
surfaces Telegram actually provides:

| Surface | Carries |
|---|---|
| Persistent reply keyboard | Оптимізувати · Мій кошик · Налаштування — always visible |
| Command menu (`setMyCommands`) | every command, as a fallback nobody has to read |
| Inline buttons | the actions belonging to the screen on display |

No screen prints a command. `npm run setup:commands` registers them with the Bot
API instead, which is why the home screen is four lines rather than fourteen.

Navigation — home ⇄ settings ⇄ about ⇄ brands — **edits the message that was
tapped** (`screenRequests` chooses `editMessageText` when a callback is present,
`sendMessage` otherwise). The chat therefore holds one live screen instead of a
stack of dead menus. Results, cards and errors still send: they are records of
something that happened, not navigation.

Two Telegram constraints shape the rest:

- **One `reply_markup` per message.** The persistent keyboard cannot ride on a
  screen that has inline buttons, so it is attached to the progress line — the
  one message every guest passes through that needs no buttons of its own.
- **A callback must be answered** or the button spins for half a minute, which
  reads as a hang. `Build Ack` answers every tap the moment it arrives; the
  screens that show a toast (`Ascania повернуто в пошук`) answer their own,
  since Telegram accepts one answer per query.

### Reading a fifteen-item list

The cart screen is the one that has to survive real data, and the rules that make
it readable apply to every list in the bot:

- **Fixed rhythm.** Every item is exactly two lines. A name that wraps onto a
  third collides with the price beneath it and the price stops being a column.
  Long names are clipped at a word — except when two clipped names collide, as
  four «Напій сокoвмісний Моршинська …» do, in which case those items keep their
  full name. Ambiguity is a property of the list, not of one name.
- **One bold element per line.** The price. Everything else recedes around it.
- **Numbers explain each other.** The line reads like a shelf label — the price
  you pay, then the price you would have paid, struck out. This is why the
  screens are `parse_mode: 'HTML'`: legacy Markdown has no strikethrough, and
  every alternative («акція, було 299,00» on all fifteen lines, or a bare
  «🎁 −100,00 ₴») was either repetition or a puzzle. Where a number has no
  partner to explain it, it gets a word instead: «економія 14,00 ₴».
- **Emoji mark, they do not decorate.** One at the head of a screen title or
  section, one as a status marker on a line: 🎁 promotion, 💰 saving, 💳 bonuses,
  ⏰ expired slot, 📦 pack size. Never two on one line — the render harness fails
  the build if that creeps back in.

### Enforcing all of this

Prose rules decay. These are executable: `src/workflow/screens.ts` loads the UI
module **out of the generated workflow JSON** — never from the TypeScript source,
since only what was emitted proves anything — renders every screen against
fixtures taken from real carts, and asserts the rules above. It runs inside
`npm run check`.

Each assertion exists because the defect it catches shipped at least once:

| Assertion | The defect |
|---|---|
| every body goes through `message()` | `Build Progress` sent `<b>Аналізую кошик…</b>` with the tags showing |
| every Telegram node sets `parse_mode` | the same omission, in node parameters instead of code |
| tags closed, `<`/`&` escaped | a product name would make Telegram reject the whole send |
| one emoji per line | `💰 −8,00 ₴ · 🎁` |
| items all the same height | wrapped names collided with the price line |
| no two clipped lines identical | four «Напій сокoвмісний Моршинська …» rendered the same |
| every entry point reaches a wired branch | the fallback index shifts when a switch rule is added |
| no action wired to two branches | `/blocked` drew its screen twice |

Adding a brand goes through a `force_reply` prompt: the guest types a name, not a
command with an argument. `Route Request` recognises the reply by matching
`reply_to_message.text` against `BRAND_PROMPT_MARKER`, which is derived from the
prompt itself so the two cannot drift apart.

### Why not the built-in n8n MCP node

The MCP Client node holds one static credential per workflow, which means one
Silpo account shared by every user. The brief forbids this outright, and it
would leak one customer's cart to another. MCP is therefore called directly as
JSON-RPC over HTTP, with the token of whichever guest triggered the run.

No separate backend service is needed: the OAuth callback is an n8n Webhook,
PKCE is generated in a Code node, and n8n's own data tables hold the mapping —
there is no external database at all.

### Multi-user isolation

Sessions are keyed on `telegram_user_id`, so a token can only ever be loaded for
the user whose Telegram update triggered the run.

Plans are scoped the same way, and both plan-reading branches re-check it —
`Validate Plan` before writing and `Format Details` before displaying. The check
moved into code because: data table filters support
equality only, so `Load Plan` fetches by `plan_id` and **`Validate Plan`**
enforces ownership, `pending` status and the 30-minute TTL in code. That
ownership check is a security boundary — a leaked plan id must not be enough to
modify somebody else's cart.

---

## Pipeline

```
silpo_get_my_shopping_cart              → shoppingCartId
        ↓
silpo_get_shopping_cart_by_id           → branchId, deliveryType, timeslot,
                                          items, calculation, loyalty
        ↓
silpo_get_time_slots                    → repair an expired slot
        ↓
   ┌──────────────── in parallel, once per run ───────────────┐
   │ get_promotions · get_my_coupons · get_promo_codes ·      │
   │ get_my_promos · get_loyalty_info                         │
   └──────────────────────────────────────────────────────────┘
        ↓
per cart line (concurrency 3, exponential backoff on 429):
   get_similar_products(branchId, slug, deliveryType)
   get_replacements(productIds[]) — one batched call for out-of-stock lines
        ↓
rejectReason() gate — availability · stock · price basis · pack size ·
                      unit price · fat grade · saving floor · blocked brand
        ↓
one model call per surviving line → chosen · accept · confidence ·
                                    reason · verifySize · alternates
        ↓
get_product_details(chosen) — confirm availability, brand and price;
                              fall through to the next candidate on failure
        ↓
rejectReason() again, on the confirmed price
        ↓
computeSaving() / buildPlan() — every figure, in code
        ↓
                    Telegram card → user confirmation
        ↓
add_or_update_cart_products + remove_cart_products   (add first, always)
        ↓
silpo_get_shopping_cart_by_id           → actual saving
```

Measured on a real 14-item cart: **22 MCP calls, 2.1 s, zero retries** for the
read pipeline. The model adds one call per surviving line — 6 calls and 12.7 s
on a measured 19-line cart, at roughly \$0.097 per analysis.

### The gate, and what it may never decide

`rejectReason()` in `candidate-filter.ts` runs before the prompt and again on the
confirmed price. It may only encode things the API states outright — availability,
stock, price basis, pack ratio, unit price, the fat percentage in a name, the
saving floor. Its job is to hand the model a shorter, honest pool: on a 19-line
cart it rejected 468 candidates, 148 of them for a price basis mismatch alone.

It must never grow a rule about what a product is *for*. Kombucha against juice,
protein against dessert, children's food against ordinary — those stay the
model's, because a category rule engine for them would be brittle and wrong.

### Two prices are only comparable on the same basis

A weighted line's `price` is **per kilogram**; a packaged product's is **for one
pack of `displayRatio`**. Both may print «100г», and nothing but the `weighted`
flag distinguishes them. Compared directly, a 6% saving was once reported as
**−90.61%** and made up 72.40 of a 103.00 UAH headline — and would have added
*0.1 of a pack* to the cart, because the apply step reuses the original line's
quantity. `unitPrice()` is the only honest comparison, and a mismatch across the
`weighted` boundary is a rejection, never a conversion.

### Confidence, and the modes

Confidence has to change what happens, or it is decoration:

```
>= confidentAt(mode)    offered and ticked
>= minConfidence(mode)  offered, explained, NOT ticked
<  minConfidence(mode)  not offered
```

| mode | pack size | offered from | ticked from | brand |
|---|---|---|---|---|
| `conservative` | 0.95–1.05 | 0.75 | 0.85 | prefers the same |
| `balanced` | 0.8–1.25 | 0.60 | 0.80 | free |
| `max` | 0.6–1.7 | 0.55 | 0.80 | free, and said so |

The thresholds live in `MODES` in `optimization-modes.ts` and nowhere else. The
tick bar deliberately does not drop in a bolder mode: bolder means *shown* more,
never *applied* more on behalf of somebody who is not reading.

### Runners-up

Selection returns up to two acceptable alternates beside the pick. Each line that
has them carries «Інші варіанти» on the card, and choosing one promotes it to the
primary — the demoted pick goes to the head of that line's alternates, the saving
and the headline follow from `plan-builder.ts`, and the checkbox does not move.
Nothing is searched or judged again: the alternates were confirmed during the
original run, so the tap costs no MCP call and no model call. Confirming them is
what makes that safe, and it is why `Optimize Cart` walks the whole option list
through `get_product_details` instead of stopping at the first success — the CLI
does stop there, because it renders no card.

### The slot repair step

`get_promotions`, `get_products` and `get_product_details` all require
`timeslotStart` / `timeslotEnd`, and the recommended source for those is the
cart. A cart whose slot has passed reports
`validations: [{level: "error", type: "timeslot"}]` and cannot be checked out.
The pipeline therefore refreshes the slot from `get_time_slots` before using it
as promo context. This step is not in the original brief; it was added after the
condition showed up on a real cart.

---

## Write safety

Order of operations is fixed:

```
analysis → recommendation → user confirmation → write
```

- No write tool is reachable before the `apply:<plan_id>` callback. `Apply
  Changes` sits behind the Switch node's `apply` output and nothing else routes
  into it.
- The cart is re-read immediately before writing. Replacements whose original is
  no longer present are skipped, and if none remain the run aborts with an
  explanation.
- The replacement is **added first**, the original removed second. If the add
  fails, the cart is unchanged rather than short an item.
- After writing, the cart is read again and the headline number is the real
  total difference — never the predicted one.
- Plans expire after 30 minutes, because prices and stock move.
- A plan moves `pending → applying → applied` and is claimed **before** the first
  write, so a second tap on ✅ is rejected instead of applying everything twice.
  The error path sets `failed`, so a crashed run does not hold the claim.

---

## Risks

| Risk | Mitigation |
|---|---|
| No sandbox — the cart is a real one | Confirmation gate, add-before-remove, mandatory verification |
| Saving is not guaranteed | An empty result is valid and is reported honestly |
| A replacement is a smaller pack at a better ticket price | `displayRatio` gives the candidate's pack size; the gate rejects outside the mode's band and rejects a worse unit price. Unparseable sizes are flagged `verifySize` and re-checked against the cart after the add |
| Two prices quoted on different bases | A `weighted` mismatch is an outright rejection; `unitPrice()` is the only cross-product comparison |
| Rate limits | Concurrency 3, exponential backoff with jitter, promo context fetched once |
| Prices change between analysis and apply | Verification step reports the actual number, plans expire |
| Cart modified by another session | Cart re-read and diffed before writing |
| Model invents a price | It returns indices and words; `computeSaving()` and `buildPlan()` derive every figure from MCP prices. Measured: given the arithmetic, it got 2 of 16 wrong |
| The model is unavailable | The run stops with `AI unavailable`. There is no rule-based fallback, because one would make unverifiable claims about money that look identical to real ones |
| A saving the guest already has, counted twice | `calculation.subDiscount` is stated beside the headline, never summed into it; coupons are shown as a count, never a value; bonuses stay out entirely |
| Telegram's 4096-character limit | Top five replacements shown, rest behind a button |
