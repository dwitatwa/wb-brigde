# The standalone bridge

`workbuddy-bridge` exposes the models in a signed-in **WorkBuddy** desktop app
over a local, OpenAI-compatible HTTP endpoint, so *any* agent that accepts a
base URL can use them — Claude Code, Codex CLI, Cursor, Continue, the OpenAI
SDK, or your own code.

It is the same bridge DeepSeek Harness uses. Nothing about the wire behaviour
was forked: both frontends run one shared core.

---

## Layout

```
src/
  core/         the bridge — no agent, no harness, no third-party deps
  dsh/          the DeepSeek Harness plugin frontend
  standalone/   the CLI + embeddable runner frontend
```

`src/core/` imports **only** Node builtins. That is the whole point of the
split: the bridge was never DSH-specific, and now it does not claim to be.
Verify it yourself:

```sh
grep -rhoE "from '[^']+'" src/core src/standalone | grep -v "from '\./"
# → only node:... specifiers
```

### What is 1:1 with the original

Every module below was moved verbatim. The only edits were import paths.

| Module | Role |
|---|---|
| `core/shim.ts` | the loopback OpenAI-compatible endpoint |
| `core/loopback.ts` | Host / Origin loopback gates |
| `core/upstream.ts` | the WorkBuddy wire client, quirks and all |
| `core/auth.ts` | read-only reuse of the desktop sign-in |
| `core/catalog.ts`, `core/catalog-store.ts` | the model list and its cache |
| `core/variants.ts` | the CN and international product descriptors |
| `core/desktop-credential-protection.ts` | WorkBuddy 5.6 at-rest key handling |
| `core/probe*.ts`, `core/visibility-store.ts` | reasoning detection, hidden models |
| `core/client-identity.ts`, `core/app-version.ts` | the CLI/desktop identity headers |

The shim's **defaults** are unchanged, including the parts that make it awkward
to configure:

- it binds an **ephemeral port** (`listen(0, '127.0.0.1')`), and
- its bearer token is a **per-process in-memory secret** (`randomBytes(32)`).

Both are now optional **preferences**. The standalone runner passes the port and
token an endpoint used on its previous start, so a client configured once keeps
working across restarts. Given neither option the shim still binds an ephemeral
port and mints a random secret, so every existing caller is unaffected. The
standalone frontend also *publishes* the values — see below.

### What changed

Only two helper modules were rewritten, because they were the core's only two
DSH dependencies:

| Original | Replacement | Behaviour |
|---|---|---|
| `@deepseek-ai/dsh-atomic-write` | `core/atomic-write.ts` | `writeFileAtomic` (temp file + fsync + rename), `withFileLock` (exclusive `wx` marker with stale-lock recovery) |
| `@deepseek-ai/dsh-home-paths` | `core/bridge-home.ts` | `resolveBridgeHome()` |

`resolveBridgeHome()` resolves in this order:

1. `$WORKBUDDY_BRIDGE_HOME`
2. `$DSH_HOME` — so a machine already running the Harness plugin can share one
   home, and therefore one refreshed credential copy, catalog cache, and probe
   set, rather than each frontend refreshing independently
3. `~/.workbuddy-bridge`

### One deliberate wire change: the channel identity

