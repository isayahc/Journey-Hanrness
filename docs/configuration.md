# Configuration

## MongoDB and OpenCode

Set `MONGODB_URI` to the event Atlas Sandbox connection string and use
`MONGODB_DB=journey_harness`. The local example URI is for optional development
with `docker compose up -d --wait`.

`OPENCODE_URL` defaults to `http://127.0.0.1:4096`. To change the managed service
port, change the URL. `npm start` uses this same address for startup and requests.
Remote HTTP(S) services are supported but must be started separately.

Set `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` when server
authentication is required. The startup health check and model clients use the
same credentials. Never commit `.env`.

Use `OPENCODE_MODEL=opencode/space-bunny-free` or explicitly override it with a
provider/model you can access. `npm run opencode -- models` lists availability.
`npm run opencode -- auth login` configures provider authentication if needed.

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

Set `GITHUB_APP_WEBHOOK_SECRET` and use `${APP_ORIGIN}/webhooks/github` as the
JSON webhook endpoint. Subscribe to installation and installation-repository
events so removal, suspension, and deletion revoke access.

Repository execution requires `JOURNEY_AGENT_EXECUTION_ENABLED=1` and explicit
per-repository agent enablement in the UI. `JOURNEY_AGENT_WORKSPACE_ROOT` optionally
sets the temporary workspace location. Checks execute repository-owned npm
scripts on the worker, so enable this only where that execution is intended.
