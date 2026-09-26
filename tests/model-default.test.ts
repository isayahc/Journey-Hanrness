import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeRepositoryAgent } from "../src/agents/opencode-repository-agent.js";
import { resolveOpenCodeModel } from "../src/opencode-model.js";

test("repository jobs use the shared model default and preserve explicit overrides", async () => {
  for (const value of [undefined, "", "  ", "custom/provider-model"]) {
    const env = { OPENCODE_MODEL: value };
    let requestedModel: unknown;
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/message")) {
        requestedModel = (await request.json()).model;
        return Response.json({ info: {}, parts: [] });
      }
      return Response.json({ id: "session" });
    };
    await new OpenCodeRepositoryAgent(env, fakeFetch).modify("/workspace/repo", "Inspect");
    assert.deepEqual(requestedModel, resolveOpenCodeModel(env).model);
    if (!value?.trim()) assert.equal(resolveOpenCodeModel(env).name, "opencode/space-bunny-free");
  }
});
