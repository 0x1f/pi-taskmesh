// Loaded only by test:host in a private Pi-Bolt process. No model transport or child execution.
import { writeFileSync } from "node:fs";
import { Type, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { GoalBridge } from "../../src/goal-bridge.ts";

globalThis.fetch = async () => { throw new Error("Unexpected network request in Goal tool fixture"); };

export default function (pi) {
  const report = { requests: 0, spawns: 0, calls: [], toolCalls: [], declared: [], results: [], customMessages: [] };
  const goal = { id: "existing-goal", objective: "Finish the remaining replay feature", status: "active", autoContinue: true,
    currentTaskId: "replay", usage: { tokensUsed: 3000000, activeSeconds: 2400 },
    taskList: { tasks: [{ id: "baseline", title: "Baseline", status: "complete" }, { id: "replay", title: "Replay", status: "pending" }],
      blockCompletion: true, proposedAt: "2026-10-18T01:00:00.000Z" },
    scheduler: { owner: "", generation: "generation", phase: "running", dispatch: { id: "dispatch" } } };
  const save = () => writeFileSync(process.env.TASKMESH_HOST_REPORT, JSON.stringify({ ...report, goal }));
  const agents = { enabled: true, hasActive: () => false, goalSchedule: () => undefined,
    summary: () => "Waiting for synthetic workflow", assessDetailed: async () => ({ kind: process.env.TASKMESH_HOST_DECISION || "team", reason: "Owned offline decision" }),
    async dispatch(task, _ctx, _automatic, beforeSpawn) {
      try { await beforeSpawn(); report.spawns++; report.task = task; save(); return { accepted: true }; }
      catch (error) { return { accepted: false, error: String(error) }; }
    } };
  const bridge = new GoalBridge(pi, agents);
  for (const name of ["get_goal", "update_goal"]) pi.registerTool({
    name, label: name, description: "Synthetic Goal fixture",
    parameters: Type.Object(name === "get_goal" ? {} : { continuation: Type.Any() }),
    async execute() {
      report.calls.push(name);
      if (process.env.TASKMESH_HOST_DENY === name) { save(); throw new Error("Owned Goal rejection"); }
      if (name === "update_goal") { goal.scheduler.phase = "waiting"; goal.scheduler.wait = { token: "synthetic-token" }; }
      save();
      return { content: [{ type: "text", text: "Synthetic Goal state" }],
        details: { version: 3, goal: structuredClone(goal), waitToken: "synthetic-token" }, terminate: name === "update_goal" };
    },
  });
  pi.on("session_start", (_event, ctx) => {
    bridge.reset();
    goal.scheduler.owner = ctx.sessionManager.getSessionId();
    report.active = pi.getActiveTools();
    report.exposure = pi.getAllTools().find(t => t.name === "taskmesh_goal")?.exposure;
    save();
  });
  pi.on("before_agent_start", () => {
    const trigger = process.env.TASKMESH_HOST_TRIGGER || "checkpoint";
    bridge.beforeStart(trigger === "user" ? { messageType: "user", prompt: "Continue authorized work" } :
      { messageType: "custom", message: { role: "custom", customType: "pi-goal-event",
        details: { version: 3, kind: trigger === "completion" ? "completion" : "checkpoint", goalId: goal.id,
          generation: "generation", dispatchId: trigger === "malformed" ? "" : "dispatch" } } });
  });
  pi.on("message_start", event => {
    if (event.message.role === "custom") report.customMessages.push(event.message.customType);
    save();
  });
  pi.on("tool_call", event => { report.toolCalls.push(event.toolName); save(); });
  pi.on("tool_result", event => {
    report.results.push({ name: event.toolName, content: event.content, isError: event.isError }); save();
  });
  pi.registerProvider("owned-fixture", {
    apiKey: "synthetic-local", api: "owned-fixture-api", baseUrl: "https://invalid.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      report.requests++; report.declared.push(getCurrentTools(context.messages).map(t => t.name));
      if (report.requests === 1) report.hint = getCurrentSystemPrompt(context.messages);
      save();
      const stream = createAssistantMessageEventStream();
      const name = process.env.TASKMESH_HOST_ENTRY;
      const script = "text(ALL_TOOLS.filter(t => t.name === 'taskmesh_goal')); try {text(await tools.taskmesh_goal({}));} catch(e) {text(String(e));}";
      const toolCall = { type: "toolCall", id: "owned-call", name, arguments: name === "codemode" ? { code: script } : {} };
      const first = report.requests === 1 && getCurrentTools(context.messages).some(t => t.name === name);
      const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      message.content = first ? [toolCall] : [{ type: "text", text: "Synthetic parent continuation" }];
      if (first) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      } else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
      }
      message.stopReason = first ? "toolUse" : "stop";
      stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      return stream;
    },
  });
}
