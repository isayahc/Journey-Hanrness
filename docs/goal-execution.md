# Executing saved goal plans

After configuring MongoDB, GitHub sign-in, a GitHub App installation, repository agent access,
and Daytona as described in [Daytona setup](daytona.md), open **Goals & plans**.
Generate a repository-change plan, review its steps, select an enabled repository, and choose
**Execute plan**. No additional environment variables are required. Planning alone never dispatches work.

The first supported execution format is one linear chain:

- The first step uses `execution: {"kind":"repository_change"}` with no dependencies.
- Each later step depends on the immediately preceding step. It can change the repository
  or use `execution: {"kind":"inspect_checks"}` to inspect the latest repository job's saved checks.
- The first change can include `scaffold: {"framework":"nextjs","directory":"."}` inside its execution object.
  Later changes inherit the app's check directory and modify the existing app.
- Research, manual work, branched plans, and previously saved plans without execution types
  are blocked with an explanation. Generate a new goal/plan for these cases; execution never guesses a tool action.

Each change uses the existing repository executor and a private Daytona sandbox. The first job
starts from the default branch. Later changes start from the last successful job's recorded commit
and open a PR against its agent branch. This produces **stacked PRs** that include the previous work
without automatically merging or pushing to the default branch. A changed or missing parent branch
blocks execution for reconciliation. Empty-repository initialization follows the existing minimal bootstrap policy.

## Durable execution and recovery

MongoDB's `goal_runs` documents contain the repository target, original model, fixed deadline,
step attempts, stable job IDs, checkpoints, check results, output references, and errors.
The step/job intent is saved before job creation. Duplicate requests and recovery reuse the same ID.
The application polls recoverable runs every five seconds, including on startup.

A run worker has a 30-second claim renewed every 10 seconds. Repository workers have 90-second
claims renewed every 30 seconds. All worker writes carry their claim token; expiry, replacement,
or cancellation prevents stale writes. A replaced worker cannot mark work complete or release
the new worker's lease. Daytona reconnect stops surviving sandbox processes before using saved files.
An interrupted worker's work becomes eligible after its last lease expires; completed steps are preserved.
Existing push/PR intent reconciliation prevents blind repetition of uncertain external writes.
Provider loss, missing workspaces, revoked access, and failed checks preserve progress and block with an explanation.

Use **Resume execution** after resolving a recoverable failure. It reuses the existing job and checkpoints,
consumes another allowed step attempt, and retains the original deadline and model. An interrupted
in-flight attempt continues under its existing attempt count. Neither a page reload nor server restart
resets limits. A goal's child jobs must be resumed through the goal API, so the repository-job API cannot bypass its budgets.
The existing repository-job cancellation control cancels the linked work; the goal then becomes blocked.
Full run pause/cancel controls are tracked in #25.

## Execution evidence and evaluation boundary

A repository step succeeds only after the executor completes and records at least one passing
`npm run check`, `npm test`, or `npm run build`, with no failing checks. An assistant message, a PR URL,
or dependency installation alone cannot establish step success. Missing checks block the run and preserve its PR.
`inspect_checks` reads saved check evidence; it does not rerun tests or judge arbitrary success criteria.

Step `evaluation` remains `pending`. After all execution steps succeed, the run becomes
`awaiting_evaluation`, not verified/completed. Objective criteria evaluation and automatic repair/replanning
are #23; richer memory and strategy adaptation are #22 and #24. Resuming failed checks reruns checks on
saved edits; it does not silently regenerate code or claim to repair it.

## API

All requests use the existing owner/session and same-origin checks:

- `POST /api/runs/<id>/execute` with `{"repositoryId":123}` records an execution target and queues work.
- `POST /api/runs/<id>/resume` with `{}` resumes an eligible blocked run.
- `GET /api/runs/<id>` returns persisted step progress, outputs, and actionable errors without worker tokens.

## Verification

`npm test` includes run/job claim, stale-write, attempt/deadline, owner isolation, model selection,
duplicate delivery, and dependency tests. With `MONGODB_TEST_URI`, it also tests atomic claims and
recovery through disconnected/reconnected MongoDB clients. CI provides disposable MongoDB 8.
`npm run test:browser` covers execution, failure, reload, resume, results, and mobile layout.
Provider/GitHub/Daytona services in automated tests are fixtures, not live service verification.

For a live check, configure the event Atlas Sandbox and use a disposable enabled repository with
an npm check/test/build. Generate a small plan, start execution, and record the run/job IDs and PRs.
Stop the application after a checkpoint, restart with the same database, and confirm recovery after
lease expiry retains the job IDs and completed steps. Inspect each step's check evidence, the original
deadline/model, final `awaiting_evaluation` state, and sandbox cleanup. Review and close the test PRs
without automatically merging. Live provider availability requires this separate check.
