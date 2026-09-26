import type { MemorySelection } from "./models.js";

export type MemoryKind = "goal" | "evidence" | "failure" | "decision" | "assumption";
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt?: Date;
}

/**
 * Bounded memory selection for a pinned strategy.
 * Assumptions stay distinguishable and are never promoted into the selected context.
 * This is the milestone 5 hook; full run-memory reconstruction belongs to milestone 3.
 */
export function selectMemory(selection: MemorySelection, items: MemoryItem[]): MemoryItem[] {
  const filtered = items.filter(item => {
    if (item.kind === "assumption") return false;
    if (item.kind === "goal") return selection.includeGoal;
    if (item.kind === "failure") return selection.includeFailureEvidence;
    if (item.kind === "decision") return selection.includeDecisions;
    return true;
  });
  const ordered = selection.preferRecent
    ? [...filtered].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
    : filtered;
  return ordered.slice(0, selection.maxEvidenceItems);
}
