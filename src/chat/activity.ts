import type { Event } from "@opencode-ai/sdk/v2";
import { SEARCH_TOOL } from "../search/service.js";

export interface ChatActivity {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
  at: string;
}
export type ActivityUpdate = Omit<ChatActivity, "at">;
export const MAX_CHAT_ACTIVITY = 12;

/** Only public tool lifecycle metadata is exposed, never reasoning, arguments, or output. */
export function activityFromEvent(event: Event, sessionID: string, calls: Map<string, string>): ActivityUpdate | undefined {
  const properties = event?.properties;
  if (!properties || typeof properties !== "object") return;
  const eventSession = "sessionID" in properties ? properties.sessionID
    : event.type === "message.part.updated" ? event.properties.part?.sessionID : undefined;
  if (eventSession !== sessionID) return;
  if (event.type === "session.status" && event.properties.status.type === "retry"
    || event.type === "session.next.retried") {
    return { id: "model-retry", label: "Waiting for the model to retry", status: "running" };
  }
  if (event.type === "message.part.updated") {
    const part = event.properties.part;
    if (part.type !== "tool" || part.sessionID !== sessionID) return;
    return toolActivity(part.callID, part.tool, part.state.status, part.state.input);
  }
  if (event.type === "session.next.tool.called") {
    const { callID, tool, input } = event.properties;
    const activity = toolActivity(callID, tool, "running", input);
    if (activity) calls.set(callID, activity.label);
    return activity;
  }
  if (event.type === "session.next.tool.success" || event.type === "session.next.tool.failed") {
    const id = event.properties.callID, label = calls.get(id);
    if (label) return { id, label, status: event.type.endsWith("success") ? "completed" : "failed" };
  }
}

function toolActivity(id: string, tool: string, status: string, input: Record<string, unknown>): ActivityUpdate | undefined {
  let label: string;
  if (tool === SEARCH_TOOL || tool === "websearch") label = "Searching the web";
  else if (tool === "webfetch") {
    label = "Reading a web page";
    // Display only the host, stripping credentials, query strings, and private paths.
    try {
      const url = new URL(typeof input.url === "string" ? input.url : "");
      if (["https:", "http:"].includes(url.protocol)) label = `Reading ${url.hostname.slice(0, 120)}`;
    } catch { /* A generic label is enough for incomplete tool input. */ }
  } else if (tool === "StructuredOutput") label = "Preparing the response";
  else return;
  return { id, label, status: status === "completed" ? "completed" : status === "error" ? "failed" : "running" };
}

export function recordActivity(previous: ChatActivity[], update: ActivityUpdate): ChatActivity[] {
  const existing = previous.find(item => item.id === update.id);
  if (existing?.label === update.label && existing.status === update.status) return previous;
  const entry: ChatActivity = { ...update, at: new Date().toISOString() };
  return [...previous.filter(item => item.id !== update.id), entry].slice(-MAX_CHAT_ACTIVITY);
}
