import assert from "node:assert/strict";
import test from "node:test";
import { researchResult, userInput } from "../src/models.js";
import { createProvider, OpenCodeResearchProvider, StubResearchProvider } from "../src/research/provider.js";

const user = {
  ...userInput.parse({ userId: "test", displayName: "Test User", interests: ["robotics"] }),
  createdAt: new Date(), updatedAt: new Date(),
};

test("offline profiles contain only supplied interests and valid evidence", async () => {
  const result = researchResult.parse(await new StubResearchProvider().research(user));
  assert.deepEqual(result.signals.map(signal => signal.description), ["robotics"]);
  assert.equal(result.sources[0]?.kind, "platform");
});

test("dangling evidence references are rejected", () => {
  assert.throws(() => researchResult.parse({
    summary: "", sources: [],
    signals: [{ kind: "interest", description: "robotics", sourceIds: ["missing"] }],
  }));
});

test("invalid links and oversized profiles are rejected", () => {
  assert.throws(() => userInput.parse({ userId: "test", displayName: "Test", publicLinks: ["javascript:alert(1)"] }));
  assert.throws(() => userInput.parse({ userId: "test", displayName: "x".repeat(201) }));
});

test("unknown providers and unfinished OpenCode fail explicitly", async () => {
  assert.throws(() => createProvider("typo"));
  await assert.rejects(new OpenCodeResearchProvider().research(user), /not implemented/);
});
