# Daytona repository execution

Set `JOURNEY_AGENT_EXECUTION_ENABLED=1` and
`JOURNEY_AGENT_EXECUTION_BACKEND=daytona` on the server. Set `DAYTONA_API_KEY`
and the existing MongoDB/GitHub App configuration described in
[configuration](configuration.md). Optional settings are `DAYTONA_API_URL`,
`DAYTONA_TARGET`, and `DAYTONA_IMAGE` (default `node:22-bookworm`). The image must
include Node.js 22+, npm, Git, a POSIX shell, and `nohup`.

Keep `JOURNEY_AGENT_EXECUTION_BACKEND=local` for explicit host development.
An unknown backend or missing Daytona key disables execution and surfaces a
configuration error in chat; it never falls back to local execution. Existing installations default to local for compatibility.
Daytona jobs still require GitHub sign-in, a connected installation, repository
opt-in, and the existing per-action write policy.

## Runtime and review

Each repository job gets one private sandbox, identified by a deterministic job
name plus labels for the job and a hash of its owner. OpenCode 1.18.32 is installed
under `/tmp/journey/runtime`, outside the checkout. Its authenticated server runs
inside the sandbox; the application accesses its private preview with a header
that is never returned to the user or saved to MongoDB. The agent retains the
existing file permissions and narrow read-only Git command allowlist.

`OPENCODE_MODEL=opencode/space-bunny-free` remains the default. Explicit
`provider/model` overrides are honored without fallback. Host OpenCode provider
login files and provider secrets are not copied into sandboxes; use a model
available without those host credentials. Credentialed provider provisioning is
not part of this increment.

The authorized repository is cloned at its recorded base SHA. If the GitHub
repository is empty, the application first creates a minimal
`.journey-harness/.gitkeep` bootstrap commit on the configured default branch,
then uses that commit as the job base. All agent edits, package reads,
dependency installation, and check commands run remotely. For npm
projects with check/test/build scripts, dependencies are installed with `npm ci`
when a lockfile exists, or `npm install --package-lock=false` otherwise. Checks
run in order and stop on failure. Other project check systems remain unchanged
from the existing executor and are not auto-detected.

Only the dedicated `journey-harness/<job-id>` branch is pushed by the agent
executor. Empty-repository bootstrap is the sole exception and creates only the
minimal marker commit described above. Workflow edits remain subject to
repository policy. The executor opens a PR and never merges it. The owner-scoped
MongoDB job retains check results,
a bounded command metadata log, summary, commit SHA, and review artifact references
(PR files and job checks). Raw output, command arguments, model server logs,
GitHub tokens, and preview credentials are not persisted as command logs.
GitHub installation tokens are passed only to clone/push command environments;
the host Daytona key is never transferred. Runtime, home, cache, and temporary
files live outside the checkout.

## Lifecycle and recovery

Sandboxes have 2 CPUs, 4 GiB memory, and 10 GiB disk. Each command is bounded to
at most 15 minutes; the agent prompt is bounded to 15 minutes. Sandboxes stop
after 30 idle minutes, are deleted after 120 continuously stopped minutes, and
have a hard 24-hour TTL. Success and cancellation delete immediately. Failure
stops the sandbox for inspection/recovery. Cleanup failures are recorded as
`cleanup_failed`; provider lifecycle limits remain active if the worker dies.
MongoDB records the last observed lifecycle state and expiry, not a live mirror
of provider-side automatic deletion.

A MongoDB atomic claim permits one worker per job with a 90-minute lease. An
interrupted worker's job may be resumed after the lease expires; a failed job
releases its lease immediately. Authenticated owner-only endpoints:

- `GET /api/agent-jobs/<id>`: inspect saved progress and results.
- `POST /api/agent-jobs/<id>/resume`: resume a failed or expired-lease job.
- `POST /api/agent-jobs/<id>/cancel`: cancel work and delete its sandbox.

Resume reloads persisted authorization and rechecks current repository policy.
It verifies sandbox labels before using or deleting a workspace, stops surviving
processes, and reconnects the saved filesystem. A lookup/connectivity error never
causes a second sandbox to be provisioned. Interrupted provisioning is reconciled
by deterministic name. Before the initial checkout checkpoint, a partial checkout
can be safely rebuilt. After that checkpoint, a missing/expired workspace fails
closed rather than discarding progress. Local workspaces are deleted at completion
or failure and do not support checkpoint recovery.

Checkpoints cover checkout, scaffolding, edits, commit, push intent/result, and PR intent/result.
Saved edits do not rerun the model; saved commits do not rerun checks or commit.
An uncertain push must match the saved commit on GitHub before proceeding. An
uncertain PR request queries all PR states by its unique job branch and base;
a matching PR is reused. Failed lookups or a different remote head return
`AGENT_RECOVERY_REQUIRES_RECONCILIATION` and never blindly push again. If a local
commit finishes before its checkpoint is saved, recovery may require inspection;
it does not fabricate success. Unclaimed chat submissions are recovered automatically from the conversation outbox.
Running or failed jobs require owner resume; provider TTL handles abandoned sandboxes.

## Verification

Default tests use deterministic fixtures; they do not provision paid resources:

```sh
npm run check
npm test
npm run build
```

To opt into a live sandbox/model smoke test, put `DAYTONA_API_KEY` in `.env` and run:

