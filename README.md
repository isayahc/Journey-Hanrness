# Journey Harness

An OpenCode agent workspace with persistent conversations and controlled
GitHub repository jobs. The next milestones add durable goal execution,
checkpoint recovery, memory, and measured adaptation.

## Start

Install Node.js 22.9+ and run:

```sh
npm install
```

This installs the project-local OpenCode CLI, refreshes its model catalog, and
creates `.env` if it does not exist. Existing configuration is preserved. No global OpenCode installation,
Bash, or curl is required.

Set `MONGODB_URI` in `.env` to your MongoDB Atlas connection string. For the
hackathon, use the provided Atlas Sandbox. Then run:

```sh
npm start
```

Open **http://localhost:3000**. Startup launches OpenCode, waits for its health
check, and starts the app. If the configured OpenCode server is already healthy,
startup reuses it. Ctrl+C stops only the processes launched by this command.

The model default for chat and repository jobs is:

```dotenv
OPENCODE_MODEL=opencode/space-bunny-free
```

Change `OPENCODE_MODEL` in `.env` to use another provider/model. There is no
silent model fallback. Provider authentication, when required, can be configured
with `npm run opencode -- auth login`.

If catalog refresh could not finish during installation, run
`npm run opencode -- models opencode --refresh` before using a newly released model.

## Agent behavior

- Conversations and their OpenCode session IDs are saved in MongoDB.
- Chat can search the web and retrieve pages. Chat cannot read or modify local
  files, run shell commands, or create repository changes.
- Repository jobs require GitHub sign-in, a connected GitHub App installation,
  explicit access for the selected repository, and execution enabled on the worker.
- An enabled repository agent works in an isolated job directory. The executor
  checks changes, pushes a dedicated branch, and opens a reviewable PR. It does
  not push to the default branch or merge automatically.
- Tool results and errors are handled by the server; credentials stay server-side.

See [configuration](docs/configuration.md) for GitHub setup and
[architecture](docs/architecture.md) for the execution flow.

## Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies, OpenCode, and initial local configuration |
| `npm run setup` | Create missing `.env` without overwriting an existing file |
| `npm start` | Start OpenCode and the application together |
| `npm run server` | Start only the application against an existing OpenCode server |
| `npm run chat:demo` | Try the UI with clearly labeled non-AI replies and temporary history |
| `npm run opencode -- --version` | Verify the installed CLI |
| `npm run opencode -- models` | Inspect models available through OpenCode |
| `npm run opencode:serve` | Start OpenCode separately on local port 4096 |
| `npm run check` | Typecheck |
| `npm test` | Run tests |
| `npm run build` | Compile TypeScript |

`npm ci` is supported for repeatable installation. If lifecycle scripts were
disabled, reinstall with scripts enabled so the OpenCode binary is installed,
then run `npm run setup`.

For optional local database development, use `docker compose up -d --wait`.
Database integration tests use `MONGODB_TEST_URI` and disposable test databases.
Docker is not needed when using Atlas.

## Delivery plan

Follow [Epic #1](https://github.com/isayahc/Journey-Hanrness/issues/1) in separate
PRs. This setup includes the chat and controlled repository agent runtime.
Long-running goal execution, restart checkpoints, evaluation loops, and learned
strategies are subsequent increments.
