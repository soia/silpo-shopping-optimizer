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
║  │        ↓         │         │  telegram_user_id →      │          ║
║  │ AI Semantic Check│         │  encrypted tokens        │          ║
║  │        ↓         │         └──────────────────────────┘          ║
║  │ user confirmation│                                               ║
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

**The model** does three things, all on data that is already assembled:
judge semantic similarity, reject candidates that change the purchase intent,
and phrase the reason shown to the customer. It never builds MCP parameters,
never sees a token, and never produces a number — all arithmetic happens in
deterministic Code nodes.

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
deterministic scoring  →  semantic check  →  Telegram card
        ↓
                    user confirmation
        ↓
remove_cart_products + add_or_update_cart_products
        ↓
silpo_get_shopping_cart_by_id           → actual saving
```

Measured on a real 14-item cart: **22 MCP calls, 2.1 s, zero retries.**

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
| Candidate pack size is not exposed by the API | Suspicious-drop flag plus a visible warning; see [engine-findings.md](engine-findings.md) |
| Rate limits | Concurrency 3, exponential backoff with jitter, promo context fetched once |
| Prices change between analysis and apply | Verification step reports the actual number, plans expire |
| Cart modified by another session | Cart re-read and diffed before writing |
| Model invents a price | The model returns accept/reject only; all arithmetic is deterministic |
| Telegram's 4096-character limit | Top five replacements shown, rest behind a button |