Upstream 0.7.6 sends three `X-Conversation-*` headers on chat. That is
necessary but **not sufficient** — the international gateway also runs a
*sampled* channel check, so a fraction of requests is refused with
`400 / code 11128 / "conversation id missing"` regardless. This port completes
the identity to the shape a 5.8.4 client capture shows, and retries a refused
request. It is the only place the bridge deliberately diverges from 0.7.6, and
it is documented in full under [The upstream channel
check](#the-upstream-channel-check-400--11128).

Everything else in `core/upstream.ts` — the forced streaming, the string
`tool_choice`, the `developer` → `system` rewrite, the header set the CLI sends
— is unchanged from upstream.

---

## Running it

```sh
pnpm install
pnpm build
node lib/run.js serve
```

On startup it prints each endpoint and a copy-paste block:

```
workbuddy-bridge 0.7.6 — 2 endpoint(s)
  WorkBuddy      http://127.0.0.1:39271/v1  16 models  token: 4Kt… 
  WorkBuddy AI   http://127.0.0.1:39272/v1  signed out

Point any OpenAI-compatible client at:
  base URL : http://127.0.0.1:39271/v1
  api key  : 4Kt…
```

It also writes a descriptor to
`~/.workbuddy-bridge/.workbuddy-bridge-endpoint.json` (mode `0600`), which
`workbuddy-bridge status` and `workbuddy-bridge env` read back:

```sh
workbuddy-bridge env
# export OPENAI_BASE_URL=http://127.0.0.1:39271/v1
# export OPENAI_API_KEY=4Kt…
```

### Adding your own provider (custom OpenAI-compatible providers)

You can add any OpenAI-compatible provider — a commercial API, a local
gateway, anything that speaks Chat Completions — directly from the web UI.
Custom providers do not need WorkBuddy or a desktop sign-in, and they do not
change the DSH plugin.

**Add a provider in the existing UI.** Start the bridge with the web UI
(`workbuddy-bridge ui`, or `pnpm start`) and open the page. Use the add-provider
form on the page and fill in:

- **Display name** — any label you like; a slug `id` is generated from it.
- **Base URL** — the **full API prefix**: the bridge removes trailing slashes
  and appends **`/chat/completions`** itself, with no automatic `/v1`. Thus
  `https://api.example.com/v1` sends chat to
  `https://api.example.com/v1/chat/completions`, while
  `https://gateway.example.com/team/api` sends chat to
  `https://gateway.example.com/team/api/chat/completions`. Use HTTPS except for
  a local loopback server, where HTTP is allowed. No credentials, query strings,
  or fragments.
- **Model IDs** — typed by hand. There is no automatic model discovery, so copy
  the exact model IDs your provider documents. Wrong or misspelled IDs are
  accepted but every chat turn naming them is refused.
- **Auth mode** — `api-key` (enter the provider's upstream API key once) or
  `none` (for upstreams that need no key, such as a local gateway).

**Save, edit, remove.** Saving takes effect immediately — the provider joins the
failover pool and starts serving on the pool's loopback endpoint, without
restarting the bridge. Editing swaps the provider's configuration in place (only
the model list or key changes; the pool's URL and token stay the same); removing
drops the provider from the pool. The page reloads its list after each change,
and your saved providers come back automatically on the next `ui` start — no
flags, no config files, no environment variables needed. If a saved provider
collides with an id already configured via `--config`, the bridge refuses with
an explicit error rather than silently overwriting either one.

**Every provider is served through one failover pool.** The same arrangement the
WorkBuddy account pool uses, applied to providers: one endpoint, `custom-pool`,
fronts every custom provider — one provider is enough, and there are no
per-provider endpoints beside it.

- Point an agent at **one** URL. The bridge prints the pool as the suggested
  base URL.
- Each request goes to the provider that offers its model. When several do, the
  current **head** provider answers.
- A provider that refuses in a way another provider could survive is skipped
  and the next one is tried: `401`/`403` (key refused), `402` (payment
  required), `404` (no such route at that gateway), `429` (rate limited), and
  any `5xx`. A `400` is a property of the request, so it stops the chain
  instead of retrying everywhere. With a single provider the pool still serves,
  it just has nowhere else to fail over to.
- A success keeps that provider as the head; a failover moves the head to the
  provider that answered. A healthy provider is not rotated for its own sake.
- The pool exists from the first provider on and closes only when the last one
  is removed. Its URL and local token stay the same across edits, because the
  listener is not rebuilt per change.
- The pool's **Providers** tab shows one row per provider: whether it is ready,
  whether it answers next, its last routed turn, its own failures, and
  **Test**. A test sends a real turn at that provider's own upstream and does
  not move the head. **Edit** and **Remove** work from that row too. A provider
  that came from `--config` is read-only there.
- The pool's **Tried** column in the log names the provider every turn was
  served by — including a single-attempt success.

The pool is not a second configuration: it reads the same saved providers, and
it is the only endpoint they are served on.

**How the key and token work.** Your provider's upstream API key is stored
privately in a credential file under your bridge home
(`~/.workbuddy-bridge/managed-providers/`). The file is **not encrypted** — it
is protected only by your user account's file permissions, the same trust level
as the desktop app's own files. The key never appears in the descriptor, the
UI, or error messages: the **Local bridge API key shown on the pool card is the
local bridge token** for clients to connect with, not any upstream key. The
pool endpoint has its own local token; each provider's own key is used only for
the upstream call routed to it, and one provider's key is never sent to another.

**The local server has no authentication by design** (any local process or
browser page can reach the UI port within the loopback/Origin gates), and
management actions are additionally gated by a per-process nonce. Configured
does **not** mean tested: the bridge never probes your provider's connectivity,
so a wrong URL or key is only discovered when an agent actually calls.

Custom providers appear on one pool card. Its **Providers**, **Models**, and
**Logs** tabs show the membership table described above, the union of the
configured model IDs, and request metadata. The pool card comes first, and each
log row carries the provider that served it in the **Tried** column. Pool
request logs map HTTP errors to the pool's coarse outcome classes; they do not
use WorkBuddy error classifiers. They store no prompts or responses.

Supported: JSON and SSE OpenAI-compatible **Chat Completions**. Request bodies
and successful streams pass through without WorkBuddy transforms or reasoning
coalescing. The model list comes only from your configuration. There is no
Responses API, automatic model discovery, WorkBuddy billing, or DSH integration.
Custom-provider failover is the provider pool described above; it is separate
from the WorkBuddy account pool. `--wsl`, `--redact-token`, and
`--no-descriptor` also apply to the pool endpoint.

### Configuring providers with a file (compatibility)

The classic way to configure custom providers is a JSON file passed with
`--config`. This remains fully supported and is useful for scripted or
headless setups where the web UI is not used.

Create `providers.json`:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "my-api",
      "displayName": "My API",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_API_KEY",
      "models": ["my-model"]
    }
  ]
}
```

`version: 1` is mandatory. Provider IDs must be unique lowercase slugs; built-in
IDs and the aliases `cn`, `ai`, and `both` are reserved. Model IDs can be the same
across different providers. Unknown fields are rejected. `displayName` and
`apiKeyEnv` are optional; omit `apiKeyEnv` only if the upstream needs no key.
The upstream key is read from the **environment** (per request), so set it in
the shell that starts the bridge — these values are placeholders, not real keys:

```sh
export MY_API_KEY='replace-with-your-provider-key'
workbuddy-bridge serve --config ./providers.json
workbuddy-bridge ui --config ./providers.json
```

PowerShell:

```powershell
$env:MY_API_KEY = 'replace-with-your-provider-key'
workbuddy-bridge ui --config .\providers.json
```

The bridge reads a config file **only** when you pass `--config <path>`. It does
not search for config files. It validates the complete file before it starts
listeners. Without `--provider`, configured providers follow the existing
WorkBuddy endpoints. To run only the custom provider, use:

```sh
workbuddy-bridge serve --config ./providers.json --provider my-api
workbuddy-bridge ui --config ./providers.json --provider my-api
# Mix providers; comma-separated and repeated selections are supported:
workbuddy-bridge serve --config ./providers.json --provider ai,my-api --provider cn
```

An explicit selection serves only the requested providers. Duplicate selections
are removed. `cn` and `ai` select their WorkBuddy products. `both` selects only
the two built-in products, not custom providers. Unknown IDs are errors, including
for `workbuddy-bridge test --provider <id>`. `models`, `status`, and `env` continue
to read the running bridge descriptor; they do not load a config file.

**Exact URL rule:** `baseUrl` is the full upstream API prefix. The bridge removes
trailing slashes and appends **`/chat/completions`**, with no automatic `/v1`.
Thus `https://api.example.com/v1` sends chat to
`https://api.example.com/v1/chat/completions`, while
`https://gateway.example.com/team/api` sends chat to
`https://gateway.example.com/team/api/chat/completions`.
Use HTTPS except for a local loopback server, where HTTP is allowed. URLs must
not contain credentials, query strings, or fragments.