```sh
DAYTONA_LIVE_TEST=1 node --env-file=.env --import tsx --test tests/daytona-live.test.ts
```

This provisions one sandbox, starts its project-local OpenCode server, asks the
selected model to create a file, verifies its content and a Git check, and deletes
the sandbox in `finally`. It may incur provider/model costs and needs network
access to Daytona, npm, and the selected model provider. It does not push to GitHub.

For the full authorized repository smoke test, use a disposable repository with a
small npm test and a working GitHub App installation. Enable access in the app,
submit an edit, and inspect the owner job endpoint. Verify remote sandbox ID,
check results, saved commit, PR files, and final `deleted` state. Do not merge.
Repeat with a failing check (expect `stopped` and preserved `modified` checkpoint),
then resume or cancel. To test worker restart, stop the app while working, restart
with the same MongoDB database, and resume after lease expiry. To test an uncertain
PR, disconnect the worker after GitHub accepts the request and verify resume finds
the existing PR without creating another.

SDK reference: https://www.daytona.io/docs/en/typescript-sdk/

## Starting work from chat

After signing in, connect a repository, sync it and enable **Agent access** in
Repositories. Ask, for example, “Create a Next.js app in alice/disposable-app” or
“Update the welcome page in alice/existing-app.” The repository must have a
usable default-branch commit; a README-only initialization is sufficient. Chat
asks for a target when it is ambiguous. Repository lists and ordinary discussion
do not create jobs. **Chat execution always requires Daytona**, even if the
separate repository-job form is configured for local development.

The conversational model returns a validated structured decision. The server
resolves repository identity from current owner-scoped records, rechecks active
installation, opt-in and write policies, and atomically appends the user message
and assistant job receipt. That append is a MongoDB outbox: a stable job ID and
message request ID are saved before execution. The server dispatches immediately
and checks pending receipts every five seconds and on startup. A database-unique
job ID plus the existing atomic worker claim prevents repeated deliveries from
provisioning another sandbox. A failed submission remains visible with an
explanation; fix the problem and send a new request.

The browser supplies a UUID request ID to `POST /api/chats/<id>/messages` and keeps
it in tab session storage across retries/reloads. Reusing it with the same message
returns the saved conversation; different content returns 409. API integrations
must retain and reuse their request ID for retry safety. The field is optional
for older callers, which do not get this retry guarantee. The chat append uses an
optimistic version check so competing turns cannot both be committed.

Job cards read saved job status, checkpoints, install/check results, summary and
PR link through `GET /api/chats/<id>/jobs`. They survive reload and server restart;
the other conversations remain usable. **Stop reply** stops only the conversational
model before its receipt is saved. **Cancel job** cancels the specific submitted
job through the existing owner-scoped endpoint, including the brief interval
before its GitHub base lookup completes. **Resume job** uses the saved job,
workspace and branch after a failure or an expired worker lease.

## Controlled Next.js setup

A structured `scaffold: {framework: "nextjs", directory: "."}` action runs a fixed
`create-next-app@16.3.6` invocation in Daytona with TypeScript, App Router, Tailwind,
ESLint, npm, `--yes`, `--skip-install` and `--disable-git`. Package name, version,
flags and command text cannot be supplied by the model. The chat agent still has
no shell/write tools, and the repository agent retains its existing read-only Git
shell allowlist. CLI reference: https://nextjs.org/docs/app/api-reference/cli/create-next-app

Setup accepts `.` or ordinary relative directories such as `apps/web`. Absolute
paths, traversal, hidden path components, symlinks and shell metacharacters are
rejected. It generates outside the checkout, then copies into a directory
containing only Git metadata, README/license and ignore files. It preserves the
existing README/license and appends the template's ignore rules. Existing app
files cause a conflict rather than an overwrite; choose a new directory or ask
for an edit instead. An atomic merge-intent file makes interrupted copying
replayable. After setup the repository model customizes the files, and the
existing dependency/check pipeline runs in the selected app directory. Creating
new GitHub repositories and arbitrary scaffolding commands are outside this flow.

## Live chat-to-PR smoke test

The automated unit/integration/browser suites use fake OpenCode, GitHub and
sandbox services. The MongoDB tests use a real disposable database in CI. These
tests do **not** establish that a live Daytona account/model is available.

For a real smoke test, use a disposable GitHub repository initialized with only
a README. Connect and enable it in the running application configured above.
Set these variables in your local test environment (do not commit or share the
session cookie):

```sh
JOURNEY_SMOKE_ORIGIN=http://localhost:3000
JOURNEY_SMOKE_REPOSITORY=your-account/disposable-app
JOURNEY_SMOKE_SESSION=<your authenticated journey_session cookie>
CHAT_DAYTONA_LIVE_TEST=1
```

Then run with those variables exported, or in a private env file:

```sh
node --env-file=.env --import tsx --test tests/chat-daytona-live.test.ts
```

This sends the request through the real chat endpoint, retries the same request
ID, checks that exactly one linked job exists, and waits for a Daytona sandbox ID,
passing production build, PR link, deleted sandbox and persisted conversation.
It creates a branch and PR and may incur costs. It cancels an unfinished job on
failure; review and close the smoke PR afterward. Do not merge it automatically.
Also exercise failed-check/resume and restart-after-lease-expiry scenarios described
above. No live verification is claimed merely because the opt-in tests are present.
