# Working rules for this project

Derived from how this codebase was actually built. Most of these exist because
the opposite approach already failed here at least once.

---

## 1. The live server outranks its documentation

Never take an API shape from prose. Read it from `data/mcp-tools.json`, or call
the tool and look at the response.

This is not a stylistic preference — the published Silpo docs contradict the
real API in three places we hit directly:

- `silpo_update_shopping_cart` does **not** change cart contents (it updates
  delivery, slot, address, promo code, bonuses). Replacing an item is
  `remove_cart_products` + `add_or_update_cart_products`.
- `silpo_get_similar_products` takes a **`slug`**, not a `productId`, and also
  requires `branchId`.
- `add_or_update_cart_products` needs `productId` + `companyId` + `branchId` for
  every product, not just the id.

If documentation and `tools/list` disagree, `tools/list` wins. Re-run
`npm run authorize` to refresh the dump.

## 2. Never invent identifiers, parameters or schemas

Slugs, ids and enum values come from a previous response — always. Silpo
generates slugs and they cannot be derived from a product name; guessing one
returns `Resource not found`. (This rule was broken once in this project and
failed immediately.)

Same for parameters: check `inputSchema.required` before writing a call.

## 3. The model never produces a number

All arithmetic — prices, savings, totals, percentages — happens in deterministic
code in `src/lib/optimizer.ts`. Prices originate exclusively from MCP responses.

The semantic layer returns `accept` / `confidence` / `reason` and nothing else.
When adding a model step, recompute every total after it, in code.

## 4. Code inside template literals is two layers deep

Node code lives in TypeScript template literals in `src/workflow/build.ts`, so
every escape is processed twice before it reaches n8n. Three failures came from
this, all silent or misleading:

- A **backtick in a comment** ends the template literal. This has broken the
  build four times now — write "the require() call", never wrap it in backticks.
  A validator check for it was tried and removed: the inlined `optimizer.ts` code
  legitimately contains backticks in its comments, so the rule cannot be enforced
  from the generated output. `npm run typecheck` catches it, but the error points
  at a line far from the cause — if tsc reports an unexpected `,` or an
  unterminated string in `build.ts`, look for a backtick first.
- `\n` inside the template becomes a real newline in the emitted code and splits
  a string across lines. Write `\\n`.
- `\[` and `\]` are eaten by the template, so `/([_*\[\]])/g` emitted a broken
  character class that matched nothing and escaped nothing. Prefer
  `String.fromCharCode(92)` and `indexOf` over regex literals with escapes.

`npm run typecheck` catches the first two. The third only shows up in output, so
test the emitted code, not the source.

## 5. One source of truth for the engine — and for the copy

`src/lib/optimizer.ts` (engine) and `src/lib/ui.ts` (every guest-facing string
and keyboard) are transpiled and inlined into the n8n Code nodes by
`src/workflow/build.ts`.

- **Never hand-edit `workflows/*.json`.** It is generated output.
- Change logic in `src/lib/`, then `npm run build:workflows`.
- Finish with `npm run check` (typecheck → build → validate → screens) before
  calling anything done.

`npm run preview` renders every screen out of the generated JSON the way Telegram
paints it — bold, italic, struck-through, buttons. **Look at it after any change
to the copy.** Three of the defects in this file's history were invisible in the
source and obvious in that output: raw `<b>` tags, four cart lines clipped to the
same text, and a message that read as a formula.

`npm run preview -- --check` runs the assertions alone and is part of
`npm run check`, so a screen that breaks a rule fails the build rather than
reaching a guest.

## 6. Writes require explicit human confirmation

There is no Silpo sandbox. Every cart operation touches a real customer's cart.

- CLI tools are read-only. `npm run optimize` must never call a write tool.
- In the bot, write nodes are reachable only through the `apply:<plan_id>`
  callback — after the user taps ✅.
