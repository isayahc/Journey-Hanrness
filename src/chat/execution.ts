import { z } from "zod";

// Only a bounded relative directory is accepted; command names/flags never come from the model.
export const scaffoldInput = z.object({
  framework: z.literal("nextjs"),
  directory: z.string().max(120).regex(/^(\.|[a-zA-Z0-9][a-zA-Z0-9_-]*(\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)$/),
}).strict();
export type ScaffoldInput = z.infer<typeof scaffoldInput>;
export const executionRequest = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  instruction: z.string().trim().min(1).max(12000),
  scaffold: scaffoldInput.nullable(),
}).strict();
export type ChatExecutionRequest = z.infer<typeof executionRequest>;
export const structuredReply = z.object({
  content: z.string().trim().min(1).max(16000),
  execution: executionRequest.nullable(),
}).strict();

export const replySchema = {
  type: "object", additionalProperties: false, required: ["content", "execution"],
  properties: {
    content: { type: "string" },
    execution: { anyOf: [{ type: "null" }, {
      type: "object", additionalProperties: false, required: ["repository", "instruction", "scaffold"],
      properties: {
        repository: { type: "string", description: "Exact owner/repository from the trusted GitHub context" },
        instruction: { type: "string", description: "The user's authorized change, with relevant conversation context" },
        scaffold: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false, required: ["framework", "directory"],
          properties: { framework: { type: "string", enum: ["nextjs"] }, directory: { type: "string", description: "Relative directory; . for repository root" } },
        }] },
      },
    }] },
  },
};

export interface ChatJobLink {
  jobId: string;
  repositoryId: number;
  repositoryFullName: string;
  instruction: string;
  scaffold?: ScaffoldInput;
  pending: boolean;
  error?: string;
  cancelled?: boolean;
}
