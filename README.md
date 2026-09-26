# Journey Harness

An OpenCode agent workspace with persistent goals, execution plans, conversations,
and controlled GitHub repository jobs. Saved repository plans execute with durable checkpoints and worker recovery.
The next milestones add richer memory, criteria evaluation, and measured adaptation.

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

Choose **Goals & plans** to submit a goal, measurable success criteria, and limits.
The goal is saved before OpenCode generates ordered steps with dependencies and
verification requirements. Reloading or restarting the app preserves the goal and
plan in MongoDB. Plans are proposals until you select an enabled repository and choose **Execute plan**.
Supported repository steps run in Daytona, recover from saved checkpoints after restart, and
retain their model and execution limits. See [goal execution](docs/goal-execution.md) for the supported
plan format, stacked PRs, and the boundary between execution success and criteria evaluation.

If planning fails, the goal stays saved with an actionable error. Retry planning
up to three times per run. After an interrupted request, retry becomes available
within two minutes. The model recorded when the run was created is retained on retry.

The model default for chat and repository jobs is:

```dotenv
OPENCODE_MODEL=opencode/space-bunny-free
```

Change `OPENCODE_MODEL` in `.env` to use another provider/model. There is no
silent model fallback. Provider authentication, when required, can be configured
with `npm run opencode -- auth login`.

If catalog refresh could not finish during installation, run
`npm run opencode -- models opencode --refresh` before using a newly released model.

## Web search with Tavily

Add your key to `.env` and restart the app and OpenCode:

```dotenv
TAVILY_API_KEY=your-tavily-key
```

`npm install` installs the OpenCode tool dependency. Chat and goal planning use
`tavily_search` for external research, with source URLs, excerpts, and timestamps
saved in MongoDB. Each conversation or goal has a shared budget of 10 searches,
including failed provider calls and planning retries. Each call returns at most
five sources and times out after 10 seconds. Agents are instructed to cite sources
and treat retrieved content as evidence rather than instructions.

Without a key, web search is unavailable; chat and planning still work. There is
no fallback to another search provider. Chat can still fetch supplied page URLs.
Existing conversations keep their saved messages when search permissions change.

With `npm start` running, verify the complete agent → Tavily → MongoDB → citation
flow in a second terminal using `npm run search:smoke`. This opt-in command calls
the live model and Tavily API and removes only its own temporary evidence.
See [configuration](docs/configuration.md#tavily-search) for separate OpenCode servers.

## Agent behavior

- Conversations and their OpenCode session IDs are saved in MongoDB.
- While a reply runs, chat shows actual agent activity (searching, reading pages, and
  preparing the response), elapsed time, and the latest tool outcomes. Progress survives
  reloads and stays scoped to its conversation. Finished replies retain an expandable
  activity history. If OpenCode's event stream is unavailable, the reply continues with
  an explicit status; tool arguments, outputs, and private reasoning are never displayed.
- With Tavily configured, chat can search the web and retrieve pages. Chat cannot read or modify local
  files, run shell commands, or create repository changes.
- Repository jobs require GitHub sign-in, a connected GitHub App installation,
  explicit access for the selected repository, and execution enabled on the worker.
- An enabled repository agent works in an isolated job directory. The executor
  checks changes, pushes a dedicated branch, and opens a reviewable PR. It does
  not push to the default branch or merge automatically.
- Tool results and errors are handled by the server; credentials stay server-side.

For remote repository execution, see [Daytona setup and recovery](docs/daytona.md).

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
| `npm run db:init` | Initialize database indexes, including goal runs |
| `npm run search:smoke` | Opt-in live agent search and citation check; requires Tavily, MongoDB, and a running OpenCode server |
| `npm run test:browser` | Verify goal creation and reload in Chromium; with `MONGODB_TEST_URI`, also verify a full app restart |
| `npm run build` | Compile TypeScript |

`npm ci` is supported for repeatable installation. If lifecycle scripts were
disabled, reinstall with scripts enabled so the OpenCode binary is installed,
then run `npm run setup`.

For optional local database development, use `docker compose up -d --wait`.
Database integration tests use `MONGODB_TEST_URI` and disposable test databases.
Docker is not needed when using Atlas.

Install the browser for local UI verification with `npx playwright install chromium`.
Browser tests use a deterministic model fixture with MongoDB; without
`MONGODB_TEST_URI`, they verify the labeled demo interface with temporary storage.
The browser suite uses its own disposable database and never the application database.

## Delivery plan

Follow [Epic #1](https://github.com/isayahc/Journey-Hanrness/issues/1) in separate
PRs. Goal creation, validated planning, checkpointed repository-step execution, and restart
recovery are implemented. Richer memory, objective criteria evaluation/repair loops, and
measured strategy adaptation remain subsequent increments.