- **Claim the plan before writing, not after.** Marking it applied only at the
  end leaves a window as long as the run itself, and a second tap on ✅ applies
  everything twice. `pending → applying → applied`, with `failed` on the error
  path so a crashed run cannot hold the claim forever.
- Acknowledge the tap immediately. A silent button invites a second press, which
  is what caused the double-apply in the first place.
- Before writing: re-read the cart and skip anything that changed.
- Order matters: **add the replacement first, remove the original second.** A
  failed add then leaves the cart intact rather than short an item.
- After writing: re-read and report the *actual* difference, never the predicted
  one.

## 7. Report honestly, including what was not verified

State plainly which claims are backed by a live run and which are not. Never
present an untested path as working. Never round a demo metric upward.

When a number is inflated by known-weak filtering, say so and give the
conservative figure as the headline — as `docs/engine-findings.md` does with
96.81 vs 407.83 UAH.

## 8. A flag that causes rejection must also affect selection

`verifySize` marks a candidate the semantic layer will refuse. While selection
ignored it, the deterministic layer kept handing over its highest-scoring
candidate — the flagged one — and the line ended up with **no** replacement even
though two clean alternatives were right behind it.

Sour cream at 32.99 scored 0.9 and was chosen; the 52.99 same-brand, same-size
option scoring 0.63 was never seen. Whenever a downstream stage can veto, sort
the veto-prone candidates last rather than discovering the veto after the fact.

## 9. Flag it when an agreed approach turns out inert

If a decision the user approved stops making sense once real data arrives, say
so rather than silently substituting something else.

Precedent: a size guard was agreed on, then measurement showed **0 of 180**
candidate names contain a size, making it dead code. The guard was kept, a
working alternative (`verifySize`) was added, and the deviation was reported.

Related: do not change the ranking formula from `docs/brief.md` without
proposing it first.

## 10. Secrets

- Everything sensitive lives in `.secrets/` (gitignored, mode `0600`).
- Never write a token, key or connection string into source, docs, or the
  generated workflow JSON. `npm run validate` scans for exactly this.
- Never log access tokens or authorization headers.
- Tokens at rest are AES-256-GCM encrypted; Telegram only ever receives a
  `plan_id`.
- Persist only what a later step needs. The stored plan carries ids, quantities,
  names and savings — not scores or diagnostics.
- Per-user isolation is mandatory: sessions and plans are keyed on
  `telegram_user_id`, and one shared Silpo account for all users is not
  acceptable.

## 11. Telegram

- **Buttons are the interface; commands are the fallback.** No screen prints a
  command — they are registered with `npm run setup:commands` and live under
  Telegram's «/» menu. A new capability gets a button on the screen it belongs
  to, not a line of text on the home screen.
- **A message carries one `reply_markup`.** The persistent keyboard therefore
  cannot share a message with inline buttons; it rides on the progress line,
  which needs none. Moving it means finding another button-free message.
- **Answer every callback.** An unanswered tap spins for ~30 s, reads as a hang
  and invites the second press that once caused a double apply. `Build Ack`
  covers every branch; only screens that show a toast answer their own, because
  Telegram accepts one answer per query.
- Navigation edits the tapped message (`screenRequests`); results and errors
  send. A screen that appends instead of editing leaves dead menus behind.
- **Messages are `parse_mode: 'HTML'`, not Markdown.** The reason is `<s>`: a
  struck-out old price says "discount" with no word to decode, and legacy
  Markdown has no strikethrough. Escape dynamic text with `esc()` — `&`, `<`,
  `>` — and use the `b()` / `i()` / `s()` helpers rather than writing tags by
  hand. Never mix in `*bold*`; it will render literally.
- **Build every message body with `message()`.** It is the only thing that sets
  `parse_mode`, and a body assembled by hand renders `<b>Аналізую кошик…</b>`
  with the tags showing. That shipped once, from `Build Progress`, and nothing
  in the type system or the validator noticed — the helper exists so the mistake
  is no longer possible to make.