File-configured providers are **read-only as served**: they are never rewritten
by the UI manager. A saved (UI-managed) provider whose id collides with an
externally configured one is an explicit, safe error — neither one silently
overwrites the other. File-config providers differ from managed ones in how
they get their key: an env variable name (`apiKeyEnv`) resolved per request,
versus a key stored in the managed credential file. Restart the bridge after
config or shell environment changes for file-config providers; managed
providers need no restart. Each endpoint keeps its local port and token across
restarts, so an agent configured once keeps working; the descriptor is still
the place to read them if you need to check.

### Seeing the model list

`models` asks the running bridge what it serves:

```sh
workbuddy-bridge models
```

```
WorkBuddy  http://127.0.0.1:64947/v1
  (no models — this product has no usable credential)

WorkBuddy AI  http://127.0.0.1:64948/v1
  27 model(s):
    default-model
    fast-model
    primary-model
    deepseek-v4.1-flash
    gpt-6-astra
    glm-5.3
    kimi-k3
    …
```

`--json` gives the same thing machine-readably. The equivalent by hand is a
plain OpenAI call, which is the point of the bridge:

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/models" | jq '.data[].id'
```

An empty list is **not** an error. It means that product has no usable
credential — the upstream shim renders that as no models rather than a roster
whose every request would fail. When the cause is diagnosable rather than
"nobody is signed in", `models` and `status` print the reason under the
endpoint:

```
WorkBuddy AI   http://127.0.0.1:62761/v1  signed out  token: SFwSkc5rs_…
  reason: the WorkBuddy AI application search did not finish (some registry
  entries or candidates could not be checked); this is not proof that the app
  is missing
```

That specific message means the bridge could not locate the app's Electron
binary, which it needs to unlock the WorkBuddy 5.6 at-rest credential. On
Windows the search reads the uninstall registry, so it will report this if
`reg.exe` is unavailable to the process.

### Commands

| Command | Does |
|---|---|
| `serve` | start the bridge (default) |
| `ui` | start the bridge **plus** the local web UI |
| `start` | `ui` with `--all-accounts` (one command for the usual setup) |
| `start:wsl` | `start` plus `--wsl` |
| `test` | send one real chat turn through the running bridge, over both the loopback and WSL routes |
| `models [--json]` | list the models the running bridge serves |
| `status [--json]` | show the running bridge, including any credential reason |
| `env` | print shell exports for the running bridge |
| `help` | full option list |

### `test` — is a chat turn actually working?

When an agent fails, `test` answers the question the error message does not:

```sh
pnpm probe            # or: node lib/run.js test
```

```
WorkBuddy AI  model: deepseek-v4.1-flash
  loopback  http://127.0.0.1:50412/v1
            OK — HTTP 200, 1482 bytes, terminated, first text: ok
  wsl       http://172.20.96.1:50415/v1
            OK — HTTP 200, 1479 bytes, terminated, first text: ok
```

It uses the same base URL, bearer token and `/chat/completions` path an agent
would, so a pass is evidence the whole chain works — shim gates, credential
resolution, upstream acceptance. It probes **both** routes when the bridge has
`--wsl`, because that is the distinction an agent inside WSL cannot make for
itself: `loopback OK / wsl FAILED` means the hop, both failing means the bridge
or the credential, and both OK means the problem is the agent's own config.

On failure it prints the upstream's raw answer, code included:

```
  loopback  http://127.0.0.1:50412/v1
            FAILED — HTTP 400: {"code":11128,"msg":"conversation id missing",…}
