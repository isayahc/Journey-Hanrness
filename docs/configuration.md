# Configuration

## MongoDB and OpenCode

Set `MONGODB_URI` to the event Atlas Sandbox connection string and use
`MONGODB_DB=journey_harness`. The local example URI is for optional development
with `docker compose up -d --wait`.

`npm run db:init` initializes the database indexes, including `goal_runs`.
Application startup also initializes goal indexes automatically. The database
user needs read/write access (including collection/index creation) to the configured
database. No additional environment variables are needed for goal planning.

Each run saves its selected model and execution limits. The goal form accepts
1–20 steps, 1–5 execution attempts per step, and a 1–240 minute execution budget.
These execution limits are stored for the future executor. Planning itself is
limited to three attempts per run, with a 90-second model request timeout.

`OPENCODE_URL` defaults to `http://127.0.0.1:4096`. To change the managed service
port, change the URL. `npm start` uses this same address for startup and requests.
Remote HTTP(S) services are supported but must be started separately.

Set `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` when server
authentication is required. The startup health check and model clients use the
same credentials. Never commit `.env`.

Use `OPENCODE_MODEL=opencode/space-bunny-free` or explicitly override it with a
provider/model you can access. `npm run opencode -- models` lists availability.
`npm run opencode -- auth login` configures provider authentication if needed.

## Tavily search

Set `TAVILY_API_KEY` in `.env`; no key is bundled. `npm start` passes this key and
MongoDB configuration to both the app and its managed OpenCode process. Restart
both services after adding, changing, or removing the key. If `npm start` reuses
an already-running OpenCode server, restart that server yourself so it receives
the updated environment and tool files.

The tool lives at `.opencode/tools/tavily_search.ts`. OpenCode must run from this
project with `npm install` completed. A separately managed or remote OpenCode
server needs this tool and its `src/search/` dependencies, the same `MONGODB_URI`
and `MONGODB_DB`, and `TAVILY_API_KEY` in its own environment. A key only in the app's
environment does not configure a remote server. Use `npm run search:smoke` to verify
the full integration after setup. It uses live inference/search and may consume
provider quota. The normal test suite uses fixtures and requires no Tavily key.

Search is currently enabled for chat and goal planning. Repository jobs retain
their existing tool permissions. Search is disabled when the key is missing;
page fetching in chat remains separate. The default model stays
`opencode/space-bunny-free`.

Limits are enforced by the server/tool: 400 characters per query, 1–5 results,
1,000 characters per excerpt, a 512 KB upstream response cap, a 10-second request
timeout, and 10 provider attempts per conversation/run. A planning retry or app
restart does not reset the budget. No automatic provider retry is performed.

Evidence is retained with the conversation/run until its records are explicitly
removed; there is no automatic evidence expiration in this increment. Inspect it
through the owner-scoped `GET /api/chats/:id/evidence` and
`GET /api/runs/:id/evidence` endpoints. Missing/expired search authorization and
exhausted budgets stop the tool before a provider call. Key/quota/timeout failures
are recorded with sanitized messages and do not erase the conversation or goal.

OpenRouter is opt-in. Set `OPENROUTER_API_KEY` in `.env`, then choose an
OpenRouter model explicitly, for example `OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4`.
Leaving `OPENCODE_MODEL` unset continues to use `opencode/space-bunny-free`.

## GitHub sign-in

Set `APP_ORIGIN`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET`.
Register `${APP_ORIGIN}/auth/github/callback` as the OAuth callback URL.
Leaving these credentials blank keeps localhost anonymous development mode.

User access tokens are discarded after identity verification. Browser sessions
use opaque HTTP-only cookies; MongoDB stores hashed session tokens.

## Repository access

Set `GITHUB_APP_SLUG` to enable the connection flow. Configure the GitHub App with:

- Setup URL: `${APP_ORIGIN}/github/setup`
- Callback URLs: `${APP_ORIGIN}/auth/github/callback` and `${APP_ORIGIN}/github/setup/callback`
- Request user authorization during installation: off
- Repository permissions: Metadata read, Contents read/write, Pull requests read/write
- Repository selection: only the repositories the user wants to connect

Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` to synchronize repositories and
mint scoped installation credentials. The server verifies that an installation
belongs to the signed-in GitHub user before accepting the connection.

If GitHub already has the app installed but the repository list is empty, use
**Reconnect GitHub** on the Repositories page. This authorizes the same GitHub
account again, discovers the app's existing installations, and saves their links
in the current MongoDB database. **Sync from GitHub** starts this recovery
automatically when no installation is linked. New users without an installation
continue to GitHub's installation screen. **Change GitHub access** still opens
GitHub's repository selection settings.

All GitHub credentials and the slug must belong to the same GitHub App. Keep both
callback URLs above registered with the exact `APP_ORIGIN` you open in the browser.
Recovery uses the existing setup callback; no new callback URL is required. User
access tokens are discarded after verification, and recovered repositories still
require explicit agent enablement.

If GitHub shows **The `redirect_uri` is not associated with this application**,
open the GitHub App registration under Developer settings → GitHub Apps → Edit.
Under **Callback URL**, keep `${APP_ORIGIN}/auth/github/callback` and add
`${APP_ORIGIN}/github/setup/callback` as a second entry, then save. The separate
**Setup URL** is `${APP_ORIGIN}/github/setup`; adding a setup URL does not register
an authorization callback. Match the scheme, hostname, port, and path exactly
(including `localhost` versus `127.0.0.1`). Start **Reconnect GitHub** again from
the app after saving. Updating the GitHub registration does not require a new key
or an app restart. Changing `APP_ORIGIN` does require restarting the app.

Set `GITHUB_APP_WEBHOOK_SECRET` and use `${APP_ORIGIN}/webhooks/github` as the
JSON webhook endpoint. Subscribe to installation and installation-repository
events so removal, suspension, and deletion revoke access.

Repository execution requires `JOURNEY_AGENT_EXECUTION_ENABLED=1` and explicit
per-repository agent enablement in the UI. `JOURNEY_AGENT_WORKSPACE_ROOT` optionally
sets the temporary workspace location. Checks execute repository-owned npm
scripts on the worker, so enable this only where that execution is intended.