- **Emoji mark, they do not decorate.** One per screen title or section, one per
  line as a status marker (🎁 акція, 💰 економія, 💳 балабонуси, ⏰ слот, 📦
  об'єм). Two on one line is the point where a product starts looking like a
  toy — and where a fifteen-item cart stops being scannable.
- **A number needs a label or a partner.** «🎁 −100,00 ₴» was minus what, off
  what? Either put a word beside it («економія 14,00 ₴») or pair it with the
  number that explains it (new price beside the struck-out old one). A bare
  signed number in a row of prices reads as a third price.
- **Lists keep a fixed rhythm** — every item the same number of lines, names
  clipped at a word by `clipAll()`. That helper decides the clip **from the whole
  list**: Silpo writes a product family as one long shared prefix plus one
  distinguishing word past any sensible cut, so four «Напій сокoвмісний
  Моршинська …» clip to four identical rows. Colliding clips are thrown away and
  those items keep their full name. Never clip a name in isolation.
- The n8n Telegram node renders a keyboard declared in its parameters, so it
  cannot produce one button per replacement. The selection card and its updates
  go through the Bot API via HTTP Request, with `reply_markup` built in code.
- `callback_data` is capped at **64 bytes**. That is why `plan_id` is a short
  random key rather than cartId + timestamp.
- `replyMarkup` and `inlineKeyboard` are top-level parameters of the Telegram
  node. Nested inside `additionalFields` they are silently ignored and the
  message arrives without buttons.
- Set `appendAttribution: false`, or every message carries an n8n footer.

## 12. Language

- Code, comments, identifiers, docs, log output: **English**.
- Strings the customer reads in Telegram, and the model prompt that generates
  them: **Ukrainian** — the bot serves Silpo guests. They all live in
  `src/lib/ui.ts`, which is inlined into the Code nodes the same way the engine
  is. Do not write guest-facing text anywhere else, and do not reintroduce it
  into the template literals in `src/workflow/build.ts` — that file interpolates
  the module, so copy written there loses the escaping-free property that makes
  the module safe.
- Cyrillic in code is acceptable only as data examples (`"112,5г"`, `«Напій»`)
  or matching patterns.
- `docs/brief.md` is the original brief and stays verbatim in Ukrainian.
- The receipt wishes in `RECEIPT_WISHES` are written for this project in the
  spirit of Silpo's printed ones. Silpo's actual receipt texts are their own
  authors' work — do not copy them in.

## 13. TypeScript, no build step

Node 22 runs `.ts` directly via `--experimental-strip-types`. Consequences:

- Type-only syntax only — no enums, namespaces or parameter properties
  (`erasableSyntaxOnly` is on).
- Use `import type` for types and explicit `.ts` extensions in imports.
- `strict` is on and `npm run typecheck` must stay clean.
- Runtime dependencies: none. Keep it that way; `typescript` is dev-only.

## 14. Storage is n8n data tables

There is no external database. Three tables live inside n8n and their ids are
compiled into `TABLES` in `src/workflow/build.ts`.

Consequences to respect:

- **Filters do equality only.** Anything time-based — the 10-minute OAuth state
  TTL, the 30-minute plan TTL — is fetched by key and then checked in a Code
  node against the system `createdAt` column.
- Ownership checks moved into code as well. `Validate Plan` enforces
  `telegram_user_id`, `status` and age; do not weaken it.
- `insert` is the node's default operation and is serialized **without** an
  `operation` key. Every other operation names itself.
- Column mappings need the `schema` array alongside `value`, or the resource
  mapper will not bind the fields.
- Recreating a table changes its id — update `TABLES` and rebuild.

## 15. Rate limits and resilience

Silpo rate-limits per user. Any new MCP fan-out must:

- go through `mapLimit` with concurrency ≤ 3;
- retry `429`/`5xx` with exponential backoff and jitter (already in
  `src/lib/mcp.ts`);
- fetch per-run context (promotions, coupons, loyalty) once, not per item;
- prefer batched tools — `get_replacements` accepts a `productIds[]` array.

A tool can fail **inside a 200 response** (`isError: true`), which the HTTP
retry never sees. Write calls therefore retry on tool errors as well, and
sequential writes against one cart are spaced out — a burst of them is exactly
when Silpo starts refusing.

Never guess why a call failed. Report the server's own wording: a hardcoded
"item is probably out of stock" once hid the real cause, and the products turned
out to be in stock.

Handle `401` with the refresh token; if that fails, ask the user to reconnect.
Never surface a stack trace to the customer — map failures to plain guidance in
the `Handle Error` node.

---

## Project facts worth remembering

- Access tokens live **30 days** and refresh; re-authorization is rare.
- Dynamic Client Registration works (`POST /register` → `201`, no
  `client_secret`), so no application needs manual registration.
- The MCP server is **stateless** — it issues no `Mcp-Session-Id`.
- Responses may be `application/json` *or* `text/event-stream`; both are parsed.
- **Pack size for candidates is unavailable.** `ratio` exists only on cart lines.
  Every product-returning tool was scanned — search, details, sets, favorites,
  order history — and none carries it. silpo.ua shows it, but that is the
  storefront's own API, which the rules exclude.
- Silpo reuses one product name across pack sizes, so an identical name with a
  materially lower price means a smaller pack rather than a bargain. This is the main quality ceiling — if
  `displayRatio` ever appears in search results, `sizeOf()` picks it up with no
  other change.
- `similar_products` returns the original product itself as a candidate; always
  filter on `candidate.id !== original.productId`.
- `get_promotions` returns campaign codes, not per-product discounts. A specific
  discount is `oldPrice` vs `price`.
- An expired cart timeslot puts the cart in `validations: error` **and reports
  `stock: 0` for every line**, so cart stock is meaningless until the slot is
  repaired. `get_time_slots` fixes it for our own calls; fixing the cart itself
  would be a write.
- Pack size is readable **once an item is in the cart**. The apply step exploits
  this: add the replacement, re-read, compare `ratio`, roll back on mismatch.
  The band is 0.8-1.25, not "within 2x" — a smaller pack at a slightly better
  unit price is still less product, and buying two costs more than the original.
- The apply step carries up to three confirmed candidates per line and retries in
  rounds, so a wrong pack size is substituted rather than abandoned. Batch by
  round, never per item: one cart read per round keeps it at three reads total.
- Search availability is not cart availability: `available: true` with stock can
  still land as «Очікується». Trust cart stock only when the original line also
  reports stock — an expired slot zeroes every line.
- **`similar_products` availability is stale; `get_product_details` is not.** The
  details call agrees with the cart, so the chosen candidate is confirmed there
  before being proposed, falling back to the next best when it fails.
- Brand comes from `attributes["Торгова марка"]` in `get_product_details`, which
  the pipeline already calls to confirm availability — present in 16 of 16 sampled
  products. Names are unreliable for this, so the blocklist matches the attribute
  and only uses the name as a cheap pre-filter.
- **The same brand appears in both alphabets**: «Премія» in names, `PREMIA` in the
  attribute; «Асканія» / `Ascania`; «Яготинське» / `Yagotynske`. Compare through
  `normalizeBrand()`, which transliterates and folds the predictable spelling
  splits (k/c, h/g, y/j→i, doubled vowels). Exact string matching silently fails
  precisely when a guest blocks a brand by its Ukrainian name.
- Fat percentage **is** in product names (139 of 288) and separates grades that
  names alone do not: butter 82% vs 72.5%, sour cream 15% vs 20%. Candidates
  whose percentage differs by more than 1 point are rejected — the brief requires
  2.5% milk to be replaced by 2.5% milk.
- Regexes over Ukrainian text must not rely on `\b` — Cyrillic letters are not
  word characters in JavaScript, so the boundary never matches.
- Loyalty bonuses are never counted as saving — only a checkout response can
  confirm them.