```

Add `--model <id>` to pin a model and `--json` for machine output.

## Web UI

```sh
workbuddy-bridge ui      # or: pnpm ui
```

For the usual setup with a failover pool and every discovered account, use the
convenience command instead of spelling the flags out:

```sh
pnpm start              # ui + --all-accounts
pnpm start:wsl          # same, plus --wsl for WSL agents
```

```
web UI: http://127.0.0.1:53803
```

![The bridge web UI, showing credits and the model table](ui-preview.png)

*Example rendering with sample data, to show the layout.*

Open that in a browser. Each product's card is split into three tabs — so a
card stays roughly one screen tall instead of stacking every table. The **pool**
card is always expanded (it shows the failover state you care about), while
individual **account** cards collapse to a compact header and can be expanded
with a **Show details** toggle:

| Tab | Shows |
|---|---|
| **Account** | sign-in state, credential source and expiry, the credit balance with its per-package breakdown, and — for a pool — every member account |
| **Models** | the model table: rate, promo badges, context window, output cap, image support, reasoning levels |
| **Logs** | the last 20 turns this endpoint served, newest first, with the failover chain on pooled turns |

The tab counts (`Models 27`, `Logs 3`) are live, the choice is remembered per
card across the 5-second refresh, and the tab you are on does not reset when a
turn lands. The expand/collapse choice is also remembered.

The page polls `/api/state` every 5 seconds and has a manual refresh. Besides
the per-account test buttons it can add, edit, and remove custom providers (see
[Adding your own provider](#adding-your-own-provider-custom-openai-compatible-providers));
everything else is read-only. It works with the network down: it is a single
self-contained response with no CDN, fonts, or build step.

### Why the UI is safe

The UI listens on its **own** loopback port — the shim's surface stays exactly
as upstream defines it. That port cannot require a bearer token, because a
browser navigating to a URL cannot attach an `Authorization` header. So it
relies on a Host/Origin pair of gates plus a nonce:

1. the request must name a loopback `Host` (this is what stops DNS rebinding),
2. a browser-sent `Origin` must be loopback **or exactly one of the origins the
   bridge itself published** (the UI's own origin, and the WSL forwarder's URL
   when started with `--wsl`) — no other origin can load the page through the
   WSL hop, and the list is host-controlled: a request's own Host or Origin can
   never add itself to it,
3. the state-changing routes (per-account tests and provider
   add/edit/remove) additionally demand the per-process nonce the page carries,
   repeated in an `X-Bridge-Ui` header; a cross-origin page cannot read it, and
   a custom header forces a preflight this server does not answer.

The bearer token **is** placed in the page so you can copy it, but the surface
itself is still gated: a cross-origin request cannot reach it, and the token is
never sent in error responses. Error text crossing to the browser is redacted
through the same filter the upstream status route uses. Provider keys are never
sent to the page at all — only the boolean `hasApiKey`.

Verify it yourself:

```sh
curl -s -H 'Host: evil.example.com' http://127.0.0.1:53803/api/state
# {"error":"request-not-trusted"}
```

### Testing one account

A pool hides its members by design — one URL, whichever account answers — so
"which account is failing?" is a question the page has to answer rather than
one you can infer. The pool card's **Account** tab therefore carries a row per
account:

- **who answers next** (the head), and whether that account is still signed in,
- **its own credit balance**, read live, with the error text behind a failed read,
- **the last turn the pool *routed* through it** — outcome, time, and the
  upstream's own words when it failed,
- **Test**, and **Test all** to walk the accounts in order.

A test is a real turn: the same base URL, bearer token and
`/chat/completions` path an agent would use for that account, with a one-word
prompt and an 8-token cap. It goes through the account's **own** endpoint, not
the pool, so a pass means *that account* can answer — not that the pool found
somebody who could. It deliberately does not move the head: testing a spare
account must not silently redirect live traffic onto it. It does spend a few
credits, which is why it is a button and not part of the 5-second poll.

The model a test asks for comes from the picker in the card header. Its default
is *each account's own first model*, so an account with a slightly different
roster is still tested against something it actually serves; picking a model an
account does not serve is refused with 400 rather than sent upstream.

Because the page cannot be authenticated, the test route — like every
state-changing route, provider management included — is gated on a nonce the
page carries and repeats in an `X-Bridge-Ui` header. A cross-origin page
cannot read the nonce, and a custom header forces a preflight this server does
not answer; the route also requires `application/json`, which a simple form
POST cannot send. Without both gates, any page open in the same browser could
post to the UI port and spend the pool's credits.

`workbuddy-bridge test` still exists for the same question from a shell, and
`--model <id>` pins the model in both places.

### The request log

Each endpoint's **Logs** tab lists the turns it served. A record is:

| Field | Meaning |
|---|---|
| time | when the shim got a verdict |
| account | which account answered (account endpoints; a pool row shows the chain instead) |
| model | the model the agent asked for, as it appeared on the wire |
| result | `ok`, or the failure class the upstream was classified as, with its status |
| took | time to the **first byte** — the shim hands the body back as a stream, so this is not turn duration |
| chain | pools only: each member tried, in order, and what it said |

**It holds no prompt and no completion.** Not a preview, not a hash — only the
fields above. That is a deliberate constraint rather than a default: the page
is unauthenticated, any local process can read it, and conversation text is a
more sensitive secret than the bearer token the page is already designed never
to see. The one place request material is kept is
`last-channel-failure.json` (see `failure-capture.ts`), which writes a single
*failing* exchange to disk so a channel refusal can be diagnosed — a different
job with a different lifetime.

The log is in memory, a fixed 200 turns per process, and it resets with the
bridge. That matches the routing state it describes: the pool's head and
failure streaks reset at the same moment, so the log never describes a head
that no longer exists. For post-mortems across restarts, use
`last-channel-failure.json` or your agent's own request logging.

Because it is written on the request path it does no I/O and cannot fail a
turn. The status shown is the *upstream's*: 200 when the turn was accepted,
otherwise the status the failure was classified from — which is why a
`hard_credit` row shows 402 while the agent itself received the shim's mapped
code.

### Options

| Flag | Effect |
|---|---|
| `--provider <cn\|ai\|both>` | which product(s) to serve (default `both`) |
| `--auth-file <path>` | explicit WorkBuddy (CN) desktop auth file; **repeatable** — each occurrence adds one account |
| `--auth-file-ai <path>` | explicit WorkBuddy AI desktop auth file; **repeatable** — each occurrence adds one account |
| `--all-accounts` | serve every account found in the desktop auth directory; explicit flags win for the product they name |
| `--no-accounts-ui` | do not keep or expose the bridge-owned account folder (see [The bridge-owned account folder](#the-bridge-owned-account-folder)) |
| `--home <dir>` | override the bridge home |
| `--no-descriptor` | do not write the descriptor file |
| `--redact-token` | write the descriptor without the bearer token |
| `--no-stable-endpoints` | choose a fresh port and token on every start, instead of reusing each endpoint's last pair |
| `--json` | machine-readable output |

### Stable addresses

Each endpoint remembers the loopback port and bearer token it bound, in
`.workbuddy-bridge-identity.json` under the bridge home (`0600`). The next
start asks for the same pair, so an agent configured once keeps working across
restarts — no re-copying, no `401`, no connection refusal.

Both values are **preferences**, never requirements:

- a port another process now holds (or a second bridge) falls back to a free
  one, and the descriptor records what actually bound;
- a missing, unreadable, or damaged identity file just means every endpoint
  starts the way it always did;
- two endpoints never share a port, because each bind happens in turn and a
  taken port falls back.

The web UI's port and each WSL forwarder's port are remembered the same way, so
the page URL and the address an agent inside WSL uses also survive a restart.

`--no-stable-endpoints` restores the historical behaviour of a fresh port and
token each start. `--no-descriptor` keeps its promise of an in-memory-only
secret: ports are still reused, but no token is written to or read from the
identity file.

### Multiple accounts

One process can serve several accounts of the same product — listed
explicitly, or discovered automatically.

**Adding an account while the bridge runs.** The **Rescan accounts** button on
the page repeats the account sources and starts one runtime for each account
that is not served yet. The listener is never rebuilt, so the published base
URL and token stay the same and a client configured once keeps working. Sign in
to the new account in the desktop app, then press **Rescan accounts** — no
restart.

The **Accounts** button opens the bridge's own account folder (see
[The bridge-owned account folder](#the-bridge-owned-account-folder)). There you
can add a sign-in file and remove a stored account.

A rescan never *removes* a member: an account whose file is gone keeps its
runtime and reports as signed out, the same state a sign-out produces. Use
**Accounts → Remove** to take an account out of the pool.

**Discovery (recommended).** The desktop app's atomic writes leave one
snapshot per sign-in behind in its auth directory, so a machine that has used
several accounts already holds a file for each. One flag serves them all:

```sh
workbuddy-bridge serve --wsl --all-accounts
```

The sweep collects the live file and every snapshot, keeps the newest copy
per account, skips files that belong to the other product, and joins one
account per file to the product's pool — no paths to type. Explicit
`--auth-file*` flags win for the product they name, so a hand-picked list is
never silently widened.

**Explicit listing.** Repeat the auth-file flag once per account, in any
order:

```sh
workbuddy-bridge serve --wsl \
  --auth-file-ai "C:/.../snaps/workbuddy-alice.info" \
  --auth-file-ai "C:/.../snaps/workbuddy-bob.info"
