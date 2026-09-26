# Daytona repository execution

Set `JOURNEY_AGENT_EXECUTION_ENABLED=1` and
`JOURNEY_AGENT_EXECUTION_BACKEND=daytona` on the server. Set `DAYTONA_API_KEY`
and the existing MongoDB/GitHub App configuration described in
[configuration](configuration.md). Optional settings are `DAYTONA_API_URL`,
`DAYTONA_TARGET`, and `DAYTONA_IMAGE` (default `node:22-bookworm`). The image must
include Node.js 22+, npm, Git, a POSIX shell, and `nohup`.

Keep `JOURNEY_AGENT_EXECUTION_BACKEND=local` for explicit host development.
An unknown backend or missing Daytona key fails startup; it never falls back
to local execution. Existing installations default to local for compatibility.
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

The authorized repository is cloned at its recorded base SHA. All agent edits,
package reads, dependency installation, and check commands run remotely. For npm
projects with check/test/build scripts, dependencies are installed with `npm ci`
when a lockfile exists, or `npm install --package-lock=false` otherwise. Checks
run in order and stop on failure. Other project check systems remain unchanged
from the existing executor and are not auto-detected.

Only the dedicated `journey-harness/<job-id>` branch is pushed. Workflow edits
remain subject to repository policy. The executor opens a PR and never merges it
or pushes the default branch. The owner-scoped MongoDB job retains check results,
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

Checkpoints cover checkout, edits, commit, push intent/result, and PR intent/result.
Saved edits do not rerun the model; saved commits do not rerun checks or commit.
An uncertain push must match the saved commit on GitHub before proceeding. An
uncertain PR request queries all PR states by its unique job branch and base;
a matching PR is reused. Failed lookups or a different remote head return
`AGENT_RECOVERY_REQUIRES_RECONCILIATION` and never blindly push again. If a local
commit finishes before its checkpoint is saved, recovery may require inspection;
it does not fabricate success. There is no automatic background retry/reaper in
this increment; owner resume plus provider TTL handle interrupted jobs.

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
