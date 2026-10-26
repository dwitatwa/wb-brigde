# WorkBuddy Bridge

Serve WorkBuddy desktop models through local OpenAI-compatible endpoints. You
can also add your own custom OpenAI-compatible Chat Completions providers — a
commercial API or a local gateway — directly from the web UI. Custom providers
do not require WorkBuddy and do not change the DSH plugin.

## Standalone setup

Use Node.js 22.19 or later in the 22 series, or Node.js 24 or later.
From a source checkout with dependencies installed, build and start the bridge:

```sh
npm run build
node lib/run.js ui
```

For a distributed installation, run `workbuddy-bridge ui` or
`workbuddy-bridge serve`. Point your client at the local base URL and use the
local token shown by the bridge. Each endpoint keeps its port and token across
restarts, so a client configured once keeps working; pass
`--no-stable-endpoints` for a fresh pair on every start.
`workbuddy-bridge models`, `status`, and `env` read the running descriptor.

## Add a WorkBuddy account

Sign in to the account in the WorkBuddy desktop app, then press **Rescan
accounts** in the web UI. The account joins the pool at once. The pool's base
URL and token do not change, so your client configuration stays correct.

The **Accounts** button opens a folder the bridge owns, one sign-in copy per
account. Add a file there to keep an account, or remove one to take it out of
the pool. Removing deletes only the bridge's copy; the WorkBuddy app's own
files are never touched.

A file sealed by a different WorkBuddy install cannot be read on this computer,
because the encryption key is local to the install. Import checks this and
refuses such a file with the reason.

## Add a provider in the existing UI

Start the bridge with the web UI and open the page (`workbuddy-bridge ui`, or
`node lib/run.js ui`). Use the add-provider form and fill in:

- **Display name** — any label; an `id` slug is generated from it.
- **Base URL** — the full API prefix; the bridge appends `/chat/completions`
  itself (no automatic `/v1`). Example: `https://api.example.com/v1`.
- **Model IDs** — typed by hand; there is no automatic model discovery.
- **Auth mode** — `api-key` (enter the provider's upstream key once) or `none`
  (for upstreams that need no key).

Saving joins the provider to the pool endpoint immediately — no restart.
**Edit** swaps the configuration in place (the pool's URL and token stay the
same); **remove** drops the provider from the pool. The page reloads the list
after each change, and saved providers come back automatically on the next
`ui` start — no flags, no config files, no environment variables for the UI.

The **Local bridge API key** shown on the pool card is the **local bridge
token** for clients, not your upstream key. The upstream key is stored
privately in a credential file under your bridge home. The file is **not
encrypted** — it is protected by your user account's file permissions only.
Configured does **not** mean tested: the bridge never probes connectivity, so
check your URL, key, and model IDs against your provider's documentation.

## Custom providers via config file (compatibility)

For scripted or headless setups, configure providers with a JSON file instead
of the UI. Do not put an API key in the file.

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

Set the upstream key in the shell that starts the bridge:

```sh
export MY_API_KEY='replace-with-your-provider-key'
workbuddy-bridge ui --config ./providers.json --provider my-api
# Or use serve without the web UI:
workbuddy-bridge serve --config ./providers.json --provider my-api
```

PowerShell:

```powershell
$env:MY_API_KEY = 'replace-with-your-provider-key'
workbuddy-bridge ui --config .\providers.json --provider my-api
```

`--config` is explicit; no config files are found automatically. Without
`--provider`, the bridge serves both WorkBuddy products followed by the configured
providers. An explicit selection serves only those IDs. Use commas or repeat the
flag. `cn`, `ai`, and `both` remain built-in aliases; `both` excludes custom IDs.

The upstream URL rule is exact: remove trailing slashes from `baseUrl`, then
append `/chat/completions`. The bridge does not add `/v1`. File-configured
providers read their key from the environment per request and need a restart
after config or shell environment changes (UI-managed providers need none).
Use the new **local bridge token** in your client, not the upstream key. Missing
keys leave a local endpoint with no models and a clear error. `configured` does
not mean upstream connectivity was tested.

Custom providers support JSON and SSE Chat Completions. They have no Responses
API or automatic model discovery, and no WorkBuddy billing or DSH integration.
A saved (UI-managed) provider whose id collides with an externally configured
one is an explicit error — neither silently overwrites the other.

Custom providers are served through `custom-pool`, one endpoint over all of
them with failover, the same way the WorkBuddy account pool fronts several
accounts — and, like the account pool, it is the only endpoint they are served
on (one provider is enough; there are no per-provider endpoints). A request
goes to a provider that offers its model; a provider that is rate limited, out
of credit, or returning `5xx` is skipped for the next one, while a `400` stops
the chain because every provider would refuse it. Point an agent at the pool
URL.

See the [standalone guide](docs/standalone-bridge.md) for the UI management
form, selection, configuration, WSL forwarding, descriptor controls, request
logs, and security details. If your distribution does not include `docs/`, read
that guide in the source repository.