```

Each file becomes a pool member — own credential store, own plugin-owned
credential copy — labelled by the account's nickname in the pool card:

```
WorkBuddy AI · pool (failover)  http://127.0.0.1:51001/v1  27 models
  alice  · next · 12 ok / 0 failed
  bob    · next · 3 ok / 2 failed
```

Capture each account's auth file by signing into that account in the desktop
app once and copying `workbuddy-desktop.info` aside. Notes:

- Each account keeps its own plugin-owned credential copy
  (`.workbuddy-auth-N.json`), so their token refreshes never overwrite each
  other. Saved model catalogs are shared per product and keyed by account
  identity, which is how the store already distinguished accounts.
- The web UI shows each account's credits on its own row in the pool table.

### The bridge-owned account folder

The desktop auth directory belongs to the WorkBuddy app: the app writes it,
rewrites it, and leaves a snapshot behind on every sign-in. The bridge may read
it, but it must not delete from it, and it cannot keep an account out of
rotation while `--all-accounts` sweeps everything. A folder the bridge owns
answers both.

It lives at `~/.workbuddy-bridge/accounts/`, one file per account named by the
account's uid, `0600` inside a `0700` directory (with the Windows ACL pass where
mode bits cannot apply). Each file is a **verbatim copy** of a desktop sign-in
document — the bridge never re-seals a token — with a sidecar `.json` holding
only the origin and the save time.

**Precedence.** Three sources, in order:

1. Explicit `--auth-file*` flags — a hand-picked list replaces everything else,
   so a rescan never widens it.
2. The bridge's own account folder.
3. Desktop discovery (`--all-accounts`).

Sources 2 and 3 are merged by account identity, so a stored copy and the
desktop snapshot of the same sign-in are one member, not two.

**Add.** **Accounts → Add file** accepts a `workbuddy-desktop-ai*.info` file
from this computer. The account joins the pool immediately.

**Remove.** **Accounts → Remove** deletes the bridge's own copy and drops the
account from the pool. The desktop app's file and its snapshots are never
touched, so the account can be added back by copying the same file again.

**A file sealed by another install cannot be read here.** Since WorkBuddy 5.6
the tokens are encrypted with a key that lives in the local app's Electron
binary, and the envelope records the key id it was sealed with. Import checks
that id before writing anything, so a file from a different computer is refused
with the reason instead of becoming a member that fails on every turn. A
plaintext file from a pre-5.6 install carries no key id and is accepted.

**Every route is gated like provider management**: loopback `Host`, an exact
`Origin` match, the per-process nonce in `X-Bridge-Ui`, and
`application/json`. These routes write and delete credential files, so they are
never reachable from a merely-loopback page.

### The failover pool

Every product is served through **one pool endpoint per product** that draws
on all of its accounts — there are no per-account endpoints beside it:

```sh
workbuddy-bridge serve --wsl --all-accounts
```

```
WorkBuddy AI · pool (failover)  http://127.0.0.1:51001/v1  27 models  token: ...
```

Point an agent at the pool's base URL and its requests stop depending on any
one account: the pool serves from one account until it fails, then moves to
the next **when the failure is one another account could survive** — out of
credits (402), rate-limited (429), a dead session (401), a gateway-restricted
account (403 naming the account, not the request), or an upstream 5xx.
The head stays with whichever account last succeeded, so a healthy account is
not sampled by every request. A request-level failure (a 400) is *not* retried
elsewhere — every account would refuse that body identically, and the error is
returned as-is so you can see the real cause. With a single account the pool
still serves — it just has nowhere else to fail over to, and the URL stays
valid when you add a second account.

Three things to accept before using it:

- **Two turns of one conversation may be served by different accounts.**
  Upstream requests are stateless per turn, so this is invisible to the model
  — but credit usage is spread across accounts and harder to attribute.
- **Pool members' usage patterns become correlated** (same machine, rotating
  identities), which is a more visible pattern than separate use.

The pool rides on the same shim — same gates, same per-process token — with
its own port and bearer token in the descriptor (`provider:
workbuddy-ai-pool`). Its web UI card shows no credit figure of its own —
credits belong to accounts — but it does show every member: who is head, each
account's balance, what the pool last routed through it, and a **Test** button
that proves one account can answer. See [Testing one
account](#testing-one-account).

### Reasoning arrives as one thinking block

With a reasoning model (`thinking: {type: "enabled"}` in the request), the
upstream streams `reasoning_content` in pieces of **one to eight characters** —
measured: 19 events for a 1,138-character turn. ZCode renders **one thinking
block per reasoning event**, so those pieces show up as a column of tiny
blocks instead of one block of thinking.

There is no SSE field that says "this delta continues the previous block", so
the only way to get one block is to send one event. The bridge therefore
buffers the whole reasoning run and emits it as a single event when the run
ends — on the first content/tool event, on `[DONE]`, or at EOF. No character
limit, no paragraph split, no sentence split: every mid-stream flush would
become another block, which is the problem.

Measured on a real captured stream:

```
before: 19 reasoning events
after :  1 reasoning event (1,138 chars)
text identical: true   [DONE] preserved: true   content deltas unchanged: true
```

**Trade-off, stated plainly:** thinking text appears when the reasoning phase
finishes rather than streaming word by word. That is unavoidable while the
client groups by event. `--no-coalesce-reasoning` restores the raw stream for
anyone who prefers incremental text over a single block.

Only `reasoning_content` is touched. Text deltas, tool-call deltas, usage
events, heartbeats and `[DONE]` pass through untouched and in order, and the
concatenated reasoning is byte-identical to what the upstream sent. A
heartbeat mid-thinking does not split the block. The shim is not involved; the
transform runs in the standalone layer on the `Response` the client wrapper
returns.

---

## Reaching it from WSL

**Symptom:** the bridge works from Windows but an agent inside WSL (OpenCode,
Claude Code, anything) gets a connection refusal against `127.0.0.1`.

**Cause:** WSL2 in its default NAT mode is a separate network namespace with
its own loopback. `127.0.0.1` *inside WSL* is WSL's loopback, not Windows', so
nothing is listening there. This is not a bug in the bridge — it is how WSL
networking works.

### Option A — mirrored networking (no extra listener)

WSL 2.0+ on Windows 11 can share `localhost` between Windows and WSL. Add this
to `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then run `wsl --shutdown` to restart WSL. `127.0.0.1` now works from both
sides, and nothing else is needed. **Prefer this if your Windows build supports
it** — it keeps the loopback-only bind, so there is no extra listener at all.

