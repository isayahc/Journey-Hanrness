# Runtime architecture

## Startup

`npm install` installs the pinned `opencode-ai` CLI and matching SDK. The setup
script creates `.env` only if it is missing. `npm start` loads that environment,
checks the configured OpenCode service, starts a local service when needed, and
then launches the HTTP application. A remote service must already be running.

The OpenCode URL is shared by the supervisor, chat adapter, and repository agent.
Health checks use the configured server credentials. The CLI and application
default to `opencode/space-bunny-free`; `OPENCODE_MODEL` overrides that default.

## Chat

The HTTP app owns browser sessions, validates message input, and stores
conversations in MongoDB. Each conversation retains its OpenCode session ID.
Messages are sent through the SDK with an explicit model and a 90-second timeout.

Chat sessions deny tools by default, then allow `websearch` and `webfetch`.
They cannot modify files or run shell commands. Model and connectivity errors
return useful status without discarding the user's saved conversation.

Local development supports anonymous browser sessions. Configuring GitHub OAuth
enables authenticated accounts with MongoDB-backed sessions. Conversations and
repository authorization are scoped to the authenticated user.

## Repository jobs

A repository must belong to the verified installation, remain connected, and
have agent access explicitly enabled. `JOURNEY_AGENT_EXECUTION_ENABLED=1` enables
the executor on a worker where repository checks are permitted to run.

Each job records its base commit and dedicated branch, clones into a temporary
directory, and gives OpenCode file tools plus narrowly permitted read-only Git
inspection. The agent cannot commit, push, edit `.git`, or access external paths.
The executor runs detected npm checks, verifies policy and branch state, commits
the result, pushes its job branch, and opens a pull request. It never merges.

GitHub credentials are scoped to the job's repository, kept in memory, and
provided only to the clone/push subprocesses. Job state is rechecked before
credential reuse. Webhooks revoke stale repository access. Workspace cleanup
runs after execution, including failures.

## Extension points

`src/chat/` handles conversations and model calls. `src/agents/` handles
repository execution. `src/auth/` and `src/github/` handle accounts and access.
`src/db.ts` owns MongoDB connections. The separate `src/research/` worker remains
an offline stub and is not connected to chat or autonomous goal execution.

The next increments introduce durable goals, recoverable checkpoints, evidence
memory, objective checks, and versioned strategy adaptation. Conversation
history alone does not provide those execution guarantees.
