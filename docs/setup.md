# Setup

Ten steps from an empty n8n instance to a working bot.

```
[x] Create the Telegram bot          → @SilpoBasketAIBot
[x] Stand up n8n with a public URL
[x] Create the three n8n data tables
[ ] Generate TOKEN_ENCRYPTION_KEY and set it in n8n
[ ] Create the Telegram credential in n8n
[ ] Set ANTHROPIC_API_KEY as an n8n Variable (required — the model is the engine)
[ ] Import both workflows (two separate workflows, not one canvas)
[ ] Publish both workflows
[ ] Run the test scenario
```

---

## 1. Telegram bot — done

**Where:** @BotFather in Telegram.
**Do:** `/newbot` → name → username.
**Result:** bot **[@SilpoBasketAIBot](https://t.me/SilpoBasketAIBot)** ("Silpo
Basket AI"), verified through `getMe`.
**Goes into:** n8n → Credentials → Telegram API (step 7).

The command menu and the bot description are already configured via
`setMyCommands` / `setMyDescription`:

```
start    - Почати роботу
connect  - Підключити акаунт Сільпо
optimize - Оптимізувати кошик
cart     - Показати кошик
```

> Bot tokens have been pasted into a chat during development. Run `/revoke` in
> @BotFather and update the credential before any public demo.

---

## 2. n8n with a public HTTPS URL — done

Needed twice: the Telegram webhook and the OAuth redirect.

**Where:** [n8n.io](https://n8n.io) → Sign up (14-day trial).
**Result:** a URL such as `https://your-instance.app.n8n.cloud`.
**Goes into:** `.secrets/n8n.json` — see step 3.

Self-hosted works too, but `WEBHOOK_URL` must point at a public domain or
neither Telegram nor Silpo can reach the instance.

---

## 3. Data tables — done

Storage lives inside n8n, so there is no external database and no credential for
it. **Overview → Data tables**, three tables:

| Table | Columns |
|---|---|
| `silpo_oauth_state` | `state` (string), `telegram_user_id` (number), `chat_id` (number), `code_verifier` (string), `client_id` (string) |
| `silpo_sessions` | `telegram_user_id` (number), `client_id` (string), `access_token_enc` (string), `refresh_token_enc` (string), `expires_at` (string), `blocked_brands` (string), `size_tolerance` (string) |
| `optimization_plans` | `plan_id` (string), `telegram_user_id` (number), `cart_id` (string), `plan_json` (string), `original_total` (number), `status` (string) |

n8n adds `id`, `createdAt` and `updatedAt` to every table automatically; the
TTL checks use `createdAt`.

> **If the tables already exist**, add two columns (both string) to
> `silpo_sessions`:
>
> - `blocked_brands` — the brand blocklist, pipe-separated. Without it `/block`
>   fails on write.
> - `size_tolerance` — the optimization mode the guest picked in Settings:
>   `conservative` / `balanced` / `max`. The column keeps its old name because
>   it already holds the three pack-size presets (`strict` / `normal` /
>   `loose`) that modes replaced, and `resolveMode()` folds those onto the mode
>   carrying the same band — so nothing needs migrating. An unrecognised value
>   reads as `balanced`.
>
>   **A table created before modes existed does not have this column, and adding
>   it to the workflow does not create it.** Reading tolerates its absence;
>   writing does not — the Data Table node throws `unknown column name` and then
>   swallows the error, so tapping a mode confirms itself and saves nothing.
>   Measured on a live table: `Add Column` → `size_tolerance` → **String** fixes
>   it, and the table id does not change.

> Table ids and the instance URL are compiled into the workflows. Put yours in
> **`.secrets/n8n.json`** (gitignored) and rebuild:
>
> ```json
> {
>   "baseUrl": "https://your-instance.app.n8n.cloud",
>   "tables": { "oauthState": "...", "sessions": "...", "plans": "..." },
>   "telegramCredentialId": "..."
> }
> ```
>
> ```bash
> npm run build:workflows
> ```
>
> An id is visible in the URL of each table in n8n. Recreating a table changes it.

---

## 4. Encryption key

```bash
openssl rand -hex 32
```

**Result:** 64 hex characters.
**Goes into:** the `TOKEN_ENCRYPTION_KEY` variable (step 6).

This key encrypts Silpo tokens at rest. Losing it forces every user to
re-authorize.

---

## 5. Anthropic API key — required

The model is the engine: it picks every replacement, judges whether the purchase
survives and scores its own confidence. It does **not** compute the figures —
`plan-builder.ts` derives those from MCP prices — but without a key nothing gets
picked at all, so the bot has nothing to propose and the run fails with a plain
message. There is no rule-based fallback.

1. [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key
   (\$5 of credit is plenty for a demo — top the balance up, or every request
   returns `400 credit balance is too low`).
2. n8n → Settings → **Variables** → New variable, name `ANTHROPIC_API_KEY`,
   scope Global.

**A Variable, not a Credential.** The call lives inside the `Optimize Cart` Code
node, which already has an HTTP transport and makes one request per cart line —
something an HTTP Request node cannot do. Code nodes cannot read credentials, so
the key travels the same channel as `TELEGRAM_BOT_TOKEN`. There is no
`AI_SEMANTIC_CHECK` flag left to flip and no `Anthropic API` credential to
create.

Cost per analysis: **one model call per cart line that survives the gate**, at
`effort: medium` — so 14 calls on a 14-item cart, and fewer when the gate empties
a line's pool. Measured on a live 14-item cart: **~\$0.097 per analysis, roughly
51 runs per \$5** of credit. That measurement predates the removal of the totals
call, so it counts one call more than a run costs today — the figure is a
ceiling, not an estimate to round up from.

The receipt wish is one further call, on the apply path only, and costs about
2% of a run.

The selection system prompt is cached (`cache_control: ephemeral`), which cuts
~22% off that. It is 1161 tokens against Sonnet 5's 1024-token minimum, so
shortening that prompt by ~140 tokens would silently stop it caching — the API
reports no error, only `cache_read_input_tokens: 0`. `npm run optimize` prints
that counter on every run for exactly this reason.

---

## 6. Variables

**Where:** n8n → Settings → **Variables** → New variable.

| Key | Scope | Required | Value |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | **Global** | yes | 64 hex characters from step 4 |
| `TELEGRAM_BOT_TOKEN` | **Global** | yes | the bot token from step 1 |
| `ANTHROPIC_API_KEY` | **Global** | yes | the key from step 5 — the engine cannot run without it |
| `N8N_BASE_URL` | Global | no | Overrides the URL compiled into the workflows |

`TELEGRAM_BOT_TOKEN` duplicates what the Telegram credential already holds. It is
needed because most screens build their keyboard in code — the selection card has
one button per replacement, the brands list one per brand, and navigation edits
the message that was tapped — while the n8n Telegram node only renders a keyboard
fixed at design time. Those messages go through the Bot API directly, and a Code
node cannot read a credential.

### Register the command menu

Run once per bot, from the repository:

```bash
TELEGRAM_BOT_TOKEN=… npm run setup:commands
```

This is what keeps commands out of the messages: they appear under Telegram's
«/» menu instead, as the fallback they are. Skipping it does not break anything —
the commands still work — but nothing on screen will mention them.

Pick **Global**, not Personal: the workflow reads the value on every execution,
whoever triggered it.

The Code nodes read `$vars` first and fall back to `$env` — each in its own
`try`/`catch`, because n8n Cloud defines `$env` but throws *"access to env vars
denied"* on any property read, so one shared guard would swallow the `$vars`
value too. On Cloud only `$vars` ever answers; the `$env` branch exists for
self-hosted Community, where Variables are a licensed feature but real
environment variables are available.

The instance URL is compiled in, so only the encryption key has to be created.
If the instance moves, either add `N8N_BASE_URL` or change `DEFAULT_BASE_URL`
in `src/workflow/build.ts` and rebuild.

There is deliberately no `SILPO_CLIENT_ID`: the client registers itself through
Dynamic Client Registration.

---

## 7. Credentials

n8n → Credentials → + Add credential. The names must match the workflow JSON:

| Type | Name | Value |
|---|---|---|
| Telegram API | `Silpo Bot` | token from step 1 |

One credential is all the build needs. Storage is n8n's own data tables, and the
Anthropic key is a Variable rather than a credential (step 5).

**Create it before importing, and put its id in `.secrets/n8n.json`.** n8n binds
a node's credential by id first and falls back to the name only afterwards, so a
credential id that does not exist in the target instance leaves all fourteen
Telegram nodes unbound — and a workflow with an unbound node refuses to publish,
with the Publish button greyed out rather than any explanation. The id is the
last segment of the URL while the credential is open.

---

## 8. Import

n8n → Workflows → Import from File:

Import the personalised build, not the tracked one:

1. `.secrets/workflows/telegram-bot.json` — 61 nodes
2. `.secrets/workflows/oauth-callback.template.json` — 9 nodes

The files under [`workflows/`](../workflows/) are the same workflows built with
placeholder values, so the repository carries nobody's instance. `npm run
build:workflows` writes both: placeholders to `workflows/`, and a copy wired to
your `.secrets/n8n.json` under `.secrets/workflows/`.

Check that credentialed nodes are not showing a red warning triangle; if they
are, open the node and pick the credential from the list.

---

## 9. Publish and verify the redirect URI

Publish both workflows — recent n8n Cloud replaced the "Active" toggle with
**Publish / Unpublish** (workflow versioning). Until a workflow is published,
neither the Telegram webhook nor the OAuth callback exists.

Confirmation looks like *"Your workflow will now listen for events from
Telegram"* and *"You can now make calls to your production webhook URL"*.

> Changing the Telegram credential does **not** re-register the webhook.
> Unpublish and publish again, otherwise Telegram keeps delivering to the old
> bot. Telegram also never clears the previous bot's registration — call
> `deleteWebhook` on it, or both bots will post into the same workflow.

Open the **Webhook /silpo/callback** node and confirm its Production URL is
exactly:

```
https://<your-instance>/webhook/silpo/callback
```

This is the `redirect_uri` compiled into the workflows and registered with
Silpo. If the two disagree, sign-in fails with `redirect_uri_mismatch`.

Quick check from a terminal — anything other than 404 means the webhook is live:

```bash
curl -o /dev/null -w '%{http_code}\n' \
  'https://<your-instance>/webhook/silpo/callback?state=probe'
```

---

## 10. Test scenario

```
1.  Open @SilpoBasketAIBot in Telegram
2.  /start           → home, one button: "Підключити «Сільпо»"
3.  tap it           → "Увійти в «Сільпо»" link button
4.  tap that         → auth.silpo.ua → phone + OTP
5.  Browser          → "Акаунт підключено"
6.  Telegram         → "Акаунт підключено" + "Оптимізувати кошик"
7.  tap Оптимізувати → "Аналізую кошик…", and the persistent keyboard appears
                       under the input field: Оптимізувати / Мій кошик / Налаштування
8.  after ~5–10 s    → savings card, one checkbox per replacement
9.  tap a checkbox   → it unticks in place, totals recalculate, no new message
10. "Деталі"         → full breakdown with reasons, prices, brands
11. "Застосувати · N"→ only the ticked ones are applied, then "Мій кошик"
12. keyboard: Налаштування → account state, brand count, "Як це працює"
13. "Марки"          → list with a ✕ on each row
14. "+ Додати марку" → prompt; reply with just the name, no command
15. tap a ✕          → row disappears, toast confirms, message edits in place
16. "‹ Назад" twice  → Settings, then home — still one message, not four
17. "/" menu         → every command listed by Telegram itself
18. /logout          → confirmation button, then "Акаунт від’єднано"
19. /optimize        → asks to connect again (a different account can be used)
20. Verify the total in the Silpo app
```

### Expected result

From a real run on 2026-08-12 (14 items):

```
Before:   1042,30 UAH
After:      945,49 UAH
Saving:      96,81 UAH (9.3%)

14 items analyzed · 5 replacements · 4 on promotion
Loyalty bonuses: 34.24 (potential)
```

Those figures came from the deterministic engine that has since been removed.
The current all-model engine measured **37.50 and 40.00 UAH on two runs of the
same cart** — lower, and no longer reproducible run to run, because the model
chooses the candidate. The drop is mostly honest: `displayRatio` now exposes
pack size, so the smaller-pack "bargains" that inflated the old number are
rejected. Details in [engine-findings.md](engine-findings.md).

---

## What the bot's messages mean

Three outcomes look like failures but are the guard rails working. Each is
explained inline in Telegram; the reasoning is here.

**📦 Відхилено через об'єм упаковки.** Silpo returns no pack size in any search
response, only on cart lines — so the size of a replacement becomes visible only
after it is added. The apply step adds it, re-reads the cart, and rolls it back
when the pack falls outside 0.8–1.25× of the original. A 300 g sour cream
replaced by 180 g is 4% cheaper per gram but 40% less product: two packs cost
more than the original, so it is not a saving.

**🚫 Немає в наявності — залишив оригінал.** `silpo_get_similar_products`
reports availability that lags behind the cart: `available: true` with stock, for
a product the cart marks «Очікується». The cart wins, and the original stays.

**🔄 Підставив інший товар.** The first choice failed one of the two checks
above, so the next confirmed candidate went in instead. Up to three candidates
per line are carried in the plan for exactly this.

None of these can be decided before the write, which is why the recommendation
card says so up front rather than promising a saving it cannot yet guarantee.

---

## Troubleshooting

**Bot silent.** The workflow is not published, or the webhook still points at a
different bot. Check with
`curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` — an empty `url`
means Telegram has nowhere to deliver. No executions at all points the same way.

**`redirect_uri_mismatch`.** The Webhook node's Production URL differs from
`DEFAULT_BASE_URL` in `src/workflow/build.ts`. Compare character by character,
trailing slash included.

**`TOKEN_ENCRYPTION_KEY must be 64 hex chars`.** The variable is unset or
malformed. Regenerate with `openssl rand -hex 32`.

**"Доступ до акаунта втратив силу".** The refresh token failed; `/connect`
again. Silpo access tokens last 30 days, so this should be rare.

**Saving is 0 UAH.** A legitimate outcome: nothing in the cart has a cheaper
equivalent that preserves the purchase. Branded items give a better demo.

---

## Moving off n8n Cloud

n8n Community Edition is free to self-host, and the bot needs exactly one change
to run on it:

| Requirement | Community Edition | Consequence |
|---|---|---|
| Data tables | **available** — rolled out to all plans in v1.113 | storage moves as-is; only the table ids change |
| Variables (`$vars`) | **not available** — "Custom Variables" is a paid feature | the two secrets come from `$env` instead |
| A public HTTPS URL | your own concern | needed for the Telegram webhook **and** the OAuth `redirect_uri` |

Data tables are not a blocker and no storage rewrite is involved. n8n's own
backing database (SQLite by default, Postgres optionally) is a separate concern
from the data tables feature — switching it is about durability, not about
whether this bot works.

Variables are the one real gap. The Code nodes fall back to `$env`, so
`TOKEN_ENCRYPTION_KEY` and `TELEGRAM_BOT_TOKEN` are passed to the container
instead of being created in the UI. **`$env` access is blocked by default** — as
of n8n 2.0 `N8N_BLOCK_ENV_ACCESS_IN_NODE` defaults to `true`, so it has to be set
to `false` explicitly or every Code node reports a missing key.

A ready compose stack — n8n behind Caddy, with TLS obtained automatically — is
in [`deploy/`](../deploy/), along with a `bootstrap.sh` that installs Docker,
creates swap and opens the host firewall:

```bash
cd deploy
./bootstrap.sh
cp .env.example .env && nano .env
docker compose up -d
```

Free hosts that fit: **Oracle Cloud Always Free** (`VM.Standard.E2.1.Micro`, 1 GB
— note the Always Free allocation is restricted to one availability domain, and
the larger Ampere A1 shape is frequently out of capacity) or **Google Cloud
e2-micro** (1 GB, always free, no capacity lottery). A laptop behind a
`cloudflared` tunnel works for a one-off test, but its hostname changes on every
restart, which invalidates the `redirect_uri`.

A laptop behind a tunnel is fine for a demo but sleeps; an always-free VPS
(Oracle Cloud Always Free, for instance) is the durable version. `WEBHOOK_URL`
must be the public hostname — with anything else, neither Telegram nor Silpo can
reach the instance.

Self-hosted data tables default to a 200 MiB cap per instance, raised with
`N8N_DATA_TABLES_MAX_SIZE_BYTES`. This bot stores sessions, short-lived OAuth
state and 30-minute plans, so the default is not close to binding.

Then, on the new instance:

1. Recreate the three data tables — **new ids**.
2. Put the new `baseUrl` and ids in `.secrets/n8n.json`, `npm run build:workflows`.
3. Import from `.secrets/workflows/`, recreate the Telegram credential, publish both.
4. Call `deleteWebhook` on the old Cloud instance first, or Telegram keeps
   delivering there.

The `redirect_uri` changes with the hostname, so the first `/connect` after the
move is the test that matters.

---

## Local tooling

Works without n8n — useful for debugging and for recording a demo:

```bash
npm install
npm run authorize     # OAuth 2.1 + PKCE, dumps all 39 tool schemas
npm run call -- silpo_get_my_shopping_cart
npm run optimize      # full analysis of the real cart, read-only
npm run check         # typecheck + regenerate + validate + check every screen
npm run preview       # render every screen as Telegram paints it
npm run test:node     # run a generated Code node against live MCP
```

`npm run preview` reads the generated workflow, pulls the UI module out of it and
renders all 27 screens in the terminal with bold, italic and struck-through text
and their buttons — the fastest way to judge a copy change without a phone. Add
`-- --check` for the assertions alone; `npm run check` already includes them.

`npm run optimize` picks up `ANTHROPIC_API_KEY` from a local `.env` (see
`.env.example`) to enable the semantic layer. Everything the deployed bot needs
lives in n8n Variables and Credentials instead — a `.env` file plays no part in
the deployment.