### Option B — `--wsl`

For NAT mode, this re-exposes each service on the host side of the WSL virtual
switch (`vEthernet (WSL)`), which is WSL's default gateway and therefore always
routable from inside WSL:

```sh
workbuddy-bridge serve --wsl
```

```
workbuddy-bridge 0.7.6 — 2 endpoint(s)
  WorkBuddy      http://127.0.0.1:50411/v1  signed out  token: R_nV…
                 wsl: http://172.20.96.1:50414/v1
  WorkBuddy AI   http://127.0.0.1:50412/v1  27 models  token: EhGW…
                 wsl: http://172.20.96.1:50415/v1

From inside WSL use the wsl: address above, or run `workbuddy-bridge env` from WSL.
```

Each endpoint gets a second address; it is the same endpoint, so the `wsl:`
line sits under its loopback URL. The descriptor carries both:

```json
{
  "provider": "workbuddy-ai",
  "baseUrl": "http://127.0.0.1:50412/v1",
  "wslBaseUrl": "http://172.20.96.1:50415/v1",
  "token": "…"
}
```

Inside WSL, `env` hands you the address that actually resolves:

```sh
# from WSL
eval "$(workbuddy-bridge env)"
# export OPENAI_BASE_URL=http://172.20.96.1:50415/v1
# export OPENAI_API_KEY=…
```

