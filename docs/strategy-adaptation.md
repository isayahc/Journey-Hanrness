# Versioned harness strategies

This module is the persistence and decision boundary for milestone #24.

A strategy is an immutable versioned record. Changes create a child version rather than modifying an existing strategy. Candidate strategies retain their rationale and proposal-evidence references. Promotion compares the candidate with the currently active baseline on the same versioned evaluation cases and model/configuration.

Promotion is intentionally conservative:

- every baseline success must remain a success;
- at least one case must improve in success, attempts, elapsed time, or usage;
- tools, repository access, and execution limits cannot expand;
- incomplete or mismatched evaluation results are rejected.

Promotion retires the previous active strategy and activates the candidate. Rollback reverses those statuses without changing either strategy's immutable configuration.

The evaluation records store the evaluation-set version, model, limits, per-case results, evidence references, and decision reason so restart does not erase why a strategy was promoted or rejected.

## Integration boundary

This PR intentionally does not claim full milestone #24 completion. Run-level strategy pinning should be wired into `GoalRun` creation once #22 and #23 provide the durable memory/evaluation records that candidate generation and repeatable comparisons need. Until then, the strategy service is independently testable and does not alter execution behavior.
