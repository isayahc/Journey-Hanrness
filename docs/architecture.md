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

Chat sessions deny tools by default, then allow `webfetch` and, when configured,
the project `tavily_search` tool. Built-in `websearch` is not enabled for these sessions.
They cannot modify files or run shell commands. Model and connectivity errors
return useful status without discarding the user's saved conversation.

Local development supports anonymous browser sessions. Configuring GitHub OAuth
enables authenticated accounts with MongoDB-backed sessions. Conversations and
repository authorization are scoped to the authenticated user.

## Goals and execution plans

`src/runs/` owns goal validation, plan generation, and persistence in `goal_runs`.
Runs contain the goal, success criteria, execution limits, selected model, status,
planning attempt count, and timestamps. Validated plans contain ordered steps,
dependencies, instructions, and proposed objective verification requirements.

`POST /api/runs` saves a draft before any model call. `POST /api/runs/:id/plan`
claims a planning attempt and requests a JSON plan from a fresh OpenCode session
with execution tools denied and optional Tavily search. The model is taken from the saved run. The server validates
shape, field bounds, step limits, unique IDs, and dependency ordering before saving
the plan. A plan does not constitute evidence of completed work.

Planning requests have a 90-second model timeout and a two-minute database lease.
Atomic claims and attempt tokens prevent duplicate requests and stale responses
from overwriting newer progress. Expired attempts can be retried manually; no
background worker is introduced here. A run allows at most three planning attempts.
Provider failures are saved as sanitized errors; invalid plans include actionable
feedback. A successful retry clears the error. There is no automatic model fallback.

`GET /api/runs` lists the latest 50 runs for the owner; `GET /api/runs/:id` retrieves
a saved run. All reads and mutations use the existing authenticated account or
anonymous browser owner. Mutation routes require same-origin JSON requests.
The `/goals` interface displays criteria, stored limits, status, the pinned strategy
version, and the plan. New runs pin the owner's active strategy version. Runs saved
before strategy versioning stay unpinned until an explicit migration. Execution
attempts and time budgets are stored for the upcoming step executor; this increment
does not execute steps or claim task completion.

## Search evidence

The OpenCode custom tool delegates to `src/search/`, which calls Tavily's search
API with server-side credentials. Tool arguments contain only the query and result
count. The trusted OpenCode session ID resolves a short-lived authorization stored
in `search_contexts`; the model cannot select an owner, conversation, or goal.
The app binds a session before inference and releases it afterward. Bindings expire
after two minutes if the app stops. Attempt tokens keep stale cleanup from revoking
a newer request. A context retains its atomic usage counter across sessions/restarts.

Results and sanitized failures are saved in `search_evidence` before returning to
the model. Every record is scoped to its owner and conversation/run, with an ID,
query, retrieval time, and bounded sources. Authenticated evidence routes verify
resource ownership before reading. Previous evidence is supplied when a chat
continues or a goal retries planning. Search failure does not complete a run or
discard its goal; the agent can report the limitation or plan a later research step.

Chat sessions are recreated when search permissions change, carrying the saved
transcript into the new session. Session version 3 has page fetching and no search;
version 4 adds Tavily. Repository agents are not granted this search tool yet.

API contracts: [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
and [OpenCode custom tools](https://opencode.ai/docs/custom-tools/).

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

## Harness strategies

`src/runs/strategy/` versions bounded harness strategies and compares them before
promotion. A strategy configures planning instructions, memory selection, and
execution approach (`dependency-ready` or `sequential`). Tools, repository access,
and execution limits are copied from the parent and are a ceiling: a proposal that
adds a tool, raises repository access, or increases a step, attempt, duration,
context, or evidence budget is rejected and not saved as a candidate.

Collections, all owner-scoped:

| Collection | Contents |
| --- | --- |
| `harness_strategies` | Immutable strategy versions, rationale, evidence ids, parent, and proposer |
| `harness_strategy_heads` | The single active strategy id for an owner |
| `harness_strategy_outcomes` | Recorded outcomes the proposer may cite |
| `harness_strategy_comparisons` | One baseline-versus-candidate comparison |
| `harness_strategy_evaluations` | Per-case measurements linked to a comparison |
| `harness_strategy_decisions` | Promotion, rejection, and rollback decisions |
| `harness_strategy_migrations` | Explicit run pin changes |

The baseline (`failure-evidence-v1`'s parent) verifies each success criterion, keeps
the goal in memory, and does not select failure evidence. Proposer
`failure-evidence-v1` reads failed schema or validation outcomes and proposes one
change: include recorded failure evidence and append a revision instruction. It
does not call a model.

Promotion uses evaluation set `repair-v1` and executor `deterministic-v1`. Both
sides share the parent limits and the service model. Measured time is 100ms per
attempt, and tool calls stay at zero. Criteria `strict-improvement-v1` promote a
candidate only when it has no case regression and either passes more cases, passes
the same cases in fewer attempts, or uses the same attempts in less measured time.
Otherwise the candidate is rejected and the active strategy stays in place.

On `repair-v1` the baseline passes `stable-summary` and `citation-check` and fails
`schema-repair` (2/3 successes, 5 attempts, 500ms, 5 model calls). The failure-evidence
candidate also passes `schema-repair` on attempt 2 (3/3 successes, 4 attempts, 400ms,
4 model calls). That is the measured improvement for this set only.

Holdout set `holdout-v1` contains `failure-noise`, which the baseline passes and the
failure-evidence candidate fails. A stored holdout comparison is evidence for
rollback: the parent becomes active again and the candidate is marked `rolled_back`.
The same candidate is not a general improvement.

`POST /api/runs/:id/strategy` migrates one run to a retained strategy and writes a
migration record. Promoting a strategy does not rewrite existing run pins.

Planning loads the pinned version, not the current active strategy. Session
permissions stay denied (plus optional Tavily). Strategy tools are shown only as
frozen data and are not granted.

### Gaps left by milestones 2–4

Issues #21, #22, and #23 are not implemented in this repository. This increment
does not add checkpointed step execution, worker leases, full run-memory
reconstruction, or a live repair loop.

- Outcomes are recorded explicitly. The evaluation harness does not execute saved plan steps.
- `selectMemory` applies the strategy's memory policy to supplied items and never treats assumptions as verified evidence. It does not rebuild an OpenCode session from durable run memory.
- `deterministic-v1` measures the strategy difference on fixed cases. It does not call OpenCode or prove a live task was repaired.

## Extension points

`src/chat/` handles conversations and model calls. `src/agents/` handles
repository execution. `src/auth/` and `src/github/` handle accounts and access.
`src/db.ts` owns MongoDB connections. The separate `src/research/` worker remains
an offline stub and is not connected to chat or autonomous goal execution.

Step execution, recoverable checkpoints, durable run memory, and live objective
repair remain later increments. Strategy versions are comparable only under the
recorded evaluation configuration above. Conversation history alone does not
provide those execution guarantees.
