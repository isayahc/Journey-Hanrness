import { z } from "zod";

const id = z.string().min(1).max(200);
const webUrl = z.string().url().refine(value => ["http:", "https:"].includes(new URL(value).protocol));
export const userInput = z.object({
  userId: id,
  displayName: z.string().min(1).max(200),
  headline: z.string().max(500).default(""),
  company: z.string().max(200).optional(),
  interests: z.array(z.string().min(1).max(100)).max(50).default([]),
  publicLinks: z.array(webUrl).max(20).default([]),
}).strict();
export type UserInput = z.infer<typeof userInput>;
export type PlatformUser = UserInput & { createdAt: Date; updatedAt: Date };

// Findings must reference evidence; unknown facts stay absent.
export const researchResult = z.object({
  summary: z.string().max(5000),
  sources: z.array(z.object({
    id, url: webUrl.optional(), label: z.string().min(1).max(500),
    kind: z.enum(["platform", "public_web"]),
  }).strict()).max(100),
  signals: z.array(z.object({
    kind: z.enum(["interest", "project", "professional_need", "opportunity"]),
    description: z.string().min(1).max(1000),
    sourceIds: z.array(id).min(1),
  }).strict()).max(100),
}).strict().superRefine((result, ctx) => {
  const ids = new Set(result.sources.map(source => source.id));
  if (ids.size !== result.sources.length) ctx.addIssue({ code: "custom", message: "Duplicate source IDs" });
  for (const signal of result.signals) {
    if (signal.sourceIds.some(sourceId => !ids.has(sourceId))) {
      ctx.addIssue({ code: "custom", message: "Every signal must reference an existing source" });
    }
  }
});
export type ResearchResult = z.infer<typeof researchResult>;
export type ProspectProfile = ResearchResult & {
  userId: string; jobId: string; provider: "stub" | "opencode";
  status: "draft"; updatedAt: Date;
};
export interface ResearchJob {
  jobId: string;
  userId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  errorCode?: "RESEARCH_FAILED";
}
