# Self-hosted deployment

n8n Community Edition behind Caddy, sized for a 1 GB always-free VPS. Everything
the bot needs is in Community Edition except Variables, which the Code nodes
work around by reading `$env` — see [../docs/setup.md](../docs/setup.md).

```
deploy/
  docker-compose.yml   n8n + Caddy
  Caddyfile            TLS, obtained and renewed automatically
  .env.example         copy to .env and fill in
  bootstrap.sh         Docker, swap and host firewall on a fresh Ubuntu box
```

## Order of operations

The one thing that cannot be reordered: **DNS must resolve before the first
`docker compose up`.** Caddy asks Let's Encrypt for a certificate on startup,
the challenge is served over the domain, and failed attempts count against a
rate limit of five per hour per hostname.

Only this directory is needed on the server — workflows are imported through the
browser, so there is no reason to clone the whole repository there:

```bash
scp -r deploy root@<server-ip>:/root/       # from your machine
```

```bash
# 1. On the server
./bootstrap.sh                    # Docker, 2 GB swap, ports 80/443
cp .env.example .env && nano .env

openssl rand -hex 32              # TOKEN_ENCRYPTION_KEY
openssl rand -hex 32              # N8N_ENCRYPTION_KEY — a different value

# 2. Point the domain here, and confirm it before continuing
dig +short your-domain.duckdns.org        # must print this server's public IP

# 3. Start
docker compose up -d
docker compose logs -f caddy      # "certificate obtained successfully"
```

Then open `https://your-domain/`, create the owner account, and continue from
[step 3 of setup.md](../docs/setup.md) — the three data tables, their ids into
`.secrets/n8n.json`, `npm run build:workflows`, import.

## Two keys, two jobs

Easy to conflate, and conflating them fails silently much later:

| Variable | Encrypts | If lost |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | Silpo tokens in our data tables | every guest runs `/connect` again |
| `N8N_ENCRYPTION_KEY` | the Telegram credential inside n8n | recreate the credential in the UI |

Both are 64 hex characters and must be **different values**. Back up `.env`
somewhere outside the server.

## Staying inside Google Cloud's free tier

Four conditions, all set at creation time: region `us-west1` / `us-central1` /
`us-east1`, machine type `e2-micro`, **standard** persistent disk of 30 GB or
less, and a static external IP that stays attached to a *running* instance —
Google bills reserved addresses that sit unused.

The fifth is a running total rather than a setting: **1 GB of outbound transfer
per month**. The bot barely touches it — one `/optimize` is roughly 50–100 KB
outbound, so the allowance covers on the order of ten thousand runs, and Silpo's
responses are inbound and therefore free. The n8n **editor** is what actually
consumes it: its UI bundles are several MB per full page load, which puts a few
hundred page loads in the same GB. Configure in a few sittings rather than
leaving the editor open, and it never becomes an issue.

Overage is about $0.12/GB, so the failure mode is cents rather than a surprise
invoice — but set a $1 budget alert (Billing → Budgets) and stop thinking about
it.

## Sizing

One `/optimize` is 22 MCP calls over about two seconds against a 14-item cart,
so the workload itself is small — the constraint is n8n's own idle footprint.

**On a 1 GB box** (Oracle `E2.1.Micro`, GCP `e2-micro`) the swap file
`bootstrap.sh` creates is load-bearing, not a tweak: without it n8n is
OOM-killed partway through an execution, which presents as the bot answering
some requests and ignoring others. Keep `N8N_MAX_OLD_SPACE` at its 768 default.

**On a 4 GB VPS** (Hetzner `CAX11` / `CX22`) set `N8N_MAX_OLD_SPACE=3072` in
`.env` — at the default the process is capped near 768 MB and most of the
machine goes unused. Swap becomes a safety net rather than a requirement;
`bootstrap.sh` still creates it, which is harmless.

The n8n image is multi-architecture, so Hetzner's ARM shapes (`CAX*`, usually
the cheapest line) need no change.

## Checking it works

```bash
docker compose ps                 # both services Up
curl -sI https://your-domain/ | head -1          # 200
curl -so /dev/null -w '%{http_code}\n' \
  'https://your-domain/webhook/silpo/callback?state=probe'   # anything but 404
```

A 404 on the last one means the OAuth workflow is not published yet.

## Troubleshooting

**Caddy never gets a certificate.** Almost always ingress, and almost always the
*cloud* side rather than the host. Check from another machine with
`curl -I http://your-domain/`.

- **Oracle**: the subnet's Security List (or an NSG) must allow ingress on 80
  and 443. Oracle images *also* block those ports in the host firewall, so both
  layers have to be open — `bootstrap.sh` fixes only the second.
- **Google Cloud**: tick *Allow HTTP traffic* and *Allow HTTPS traffic* when
  creating the VM, or add the `http-server` / `https-server` network tags
  afterwards. Debian and Ubuntu images on GCP do not filter locally, so there is
  only the one layer.

**Code nodes report a missing key.** `N8N_BLOCK_ENV_ACCESS_IN_NODE` is not
`false`. n8n 2.0 blocks `$env` by default, and Community Edition has no
Variables to fall back to, so both sources come up empty.

**`Module 'crypto' is disallowed`.** The Code node sandbox permits no built-in
module unless `NODE_FUNCTION_ALLOW_BUILTIN` names it. n8n Cloud allowed `crypto`
out of the box, so this surfaces only after moving to self-hosted — and it stops
`/connect` at the first node, since both token encryption and the PKCE verifier
need it.

**Why `$env` still works even though the runner cannot see the variables.**
Code nodes execute in a task runner process, and that process is started with a
*hardcoded* allowlist of environment variables — `PATH`, `NODE_FUNCTION_ALLOW_*`
and a handful of others. `TOKEN_ENCRYPTION_KEY` is deliberately not among them,
and no setting adds it. Inspecting the runner's own environment therefore looks
alarming and means nothing: `$env` is not read there. The main process snapshots
its own `process.env` (`createEnvProviderState`) and ships it to the runner with
each task, so the values arrive from the container's environment as configured.
`NODE_FUNCTION_ALLOW_BUILTIN` is the opposite case — it *is* forwarded, because
the runner itself has to act on it.

**Telegram delivers nowhere.** `WEBHOOK_URL` must be the public hostname, and
the workflow must be published. Confirm with
`curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` — an empty `url`
means Telegram has no destination. If it still points at the old n8n Cloud
instance, unpublish there and publish here again.

**Out of memory.** `docker compose logs n8n | grep -i "heap\|killed"`. Confirm
swap is active with `free -h`.

## Pinning the version

The compose file tracks `:latest` so a first install gets data tables (v1.113+)
and current defaults. After the bot works, pin it — an unattended major upgrade
is how a working deployment breaks unnoticed:

```bash
docker compose exec n8n n8n --version     # then set image: docker.n8n.io/n8nio/n8n:<version>
```
