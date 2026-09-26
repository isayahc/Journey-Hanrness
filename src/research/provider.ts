import type { PlatformUser, ResearchResult } from "../models.js";

export interface ResearchProvider {
  readonly name: "stub" | "opencode";
  research(user: PlatformUser): Promise<ResearchResult>;
}

// Offline skeleton: copies only explicitly supplied platform interests.
export class StubResearchProvider implements ResearchProvider {
  readonly name = "stub";
  async research(user: PlatformUser): Promise<ResearchResult> {
    return {
      summary: `Offline draft for ${user.displayName}. External research has not run.`,
      sources: [{ id: "platform-profile", kind: "platform", label: "User-supplied platform profile" }],
      signals: user.interests.map(interest => ({
        kind: "interest", description: interest, sourceIds: ["platform-profile"],
      })),
    };
  }
}

export class OpenCodeResearchProvider implements ResearchProvider {
  readonly name = "opencode";
  async research(_user: PlatformUser): Promise<ResearchResult> {
    // TODO: create a scoped OpenCode session, provide the research prompt,
    // invoke approved search tools, and validate the structured response.
    throw new Error("OpenCode research is not implemented; use RESEARCH_PROVIDER=stub");
  }
}

export function createProvider(value = process.env.RESEARCH_PROVIDER || "stub"): ResearchProvider {
  if (value === "stub") return new StubResearchProvider();
  if (value === "opencode") return new OpenCodeResearchProvider();
  throw new Error("RESEARCH_PROVIDER must be stub or opencode");
}
