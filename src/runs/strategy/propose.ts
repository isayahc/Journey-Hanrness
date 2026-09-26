import { FAILURE_EVIDENCE_INSTRUCTION, type ProposalInput, type RecordedOutcome, type StrategyConfig } from "./models.js";

/**
 * Proposer `failure-evidence-v1`.
 * Reads failed objective outcomes and suggests selecting failure evidence on the
 * next attempt. It does not change tools, repository access, execution limits,
 * or the execution approach.
 */
export function proposalFromOutcomes(parent: StrategyConfig, outcomes: RecordedOutcome[]): ProposalInput | null {
  const failed = outcomes.filter(outcome => !outcome.success && /schema|invalid|verification failed/i.test(outcome.feedback));
  if (!failed.length) return null;
  if (parent.memorySelection.includeFailureEvidence && /failure evidence/i.test(parent.planningInstructions)) return null;
  const planningInstructions = /failure evidence/i.test(parent.planningInstructions)
    ? parent.planningInstructions
    : `${parent.planningInstructions} ${FAILURE_EVIDENCE_INSTRUCTION}`;
  const cited = failed.slice(0, 5).map(outcome => outcome.id).join(", ");
  return {
    rationale: `${failed.length} recorded outcome(s) failed an objective check (${cited}). Select the recorded failure evidence and revise the next attempt. Tools, repository access, and execution limits stay at the parent strategy.`,
    evidenceIds: failed.map(outcome => outcome.id),
    planningInstructions,
    memorySelection: { includeFailureEvidence: true },
  };
}