`env`, `status` and `models` detect that they are running inside WSL and will
find the descriptor under the **Windows** user profile (`/mnt/c/Users/…`), since
WSL's `$HOME` is a different directory that has never held one. If the bridge
was started without `--wsl`, `env` says so instead of printing an address that
cannot work:

```
warning: running inside WSL but the bridge was started without --wsl,
so http://127.0.0.1:50412/v1 is unreachable from here; restart it with --wsl
```

`serve` prints a hint when it detects a WSL switch but `--wsl` was not passed,
so you do not have to know the flag exists.

### What `--wsl` does and does not change

- It binds **only** the WSL switch address — a host-only virtual adapter.
  Nothing on your LAN can reach it; `0.0.0.0` is deliberately not used.
- It forwards to the loopback shim, so **`shim.ts` is untouched** and the
  bridge's behaviour is unchanged.
- **The bearer token is still required.** The forwarder passes `Authorization`
  through untouched, so the same token gates both addresses.
- It adds its own Host/Origin gate, accepting loopback or the bound address.

Verify:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://172.20.96.1:51260/v1/models
# 401 — the token is still enforced through the forwarder
```

### If it still fails

Windows Firewall can block inbound traffic on the WSL adapter. Check whether
the port is reachable at all from inside WSL:

```sh
# inside WSL
curl -v "http://$(ip route show default | awk '{print $3}'):51260/healthz"
```

If that hangs, add a firewall rule for the port (needs an elevated shell):

```powershell
New-NetFirewallRule -DisplayName "workbuddy-bridge WSL" -Direction Inbound `
  -InterfaceAlias "vEthernet (WSL (Hyper-V firewall))" -Action Allow -Protocol TCP
```

### One limitation

There is a single descriptor file, so if you run two bridges at once only the
most recent one is discoverable via `status`/`models`. An instance only deletes
the descriptor on exit **if it is still the owner**, so stopping one instance
no longer erases a running one's descriptor.

## Configuring an agent

The bridge speaks plain OpenAI Chat Completions. Anything that accepts a base
URL and an API key works.

**Generic / OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:39271/v1", api_key="<token>")
client.chat.completions.create(model="glm-5.3", messages=[...])
```

**Claude Code** — via the OpenAI-compatible provider settings, or by exporting
the two variables before launch:

```sh
eval "$(workbuddy-bridge env)"
```

**Codex CLI** — declare a custom provider in `~/.codex/config.toml`:

```toml
[model_providers.workbuddy]
name = "WorkBuddy"
base_url = "http://127.0.0.1:39271/v1"
env_key = "WORKBUDDY_BRIDGE_TOKEN"
wire_api = "chat"
```

```sh
export WORKBUDDY_BRIDGE_TOKEN="$(workbuddy-bridge env | sed -n 's/.*API_KEY=//p')"
```

> The port and token are **kept across restarts**, so a value copied once stays
> valid. They are not guaranteed: if another process holds the port, the bridge
> takes a free one and the descriptor records the change. `workbuddy-bridge env`
> re-reads the current values, so a launcher script stays correct either way.

---

## The upstream channel check (400 / 11128)

If a chat turn fails with

```
workbuddy upstream client (http 400): 请求被拦截，请重新发送 [code 11128]
```

that is the international gateway's **channel check** — not a credential, quota,
or model problem. It is worth understanding, because it is intermittent by
design.

### What it is

Since 2026-10-16 `www.workbuddy.ai` validates that a `/v2/chat/completions`
request carries the conversation-channel header family, and refuses one that
does not with `400 / code 11128 / msg: "conversation id missing"`, surfaced as
「请求被拦截，请重新发送」 with a `displayTips` saying the call "failed channel
verification, possibly because it was not sent from an official client".

That header check is **sampled, not deterministic**. Rates measured in the
upstream trackers put it near 0.05% of requests, clustered into bursts of a few
minutes, independent of message content and model. The CN endpoint
(`copilot.tencent.com`) does not run this check.

There is a **second, deterministic cause** of the same code — see
[the client fingerprint](#a-second-deterministic-cause-the-client-fingerprint)
below. It is the one to suspect when a turn fails every single time.

### What this bridge does about it

Two things, both in `core/upstream.ts`:

1. **It completes the identity.** The official client sends a four-header
   family — `X-Conversation-ID`, `X-Conversation-Request-ID`,
   `X-Root-Request-ID`, `X-Conversation-Message-ID` — plus the trace family and
   `X-Agent-Type` / `X-Agent-Purpose` / `X-Agent-Intent`. Upstream 0.7.6 sent
   three of those four. The shapes come from a 5.8.4 client capture, including
   the relations that are easy to get wrong: `X-Conversation-Message-ID` equals
   `X-Request-ID`, and `X-Root-Request-ID` equals `X-Conversation-Request-ID`.
   `X-Machine-ID` / `X-Session-ID` are deliberately *not* sent — the capture
   shows the official client does not send them on chat, and they are
   account-linkable besides.
2. **It retries a refusal.** Because the check is sampled, the same request can
   be refused once and accepted moments later — which is exactly what the
   upstream's own 「请重新发送」 asks for. A `400` carrying the channel signature
   is retried, up to three attempts total, each with a **fresh** conversation
   family, since replaying the blocked ids would only be re-judged by the same
   sample. Every other failure is returned immediately: retrying a genuine bad
   request would only burn a round trip.

### A second, deterministic cause: the client fingerprint

A *persistent* `11128` is usually not the sampled header check at all. The
gateway also matches message **content** against a literal fingerprint of a
rival client's prompt, and refuses with the same code and the same
「请求被拦截」 wording but a different message:

```
msg: Illegal API invocation from an unapproved channel
```

The string it matches is one line of Claude Code's system prompt, generated by
`getGitStatus()` in Claude Code's `context.ts`:

```ts
`Main branch (you will usually use this for PRs): ${mainBranch}`
```

That line is part of the `gitStatus` block Claude Code prepends to every
conversation, joined with blank lines:

```
This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Current branch: main

