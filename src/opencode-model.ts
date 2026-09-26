export const DEFAULT_OPENCODE_MODEL = "opencode/space-bunny-free";

export function resolveOpenCodeModel(env: NodeJS.ProcessEnv = process.env) {
  const name = env.OPENCODE_MODEL?.trim() || DEFAULT_OPENCODE_MODEL;
  const slash = name.indexOf("/");
  if (slash < 1 || slash === name.length - 1) throw new Error("OPENCODE_MODEL must be provider/model");
  return { name, model: { providerID: name.slice(0, slash), modelID: name.slice(slash + 1) } };
}
