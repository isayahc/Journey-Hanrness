import type { CaseComparison, ComparisonVerdict, EvaluationRecord, SideSummary } from "./models.js";

export function caseScore(record: EvaluationRecord): CaseComparison["baseline"] {
  return {
    success: record.success,
    attempts: record.attempts,
    durationMs: record.durationMs,
    modelCalls: record.usage.modelCalls,
    toolCalls: record.usage.toolCalls,
  };
}

export function summarize(records: EvaluationRecord[]): SideSummary {
  return {
    successes: records.filter(record => record.success).length,
    cases: records.length,
    attempts: records.reduce((total, record) => total + record.attempts, 0),
    durationMs: records.reduce((total, record) => total + record.durationMs, 0),
    modelCalls: records.reduce((total, record) => total + record.usage.modelCalls, 0),
    toolCalls: records.reduce((total, record) => total + record.usage.toolCalls, 0),
  };
}

export function judge(baseline: EvaluationRecord[], candidate: EvaluationRecord[]): ComparisonVerdict {
  if (baseline.length === 0 || baseline.length !== candidate.length) {
    throw new Error("Baseline and candidate need the same non-empty evaluation cases.");
  }
  const regressions: string[] = [];
  const improvements: string[] = [];
  const cases: CaseComparison[] = baseline.map(base => {
    const next = candidate.find(item => item.caseId === base.caseId);
    if (!next) throw new Error(`Candidate is missing evaluation case ${base.caseId}.`);
    if (base.success && !next.success) regressions.push(base.caseId);
    if (!base.success && next.success) improvements.push(base.caseId);
    return { caseId: base.caseId, baseline: caseScore(base), candidate: caseScore(next) };
  });
  const baselineSummary = summarize(baseline);
  const candidateSummary = summarize(candidate);
  const improved = candidateSummary.successes > baselineSummary.successes
    || (candidateSummary.successes === baselineSummary.successes && candidateSummary.attempts < baselineSummary.attempts)
    || (candidateSummary.successes === baselineSummary.successes && candidateSummary.attempts === baselineSummary.attempts && candidateSummary.durationMs < baselineSummary.durationMs);
  return {
    reason: regressions.length ? "REGRESSION" : improved ? "IMPROVEMENT" : "NO_IMPROVEMENT",
    regressions,
    improvements,
    baseline: baselineSummary,
    candidate: candidateSummary,
    cases,
  };
}