Main branch (you will usually use this for PRs): main

Status:
 M src/core/upstream.ts

Recent commits:
...
```

Any agent built from, or copying, Claude Code's prompt therefore sends that line
on every turn in a git repository — and every such turn is refused. Measured
against a live endpoint with everything else held constant:

| system content | result |
|---|---|
| `Main branch (you will usually use this for PRs)` | 400 / 11128 |
| the same line, lowercased | 400 / 11128 |
| the full git-status block above | 400 / 11128 |
| `Main branch (you will usually use this for pull requests)` | 200 |
| `Main branch (usually used for PRs)` | 200 |
| `you will usually use this for PRs` | 200 |
| `Main branch: main` | 200 |

So it is a literal, case-insensitive substring match — not a semantic filter.
Reword two words and it passes; keep them and it fails on every attempt, on
every model. That is the shape of a **client fingerprint** used for channel
attestation: the gateway infers which client is calling from its prompt text and
rejects the ones that are not its own.

This is also why the retry above cannot help — the block is deterministic, so
all three attempts are refused identically.

**The bridge does not work around this, on purpose.** `prepareChatBody()` could
rewrite the phrase on the way out and chat would start working, but that is not
a wire compatibility fix — it is defeating a check the vendor put there
deliberately, and a proxy that silently mutates message text is a bad thing to
have sitting in the middle of every request. Use a client whose prompt does not
contain the line, or raise it with the vendor.

**And mind the trap when debugging:** once the phrase is in a conversation's
history, every later turn in that conversation carries it, so the conversation
is permanently blocked — including any reply that quotes the phrase in order to
explain it. Start a fresh conversation to test a fix.

### If it still fails

Run `workbuddy-bridge test` first — it separates the possible causes instead of
leaving you to guess. A persistent `11128` after that means something else:

- **the request never reached the shim.** The `X-Conversation-*` headers are
  added *by the bridge*, not by the agent, so they cannot be the missing piece
  on their own;
- **the agent is pointed at a stale endpoint.** The port and bearer token are
  kept across restarts, so this is no longer the usual cause — but it can still
  happen: another process may have taken the port (the bridge then picks a free
  one), the bridge home may have moved, or the agent may hold a token from
  before a `--no-stable-endpoints` run. Compare with `workbuddy-bridge status`,
  and re-run `eval "$(workbuddy-bridge env)"` before launching the agent.

The `[code …]` suffix exists so a report is diagnosable: `11128` is *also* what
a rejected `role: "developer"` message returns, and several unrelated failures
share the same 「请求被拦截」 wording. Quote the code when reporting.

---

## Security

The shim's own gates are unchanged and all still apply to every request:

1. the `Host` header must name loopback (this is what stops DNS rebinding),
2. a browser-sent `Origin` must be loopback,
3. chat `POST`s must be `application/json`,
4. the `Authorization` bearer must match the endpoint's secret.

**The one deliberate trade-off:** to let an external agent connect at all, the
runner has to tell it the secret, so it writes the token to a `0600` file. That
narrows the defence from *"no local process can forge a request"* to *"no other
user's process can"* — any process running as you can read the file. That is
inherent in publishing an endpoint to a client you did not spawn. Use
`--no-descriptor` to keep the secret in memory only (you then have to copy the
token from the console), or `--redact-token` to keep it out of the file while
still recording the URLs.

Keeping the token across restarts adds nothing to that exposure: the same token
is already written to the descriptor, at the same mode, in the same directory.
The identity file is a second `0600` file with the same trust boundary. If you
want the secret to live only in memory, `--no-descriptor` covers the identity
file too — it stops token reuse while still keeping ports stable.

The real credential never reaches the agent: the shim resolves it from the
desktop store itself, and only ever sends it upstream.

---

## Licensing and provenance

Ported 1:1 from [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)
(MIT). For personal learning and research use only; not affiliated with
Tencent, WorkBuddy, or DeepSeek. It depends on WorkBuddy **client** interfaces
rather than an official open API, so it can break when the app changes.
