import assert from "node:assert/strict";
import ts from "typescript";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import { JevClient } from "../src/jev.js";
import { CapabilityRouter } from "../src/capability-router.js";
import { AgentOrchestrator, buildWorkflowScript } from "../src/orchestrator.js";
import { conversationContext, planTasks, taskBatches, validatePlan } from "../src/task-planner.js";
import { inferJson, type DecisionKind } from "../src/decision-backend.js";
import { TaskMeshSettings } from "../src/taskmesh-config.js";
import { classifyModelError } from "../src/model-router.js";

// Model responses, Jev and executor transport are local fakes; no real credentials or children.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const root = mkdtempSync(join(tmpdir(), "jev-orchestration-"));
const env = { ...process.env };
for (const key of Object.keys(process.env)) if (/^(JEV_|PI_JEV_|PI_TASKMESH$|TYPESAFE_|AI_GATEWAY_API_KEY$)/.test(key)) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "jev.json"), JSON.stringify({ typesafe: { apiKey: "offline-fixture" }, features: { auto: false, autoAgents: true } }));
new TaskMeshSettings().save({ enabled: true });
const originalEvaluate = JevClient.prototype.evaluate;
const rawPlan = {
  reason: "Inspect independent areas, implement once, then review independently.",
  tasks: [
    { id: "inspect", agent: "scout", task: "Inspect callers", dependsOn: [], profile: "fast", contextTokens: 12000 },
    { id: "research", agent: "researcher", task: "Check contracts", dependsOn: [], profile: "fast", contextTokens: 12000 },
    { id: "implement", agent: "worker", task: "Apply the minimal fix and run relevant tests", dependsOn: ["inspect", "research"], profile: "reasoning", contextTokens: 20000 },
    { id: "review", agent: "reviewer", task: "Check diff and test evidence", dependsOn: ["implement"], profile: "reasoning", contextTokens: 20000 },
  ],
};
const models = [
  { provider: "alpha", id: "quick", name: "Quick", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 8192, cost: { input: 1 } },
  { provider: "beta", id: "deep", name: "Deep", input: ["text"], reasoning: true, contextWindow: 256000, maxTokens: 8192, cost: { input: 2 } },
  { provider: "gamma", id: "deep", name: "Other deep", input: ["text"], reasoning: true, contextWindow: 256000, maxTokens: 8192, cost: { input: 2 } },
];
let team = true;
let decisionKind: DecisionKind | undefined;
let jevCalls = 0;
function choose(request: any) {
  const answers: Record<string, string> = {};
  if (request.questions.delegation) answers.delegation = decisionKind ?? (team ? "team" : "solo");
  else for (const [key, question] of Object.entries(request.questions) as [string, any][]) {
    const index = Number(key.slice(5));
    const desired = index < 2 ? "alpha/quick" : index === 2 ? "beta/deep" : "gamma/deep";
    answers[key] = Object.keys(question.criteria).find(k => JSON.parse(question.criteria[k]).id === desired) ?? Object.keys(question.criteria)[0];
  }
  return { answers, reason: "Offline task-fit choice" };
}
JevClient.prototype.evaluate = async function(request: any): Promise<any> {
  jevCalls++;
  return { answers: Object.fromEntries(Object.entries(choose(request).answers).map(([id, value]) => [id, { value }])) };
};

function fixture(mode: "ok" | "reject" | "unknown" | "no-executor" = "ok") {
  const listeners = new Map<string, Set<Function>>();
  const handlers = new Map<string, Function[]>();
  const flags = new Map<string, unknown>();
  const entries: any[] = [
    { type: "message", message: { role: "user", content: "Current project goal: keep the public API stable" } },
    { type: "custom", customType: "project-goal", data: { objective: "Preserve existing data" } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "DO_NOT_FORWARD_TOOL_SECRET" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "DO_NOT_FORWARD_THINKING" }] } },
  ];
  const notices: string[] = [];
  const requests: any[] = [];
  const plans: any[] = [];
  const controller = new AbortController();
  let spawns = 0;
  let onSpawn: (() => void) | undefined;
  let statusData: any;
  const commands = new Map<string, Function>();
  const tools = new Map<string, any>();
  let activeTools = ["read"];
  const completions = new Map<string, Function>();
  const bus = {
    on(name: string, handler: Function) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => { set.delete(handler); }; },
    emit(name: string, data: any) {
      for (const handler of listeners.get(name) ?? []) handler(data);
      if (name !== "subagents:rpc:v1:request") return;
      requests.push(data);
      if (mode === "no-executor") { controller.abort(); return; }
      let payload: any = data.method === "ping" ? { capabilities: { asyncSpawn: true } } : statusData ?? { fleet: { entries: [] }, asyncSnapshot: { runs: [] }, text: "executor status" };
      if (data.method === "spawn") {
        spawns++;
        assert.equal(data.params.async, true);
        assert.equal(data.params.cwd, root);
        assert.equal(typeof data.params.script, "string");
        assert.equal(data.params.workflowScript, undefined);
        onSpawn?.();
        if (mode === "unknown") { controller.abort(); return; }
        if (mode === "reject") { bus.emit("subagents:rpc:v1:reply:" + data.requestId, { version: 1, requestId: data.requestId, success: false, error: { code: "invalid_params", message: "Rejected before launch" } }); return; }
        payload = { details: { runId: "owned-run" } };
      }
      // A reply on the right channel still needs the exact protocol and correlation id.
      bus.emit("subagents:rpc:v1:reply:" + data.requestId, { version: 1, requestId: "wrong-id", success: true, data: { id: "wrong-run" } });
      bus.emit("subagents:rpc:v1:reply:" + data.requestId, { version: 1, requestId: data.requestId, success: true, data: payload });
    },
  };
  const pi = {
    events: bus,
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    registerFlag(name: string, options: any) { flags.set(name, options.default); },
    getFlag(name: string) { return flags.get(name); },
    registerTool(tool: any) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    registerCommand(name: string, options: any) { commands.set(name, options.handler); completions.set(name, options.getArgumentCompletions); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getActiveTools() { return [...activeTools]; }, setActiveTools(names: string[]) { activeTools = [...names]; }, getAllTools() { return [{ name: "read" }]; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, signal: controller.signal, scopedModels: [], isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "fixture-session" },
    modelRegistry: {
      getAvailable: () => models,
      async complete(model: any, context: any) {
        plans.push({ model, context });
        const request = JSON.parse(context.messages[0].content[0].text);
        const result = request.questions ? choose(request) : rawPlan;
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
    ui: { notify(text: string) { notices.push(text); }, setStatus() {} },
  } as unknown as ExtensionContext;
  return { pi, ctx, bus, entries, requests, notices, handlers, plans, listeners, controller, completions, tools, setStatusReply: (data: any) => { statusData = data; }, onSpawn: (callback: () => void) => { onSpawn = callback; }, spawns: () => spawns, command: (...args: any[]) => commands.get("jev")!(...args), taskmesh: (...args: any[]) => commands.get("taskmesh")!(...args) };
}

try {
  const brokenStream = "Antigravity: the reply ended before it was complete";
  assert.equal(classifyModelError(brokenStream), "incomplete-stream");
  const streamRouter = new CapabilityRouter();
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    streamRouter.record("beta/deep", false, brokenStream);
    assert.ok(!streamRouter.available(fixture().ctx).some(m => m.provider === "beta"));
    assert.ok(streamRouter.available(fixture().ctx).some(m => m.provider === "gamma"));
    now += 60_001;
    assert.ok(streamRouter.available(fixture().ctx).some(m => m.provider === "beta"));
  } finally { Date.now = clock; }
  const plan = validatePlan(rawPlan);
  assert.deepEqual(taskBatches(plan).map(b => b.map(t => t.id)), [["inspect", "research"], ["implement"], ["review"]]);
  assert.equal(validatePlan({ reason: "single read", tasks: [{ ...rawPlan.tasks[0], writes: true }] }).tasks[0].writes, false);
  assert.throws(() => validatePlan({ ...rawPlan, tasks: rawPlan.tasks.slice(0, 3) }), /independent review/);
  assert.throws(() => validatePlan({ ...rawPlan, tasks: rawPlan.tasks.map(t => t.id === "inspect" ? { ...t, dependsOn: ["review"] } : t) }), /Cyclic/);
  assert.throws(() => validatePlan({ ...rawPlan, tasks: [{ ...rawPlan.tasks[0], dependsOn: ["missing"] }] }), /Unknown/);
  assert.throws(() => validatePlan({ ...rawPlan, tasks: [rawPlan.tasks[0], rawPlan.tasks[0]] }), /duplicate/);
  assert.throws(() => validatePlan({ ...rawPlan, tasks: [{ ...rawPlan.tasks[0], contextTokens: NaN }] }), /invalid/);

  const f = fixture();
  const recent = conversationContext(f.ctx);
  assert.match(recent, /public API stable/);
  assert.match(recent, /Preserve existing data/);
  assert.doesNotMatch(recent, /DO_NOT_FORWARD/);
  const oldGoal = fixture();
  for (let i = 0; i < 50; i++) oldGoal.entries.push({ type: "message", message: { role: "user", content: "Later message " + i } });
  assert.match(conversationContext(oldGoal.ctx), /Preserve existing data/); // A long conversation must not drop the saved goal.
  const router = new CapabilityRouter();
  await router.assign(plan, recent, f.ctx, "jev", new JevClient());
  assert.equal(jevCalls, 1);
  jevCalls = 0;
  assert.deepEqual(plan.tasks.map(t => t.model), ["alpha/quick", "alpha/quick", "beta/deep", "gamma/deep"]);
  const scoped = { ...f.ctx, scopedModels: [{ model: models[0] }] } as unknown as ExtensionContext;
  const shortPlan = validatePlan({ reason: "Context bound", tasks: [{ ...rawPlan.tasks[0], contextTokens: 0 }, { ...rawPlan.tasks[1], contextTokens: 0, dependsOn: ["inspect"] }] });
  const smallWindow = { ...f.ctx, modelRegistry: { getAvailable: () => [{ ...models[0], contextWindow: 12000 }] } } as any;
  await assert.rejects(router.assign(shortPlan, "", smallWindow), /enough context/); // Reserve dependency output space even if the planner underestimates it.
  await assert.rejects(router.assign(validatePlan({ reason: "Large goal", tasks: [{ ...rawPlan.tasks[0], contextTokens: 0 }] }), "x".repeat(32000), smallWindow), /enough context/);
  const limited = validatePlan(rawPlan);
  await router.assign(limited, recent, scoped);
  assert.ok(limited.tasks.every(t => t.model === "alpha/quick"));
  router.record("beta/deep", false, "HTTP 429 rate limit");
  assert.ok(router.ranked(f.ctx, "reasoning", 1000).every(m => m.provider !== "beta"));
  await assert.rejects(router.assign(plan, recent, { ...f.ctx, modelRegistry: { getAvailable: () => [] } } as any), /No authenticated/);

  const script = buildWorkflowScript("Goal with a backtick \u0060 and \u0024{globalThis.INJECTED = true}", plan, recent);
  // Native scripted workflows reject nested async functions, although ordinary JS accepts them.
  const scriptAst = ts.createSourceFile("workflow.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const checkDialect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && ts.canHaveModifiers(node)) assert.ok(!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), "Native workflow dialect disallows nested async functions");
    ts.forEachChild(node, checkDialect);
  };
  checkDialect(scriptAst);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  let active = 0;
  let maximum = 0;
  const calls: any[] = [];
  const output = await new AsyncFunction("runs", script)({ async run(id: string, params: any) {
    calls.push({ id, params }); active++; maximum = Math.max(maximum, active);
    if (id === "implement") { assert.equal(active, 1); assert.match(params.task, /inspect: evidence-inspect/); assert.match(params.task, /research: evidence-research/); }
    if (id === "review") { assert.equal(active, 1); assert.match(params.task, /implement: evidence-implement/); }
    await Promise.resolve(); active--;
    return { ok: true, state: "complete", output: "evidence-" + id };
  } });
  assert.equal(maximum, 2);
  assert.deepEqual(Object.keys(output), ["inspect", "research", "implement", "review"]);
  assert.equal((globalThis as any).INJECTED, undefined);
  assert.equal(calls[0].params.model, "alpha/quick");
  assert.match(calls[0].params.task, /Read-only task/);
  let failedCalls = 0;
  await assert.rejects(new AsyncFunction("runs", script)({ async run() { failedCalls++; return { ok: false, state: "running", output: "not completed" }; } }), /no automatic replay/);
  assert.equal(failedCalls, 2); // Already-started readers settle; dependent writer never starts.

  const orchestrator = new AgentOrchestrator(f.pi, new JevClient(), true);
  orchestrator.restore(f.ctx);
  orchestrator.installCompletionNotice();
  assert.equal(await orchestrator.assess("请拆分这个跨模块重构并使用不同模型实现和审查", f.ctx), true);
  const launched = await orchestrator.dispatch("跨模块修复并验证", f.ctx, true);
  assert.equal(launched.accepted, true);
  assert.equal(launched.runId, "owned-run");
  assert.match(orchestrator.explain(), /alpha\/quick/);
  assert.match(orchestrator.explain(), /beta\/deep/);
  assert.match(orchestrator.explain(), /gamma\/deep/);
  assert.match(f.plans[0].context.messages[0].content[0].text, /public API stable/);
  assert.equal((await orchestrator.dispatch("duplicate", f.ctx, true)).busy, true);
  f.bus.emit("subagent:async-complete", { runId: "unrelated", state: "complete" });
  assert.match(orchestrator.explain(), /State: running/);
  assert.match(await orchestrator.status(f.ctx), /executor status/);
  f.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete", results: [{ model: "beta/deep", success: true }] });
  assert.match(orchestrator.explain(), /State: completed/);
  f.bus.emit("subagent:async-complete", { runId: "owned-run", state: "failed" });
  assert.match(orchestrator.explain(), /State: completed/); // Duplicate/stale receipts cannot overwrite a final state.
  const restored = new AgentOrchestrator(f.pi);
  restored.restore(f.ctx);
  assert.match(restored.explain(), /owned-run/);
  assert.match(restored.explain(), /State: completed/);
  orchestrator.dispose(); restored.dispose();
  assert.equal(f.listeners.get("subagent:async-complete")?.size, 0);
  assert.ok([...f.listeners].filter(([k]) => k.startsWith("subagents:rpc:v1:reply:")).every(([, set]) => set.size === 0));

  // A completion arriving before an older status reply must remain authoritative.
  const race = fixture();
  const racing = new AgentOrchestrator(race.pi, new JevClient(), true);
  racing.restore(race.ctx); racing.installCompletionNotice();
  await racing.dispatch("Fix and verify", race.ctx, true);
  const emitRace = race.bus.emit.bind(race.bus);
  let statusRequest: any;
  race.bus.emit = (name, data) => {
    if (name === "subagents:rpc:v1:request" && data.method === "status" && data.params.id) statusRequest = data;
    else emitRace(name, data);
  };
  const oldStatus = racing.status(race.ctx);
  race.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete" });
  emitRace("subagents:rpc:v1:reply:" + statusRequest.requestId, { version: 1, requestId: statusRequest.requestId, success: true, data: { asyncSnapshot: { runs: [{ id: "owned-run", state: "running" }] }, text: "stale running" } });
  assert.match(await oldStatus, /State: completed/);
  assert.equal(racing.hasActive(), false);
  for (const id of ["owned-run", "different-run"]) {
    const status = racing.status(race.ctx);
    emitRace("subagents:rpc:v1:reply:" + statusRequest.requestId, { version: 1, requestId: statusRequest.requestId, success: true,
      data: { details: { runId: id }, asyncSnapshot: { runs: [{ id, state: "failed" }] }, text: "older terminal state" } });
    assert.match(await status, /State: completed/);
    assert.match(racing.explain(), /Run: owned-run/);
  }
  racing.dispose();

  // Reload can miss completion, and the bounded live snapshot can omit the retained run.
  const savedRunning = { ...structuredClone(f.entries.filter(e => e.customType === "taskmesh-orchestration").at(-1).data), state: "running" };
  const retainedStatus = (state: string, snapshot = false, requestId = savedRunning.requestId) => ({
    details: { runId: "owned-run", workflowReceiptPath: join(root, "owned-run", "workflow-receipt.json"),
      workflowChildren: { version: 1, parentToolCallId: "rpc-spawn-" + requestId,
        workflowRunId: "owned-run", inventoryComplete: true, workflowState: state, children: [] } },
    asyncSnapshot: { runs: snapshot ? [{ id: "owned-run", state: "running" }] : [] }, text: "executor status",
  });
  for (const state of ["completed", "failed", "stopped", "paused"]) {
    const missed = fixture();
    missed.entries.push({ type: "custom", customType: "taskmesh-orchestration", data: structuredClone(savedRunning) });
    const recovering = new AgentOrchestrator(missed.pi, undefined, true);
    recovering.restore(missed.ctx);
    missed.setStatusReply(retainedStatus(state, state === "stopped"));
    assert.match(await recovering.resume(missed.ctx, true), new RegExp("TaskMesh " + state));
    assert.ok(recovering.summary().includes(join(root, "owned-run", "status.json")));
    assert.equal(recovering.hasActive(), state === "paused");
    recovering.restore(missed.ctx);
    assert.match(recovering.explain(), new RegExp("State: " + state));
    assert.equal(missed.spawns(), 0, "Status recovery must never spawn children");
    recovering.dispose();
  }
  for (const invalid of ["other-run", "other-workflow", "other-request", "missing-state", "rpc-error"]) {
    const missed = fixture();
    missed.entries.push({ type: "custom", customType: "taskmesh-orchestration", data: structuredClone(savedRunning) });
    const recovering = new AgentOrchestrator(missed.pi);
    recovering.restore(missed.ctx);
    const data: any = retainedStatus("stopped");
    if (invalid === "other-run") data.details.runId = "different-run";
    if (invalid === "other-workflow") data.details.workflowChildren.workflowRunId = "different-run";
    if (invalid === "other-request") data.details.workflowChildren.parentToolCallId = "rpc-spawn-different-request";
    if (invalid === "missing-state") delete data.details.workflowChildren;
    if (invalid === "rpc-error") data.isError = true;
    data.text = "State: stopped";
    missed.setStatusReply(data);
    await recovering.status(missed.ctx);
    assert.equal(recovering.hasActive(), true, invalid + " must not release duplicate protection");
    assert.match(recovering.summary(), /Run: owned-run/);
    assert.equal(missed.spawns(), 0);
    recovering.dispose();
  }

  // Goal history survives switching goals and reload; an older failure must not be replayed.
  const history = fixture();
  const historical = new AgentOrchestrator(history.pi, new JevClient(), true);
  historical.restore(history.ctx); historical.installCompletionNotice();
  const lease = (goalId: string) => async () => ({ goalId, generation: "generation", dispatchId: "dispatch", waitToken: "token" });
  await historical.dispatch("Goal A", history.ctx, true, lease("goal-a"));
  history.bus.emit("subagent:async-complete", { runId: "owned-run", state: "failed", error: "Retained failure" });
  await historical.dispatch("Goal B", history.ctx, true, lease("goal-b"));
  history.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete" });
  assert.match((await historical.goalSchedule("goal-a", history.ctx))!, /TaskMesh failed/);
  assert.match((await historical.goalSchedule("goal-b", history.ctx))!, /TaskMesh completed/);
  historical.restore(history.ctx);
  assert.match((await historical.goalSchedule("goal-a", history.ctx))!, /Retained failure/);
  assert.match((await historical.goalSchedule("goal-b", history.ctx))!, /TaskMesh completed/);
  assert.equal(history.spawns(), 2); historical.dispose();

  // Completed work is handed back to the parent instead of swallowing “continue”.
  const continued = fixture(); extension(continued.pi);
  for (const h of continued.handlers.get("session_start") ?? []) await h({}, continued.ctx);
  await continued.taskmesh("run Implement and review", continued.ctx);
  continued.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete" });
  decisionKind = "resume";
  assert.equal((await continued.handlers.get("input")![0]({ source: "interactive", text: "contine" }, continued.ctx)).action, "continue");
  const handoff = await continued.handlers.get("before_agent_start")![0]({ prompt: "contine" }, continued.ctx);
  assert.match(handoff.message.content, /owned-run/);
  assert.match(handoff.message.content, /retained.*(results|outputs)/i);
  assert.equal(continued.spawns(), 1);
  const continueInput = continued.handlers.get("input")![0];
  const beforeContinue = continued.handlers.get("before_agent_start")![0];
  await continueInput({ source: "interactive", text: "contine" }, continued.ctx);
  assert.equal((await beforeContinue({ prompt: "A different request" }, continued.ctx))?.message?.customType, undefined);
  assert.equal((await beforeContinue({ prompt: "contine" }, continued.ctx))?.message?.customType, undefined);
  await continueInput({ source: "interactive", text: "contine" }, continued.ctx);
  await beforeContinue({ messageType: "custom", message: { customType: "subagent-notify" } }, continued.ctx);
  assert.equal((await beforeContinue({ prompt: "contine" }, continued.ctx))?.message?.customType, undefined);
  assert.equal(continued.spawns(), 1);
  decisionKind = undefined;
  for (const h of continued.handlers.get("session_shutdown") ?? []) await h({}, continued.ctx);

  // A stopped native run without a completion event must return control to the parent.
  const missedContinue = fixture(); extension(missedContinue.pi);
  missedContinue.entries.push({ type: "custom", customType: "taskmesh-orchestration", data: structuredClone(savedRunning) });
  for (const h of missedContinue.handlers.get("session_start") ?? []) await h({}, missedContinue.ctx);
  missedContinue.setStatusReply(retainedStatus("stopped"));
  decisionKind = "resume";
  assert.equal((await missedContinue.handlers.get("input")![0]({ source: "interactive", text: "继续" }, missedContinue.ctx)).action, "continue");
  const stoppedHandoff = await missedContinue.handlers.get("before_agent_start")![0]({ prompt: "继续" }, missedContinue.ctx);
  assert.match(stoppedHandoff.message.content, /TaskMesh stopped/);
  assert.equal(missedContinue.spawns(), 0);
  decisionKind = undefined;
  for (const h of missedContinue.handlers.get("session_shutdown") ?? []) await h({}, missedContinue.ctx);

  // Revoking automatic delegation while Goal grants its wait must release it without spawning.
  const revoked = fixture();
  const revoking = new AgentOrchestrator(revoked.pi, new JevClient(), true);
  revoking.restore(revoked.ctx);
  const revokedWakes: any[] = [];
  revoked.bus.on("pi-goal:wake", (event: unknown) => revokedWakes.push(event));
  const revokedResult = await revoking.dispatch("Goal awaiting approval", revoked.ctx, true, async () => {
    revoking.setEnabled(false);
    return { goalId: "revoked-goal", generation: "generation", dispatchId: "dispatch", waitToken: "revoked-wait" };
  });
  assert.equal(revokedResult.accepted, false);
  assert.equal(revoked.spawns(), 0);
  assert.deepEqual(revokedWakes, [{ goalId: "revoked-goal", waitToken: "revoked-wait" }]);
  revoking.dispose();

  // The Goal adapter uses live tools and a native checkpoint, not prompt text as authority.
  async function goalFixture(mode: "ok" | "reject" | "unknown" = "ok", strict = true) {
    const f = fixture(mode); extension(f.pi);
    for (const h of f.handlers.get("session_start") ?? []) await h({}, f.ctx);
    assert.equal(f.pi.getActiveTools().includes("taskmesh_goal"), false, "Ordinary turns must not expose the Goal checkpoint tool");
    const checkpoint = { version: 3, kind: "checkpoint", goalId: "goal-fixture", generation: "generation", dispatchId: "dispatch" };
    const goal: any = { id: checkpoint.goalId, objective: "Refactor and verify the parser", status: "active", autoContinue: true,
      scheduler: { owner: "fixture-session", generation: "generation", phase: "running", dispatch: { id: "dispatch" } } };
    const calls: string[] = []; const wakes: any[] = [];
    f.bus.on("pi-goal:wake", (e: any) => wakes.push(e));
    const ctx = { ...f.ctx, async executeTool(name: string, input: any) {
      calls.push(name);
      if (name === "get_goal") return { isError: false, result: { details: { version: 3, goal: structuredClone(goal) } } };
      assert.equal(name, "update_goal"); assert.equal(input.continuation.kind, "wait");
      if (!strict) return { isError: false, result: { details: { error: true }, terminate: false } };
      goal.scheduler.phase = "waiting"; goal.scheduler.generation = "wait-generation";
      goal.scheduler.wait = { token: "wait-token" };
      return { isError: false, result: { details: { goal: structuredClone(goal), waitToken: "wait-token" }, terminate: true } };
    } };
    const before = f.handlers.get("before_agent_start")![0];
    const notice = await before({ messageType: "custom", message: { role: "custom", customType: "pi-goal-event", details: checkpoint } }, ctx);
    assert.equal(notice, undefined, "Checkpoint guidance must not inject a new custom message");
    assert.equal(f.pi.getActiveTools().includes("taskmesh_goal"), true);
    assert.match(f.tools.get("taskmesh_goal").promptGuidelines.join("\n"), /not through codemode/);
    const run = () => f.tools.get("taskmesh_goal").execute("goal-call", {}, undefined, undefined, ctx);
    return { ...f, goal, checkpoint, ctx, calls, wakes, before, run };
  }
  const oneShotGoal = await goalFixture();
  decisionKind = "solo";
  assert.match((await oneShotGoal.run()).content[0].text, /TaskMesh Goal decision: solo/);
  assert.equal(oneShotGoal.pi.getActiveTools().includes("taskmesh_goal"), false, "A refusal must remove the tool before the next model request");
  assert.match((await oneShotGoal.run()).content[0].text, /delegation unavailable/);
  assert.deepEqual(oneShotGoal.calls, ["get_goal"], "A repeated call must not reassess the same checkpoint");
  oneShotGoal.goal.scheduler.dispatch.id = "next-dispatch";
  await oneShotGoal.before({ messageType: "custom", message: { customType: "pi-goal-event", details: { ...oneShotGoal.checkpoint, dispatchId: "next-dispatch" } } }, oneShotGoal.ctx);
  assert.equal(oneShotGoal.pi.getActiveTools().includes("taskmesh_goal"), true, "A fresh checkpoint must re-enable one assessment");
  await oneShotGoal.run();
  assert.deepEqual(oneShotGoal.calls, ["get_goal", "get_goal"]);
  assert.equal(oneShotGoal.spawns(), 0);
  decisionKind = undefined;
  for (const h of oneShotGoal.handlers.get("session_shutdown") ?? []) await h({}, oneShotGoal.ctx);

  const stoppedGoal = await goalFixture();
  await stoppedGoal.run();
  stoppedGoal.goal.scheduler.phase = "running";
  stoppedGoal.goal.scheduler.generation = "generation";
  const stoppedRequestId = stoppedGoal.entries.filter(e => e.customType === "taskmesh-orchestration").at(-1).data.requestId;
  stoppedGoal.setStatusReply(retainedStatus("stopped", false, stoppedRequestId));
  await stoppedGoal.before({ messageType: "custom", message: { customType: "pi-goal-event", details: stoppedGoal.checkpoint } }, stoppedGoal.ctx);
  const stoppedGoalResult = await stoppedGoal.run();
  assert.equal(stoppedGoalResult.terminate, false);
  assert.match(stoppedGoalResult.content[0].text, /TaskMesh stopped/);
  assert.equal(stoppedGoal.spawns(), 1, "An existing Goal workflow must not be replayed after reload");
  for (const h of stoppedGoal.handlers.get("session_shutdown") ?? []) await h({}, stoppedGoal.ctx);

  const rejectedGoal = await goalFixture();
  const getRejectedGoal = rejectedGoal.ctx.executeTool;
  rejectedGoal.ctx.executeTool = async (name, input) => ({ ...await getRejectedGoal(name, input), isError: true });
  assert.match((await rejectedGoal.run()).content[0].text, /Native Goal tool failed: get_goal/);
  assert.equal(rejectedGoal.spawns(), 0); assert.equal(rejectedGoal.plans.length, 0);
  for (const h of rejectedGoal.handlers.get("session_shutdown") ?? []) await h({}, rejectedGoal.ctx);
  const blockedGoal = await goalFixture("ok", false);
  const deniedWait = await blockedGoal.run();
  assert.equal(deniedWait.terminate, false);
  assert.match(deniedWait.content[0].text, /strictExecutionContract/);
  assert.equal(blockedGoal.spawns(), 0); assert.equal(blockedGoal.wakes.length, 0);
  assert.equal(blockedGoal.goal.scheduler.phase, "running");
  for (const h of blockedGoal.handlers.get("session_shutdown") ?? []) await h({}, blockedGoal.ctx);
  for (const invalid of ["paused", "blocked", "budget_limited", "budget", "owner", "generation", "dispatch", "waiting", "goalId"]) {
    const g = await goalFixture();
    if (["paused", "blocked", "budget_limited"].includes(invalid)) g.goal.status = invalid;
    else if (invalid === "budget") g.goal.tokenBudget = 100;
    else if (invalid === "owner") g.goal.scheduler.owner = "other-session";
    else if (invalid === "generation") g.goal.scheduler.generation = "stale";
    else if (invalid === "dispatch") g.goal.scheduler.dispatch.id = "stale";
    else if (invalid === "waiting") g.goal.scheduler.phase = "waiting";
    else g.goal.id = "different-goal";
    assert.equal((await g.run()).terminate, false);
    assert.equal(g.spawns(), 0); assert.equal(g.plans.length, 0); assert.deepEqual(g.calls, ["get_goal"]);
    for (const h of g.handlers.get("session_shutdown") ?? []) await h({}, g.ctx);
  }
  for (const mode of ["ok", "reject", "unknown"] as const) {
    const g = await goalFixture(mode);
    g.onSpawn(() => {
      const schedule = g.entries.filter(e => e.customType === "taskmesh-orchestration").at(-1).data;
      assert.equal(schedule.goal.waitToken, "wait-token", "Wait mapping must be durable before emit/spawn");
      if (mode === "ok") g.bus.emit("subagent:async-complete", { runId: "owned-run", toolCallId: "rpc-spawn-" + schedule.requestId, state: "complete" });
    });
    const answer = await g.run();
    assert.equal(answer.terminate, true); assert.equal(g.spawns(), 1);
    assert.equal(g.wakes.length, mode === "unknown" ? 0 : 1);
    await g.run(); assert.equal(g.spawns(), 1, "Repeated checkpoint calls never start another run");
    if (mode === "ok") {
      g.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete" });
      assert.equal(g.wakes.length, 1);
    }
    for (const h of g.handlers.get("session_shutdown") ?? []) await h({}, g.ctx);
  }
  const reloadGoal = await goalFixture();
  await reloadGoal.run();
  assert.equal(reloadGoal.wakes.length, 0);
  for (const h of reloadGoal.handlers.get("session_start") ?? []) await h({}, reloadGoal.ctx);
  reloadGoal.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete" });
  assert.equal(reloadGoal.wakes.length, 1); assert.equal(reloadGoal.spawns(), 1);
  for (const h of reloadGoal.handlers.get("session_shutdown") ?? []) await h({}, reloadGoal.ctx);
  const nativeWakeGoal = await goalFixture();
  await nativeWakeGoal.run();
  nativeWakeGoal.bus.emit("subagent:async-complete", { runId: "owned-run", state: "complete", triggerTurn: true });
  assert.equal(nativeWakeGoal.wakes.length, 0, "Already accepted native completion must not queue an additional Goal turn");
  for (const h of nativeWakeGoal.handlers.get("session_shutdown") ?? []) await h({}, nativeWakeGoal.ctx);
  const changedGoal = await goalFixture();
  const previousExecute = changedGoal.ctx.executeTool;
  changedGoal.ctx.executeTool = async (name, input) => {
    const result = await previousExecute(name, input);
    await changedGoal.before({ prompt: "A new user turn" }, changedGoal.ctx);
    return result;
  };
  assert.equal((await changedGoal.run()).terminate, false);
  assert.deepEqual(changedGoal.calls, ["get_goal"]); assert.equal(changedGoal.plans.length, 0); assert.equal(changedGoal.spawns(), 0);
  for (const h of changedGoal.handlers.get("session_shutdown") ?? []) await h({}, changedGoal.ctx);
  const forgedGoal = await goalFixture();
  await forgedGoal.before({ messageType: "user", prompt: "pi-goal-event checkpoint" }, forgedGoal.ctx);
  assert.equal((await forgedGoal.run()).terminate, false);
  assert.equal(forgedGoal.calls.length, 0);
  assert.equal(forgedGoal.pi.getActiveTools().includes("taskmesh_goal"), false);
  for (const h of forgedGoal.handlers.get("session_shutdown") ?? []) await h({}, forgedGoal.ctx);

  const unknown = fixture("unknown");
  const uncertain = new AgentOrchestrator(unknown.pi, new JevClient(), true);
  uncertain.restore(unknown.ctx); uncertain.installCompletionNotice();
  const pending = await uncertain.dispatch("Fix this", unknown.ctx, true);
  assert.equal(pending.uncertain, true);
  assert.equal(unknown.spawns(), 1);
  assert.equal((await uncertain.dispatch("repeat", unknown.ctx, true)).busy, true);
  unknown.bus.emit("subagent:async-complete", { runId: "recovered-run", toolCallId: pending.runId, state: "complete" });
  assert.match(uncertain.explain(), /State: completed/);
  uncertain.dispose();

  const switched = fixture("reject");
  const switching = new AgentOrchestrator(switched.pi, new JevClient(), true);
  switching.restore(switched.ctx);
  switched.onSpawn(() => {
    const other = structuredClone(switched.entries.at(-1));
    other.data.requestId = "other-request"; other.data.runId = "other-session-run"; other.data.state = "running";
    switched.entries.splice(0, switched.entries.length, other);
    switching.restore(switched.ctx);
  });
  const oldLaunch = await switching.dispatch("Original session task", switched.ctx, true);
  assert.equal(oldLaunch.uncertain, true);
  assert.match(oldLaunch.runId!, /^rpc-spawn-/);
  assert.match(switching.explain(), /State: running \| Run: other-session-run/);
  switching.dispose();

  // Exercise the actual registered input hook: accepted/unknown consume the input;
  // pre-launch rejection and semantic solo leave it to the normal main agent.
  for (const mode of ["ok", "reject", "unknown", "no-executor"] as const) {
    const instance = fixture(mode);
    extension(instance.pi);
    for (const h of instance.handlers.get("session_start") ?? []) await h({}, instance.ctx);
    const input = instance.handlers.get("input")![0];
    team = false;
    assert.equal((await input({ source: "interactive", text: "你好" }, instance.ctx)).action, "continue");
    team = true;
    assert.equal((await input({ source: "extension", text: "内部通知" }, instance.ctx)).action, "continue");
    assert.equal((await input({ source: "interactive", text: "请重构", images: [{}] }, instance.ctx)).action, "continue");
    assert.equal((await input({ source: "interactive", text: "请重构", streamingBehavior: "steer" }, instance.ctx)).action, "continue");
    assert.equal((await input({ source: "interactive", text: "请重构这个项目，拆分实现并复核" }, instance.ctx)).action,
      mode === "reject" || mode === "no-executor" ? "continue" : "handled");
    assert.equal(instance.spawns(), mode === "no-executor" ? 0 : 1);
    if (mode === "ok") {
      await instance.command("schedule explain", instance.ctx);
      assert.match(instance.notices.at(-1)!, /pi task-fit/);
      await instance.command("schedule status", instance.ctx);
      assert.match(instance.notices.at(-1)!, /executor status/);
    }
    for (const h of instance.handlers.get("session_shutdown") ?? []) await h({}, instance.ctx);
    assert.ok([...instance.listeners].filter(([name]) => name === "subagent:async-complete" || name.startsWith("subagents:rpc:v1:reply:")).every(([, set]) => set.size === 0));
  }
  const sequential = taskBatches(validatePlan(rawPlan), 1);
  assert.deepEqual(sequential.map(batch => batch.map(task => task.id)), [["inspect"], ["research"], ["implement"], ["review"]]);
  assert.throws(() => taskBatches(plan, 0), /concurrency/);
  assert.throws(() => taskBatches(plan, 7), /concurrency/);
  const shared = new CapabilityRouter();
  const sharedCtx = { ...f.ctx, modelRegistry: { getAvailable: () => models.map(m => ({ ...m, provider: "magpie" })) } } as any;
  shared.record("magpie/quick", false, "HTTP 429 rate limit");
  assert.ok(shared.ranked(sharedCtx, "reasoning", 1000).some(m => m.id === "deep"), "One upstream failure must leave other gateway models available");
  assert.ok(shared.ranked(sharedCtx, "reasoning", 1000).every(m => m.id !== "quick"));

  const expired = fixture();
  const expiringRouter = new CapabilityRouter();
  const originalChoice = expired.ctx.modelRegistry.complete.bind(expired.ctx.modelRegistry);
  expired.ctx.modelRegistry.complete = (async (...args: any[]) => {
    const answer = await (originalChoice as any)(...args);
    expiringRouter.record("alpha/quick", false, "HTTP 429 rate limit");
    return answer;
  }) as any;
  const reassigned = validatePlan(rawPlan);
  await expiringRouter.assign(reassigned, recent, expired.ctx);
  assert.ok(reassigned.tasks[0].model !== "alpha/quick");
  assert.match(reassigned.tasks[0].modelReason!, /Metadata.*no longer eligible/);

  const reasoning = fixture();
  const attempted: string[] = [];
  const inferenceCtx = { ...reasoning.ctx, modelRegistry: { async complete(model: any) {
    attempted.push(model.provider);
    return { stopReason: "stop", content: [{ type: "text", text: attempted.length === 1 ? "not JSON" : JSON.stringify(rawPlan) }] };
  } } } as any;
  const inferred = await planTasks("Implement a fix", "", inferenceCtx, models as any, new AbortController().signal);
  assert.deepEqual(attempted, ["alpha", "beta"]);
  assert.equal(inferred.model.provider, "beta");
  attempted.length = 0;
  inferenceCtx.modelRegistry.complete = async (model: any) => {
    attempted.push(model.provider);
    throw new Error("upstream unavailable");
  };
  await assert.rejects(inferJson(inferenceCtx, models as any, "JSON only", {}, value => value, new AbortController().signal), /upstream unavailable/);
  assert.deepEqual(attempted, ["alpha", "beta"], "Pure inference retries at most one alternate; no third request");
  const cancelled = new AbortController(); cancelled.abort(new Error("cancelled before inference"));
  await assert.rejects(inferJson(inferenceCtx, models as any, "JSON", {}, value => value, cancelled.signal), /cancelled before/);
  assert.equal(attempted.length, 2);

  const refusal = fixture();
  const refusing = new AgentOrchestrator(refusal.pi, new JevClient(), true);
  refusing.restore(refusal.ctx);
  for (const task of ["请重构但不要使用子代理", "这项任务不用子代理", "Refactor this; do not use subagents", "Do not use any subagents", "Work without using child agents"]) {
    assert.equal((await refusing.assessDetailed(task, refusal.ctx)).kind, "solo");
    assert.equal((await refusing.dispatch(task, refusal.ctx)).accepted, false);
  }
  assert.equal(refusal.plans.length, 0);
  assert.equal(refusal.requests.length, 0);
  decisionKind = "resume";
  assert.equal((await refusing.assessDetailed("继续", refusal.ctx)).kind, "solo");
  decisionKind = undefined;
  refusing.dispose();

  const changing = fixture();
  const changed = new AgentOrchestrator(changing.pi, new JevClient(), true);
  changed.restore(changing.ctx);
  const complete = changing.ctx.modelRegistry.complete.bind(changing.ctx.modelRegistry);
  changing.ctx.modelRegistry.complete = (async (...args: any[]) => {
    changed.restore(changing.ctx);
    return (complete as any)(...args);
  }) as any;
  assert.equal((await changed.assessDetailed("请拆分实现", changing.ctx)).kind, "uncertain");
  assert.equal(changed.lastDecision, undefined, "Old decision must not overwrite a fresh session");
  changed.dispose();

  const branch = fixture(); extension(branch.pi);
  for (const handler of branch.handlers.get("session_start") ?? []) await handler({}, branch.ctx);
  branch.onSpawn(() => {
    branch.entries.length = 0;
    for (const handler of branch.handlers.get("session_tree") ?? []) handler({ newLeafId: "new-branch", oldLeafId: "old-branch" }, branch.ctx);
  });
  await branch.taskmesh("run Work in the old branch", branch.ctx);
  await branch.taskmesh("explain", branch.ctx);
  assert.match(branch.notices.at(-1)!, /No TaskMesh schedule/, "Tree navigation must invalidate late launch replies too");
  assert.equal(branch.entries.length, 0, "Old launch state must not be appended to the new branch");
  assert.equal(branch.spawns(), 1);
  for (const handler of branch.handlers.get("session_shutdown") ?? []) await handler({}, branch.ctx);

  const legacy = fixture();
  legacy.entries.push({ type: "custom", customType: "jev-orchestration", data: { task: "Old task", cwd: root,
    plan, plannerModel: "beta/deep", state: "unknown", requestId: "legacy-request", runId: "legacy-run" } });
  const migrated = new AgentOrchestrator(legacy.pi, undefined, true);
  migrated.restore(legacy.ctx);
  assert.match(migrated.explain(), /legacy-run/);
  assert.equal((await migrated.dispatch("Do not replay old work", legacy.ctx)).busy, true);
  assert.match(await migrated.resume(legacy.ctx), /No task was restarted/);
  assert.equal(legacy.spawns(), 0);
  migrated.dispose();

  // Old Jev agent settings and environment do not authorize the new core.
  const settings = new TaskMeshSettings();
  rmSync(settings.path);
  process.env.PI_TASKMESH = "on";
  const envOn = fixture(); extension(envOn.pi);
  assert.equal(envOn.pi.getFlag("taskmesh"), true, "Environment on enables the core without a saved config");
  for (const handler of envOn.handlers.get("session_shutdown") ?? []) await handler({}, envOn.ctx);
  delete process.env.PI_TASKMESH;
  process.env.PI_JEV_AGENTS = "on";
  const opt = fixture(); extension(opt.pi);
  for (const handler of opt.handlers.get("session_start") ?? []) await handler({}, opt.ctx);
  const optInput = opt.handlers.get("input")![0];
  assert.equal((await optInput({ source: "interactive", text: "重构整个项目" }, opt.ctx)).action, "continue");
  for (const handler of opt.handlers.get("before_agent_start") ?? []) await handler({ prompt: "A direct solo question" }, opt.ctx);
  assert.equal(jevCalls, 0, "A configured key alone must not activate the disabled Jev hook");
  assert.equal(opt.plans.length, 0, "Disabled automatic delegation must not make a judgment request");
  delete process.env.PI_JEV_AGENTS;
  await opt.taskmesh("on", opt.ctx);
  assert.equal(new TaskMeshSettings().value.enabled, true);
  process.env.PI_TASKMESH = "off";
  const envOff = fixture(); extension(envOff.pi);
  assert.equal(envOff.pi.getFlag("taskmesh"), false, "Environment off overrides the saved opt-in");
  for (const handler of envOff.handlers.get("session_shutdown") ?? []) await handler({}, envOff.ctx);
  delete process.env.PI_TASKMESH;
  // Remove the Jev key too: automatic task decisions, planning and routing still work.
  writeFileSync(join(root, "jev.json"), JSON.stringify({ features: { auto: false } }));
  assert.equal((await optInput({ source: "interactive", text: "请跨模块重构并验证" }, opt.ctx)).action, "handled");
  assert.equal(opt.spawns(), 1);
  await opt.taskmesh("resume", opt.ctx);
  for (const kind of ["team", "resume", "uncertain"] as const) {
    decisionKind = kind;
    assert.equal((await optInput({ source: "interactive", text: "继续已有任务" }, opt.ctx)).action, "handled");
  }
  decisionKind = undefined;
  assert.equal(opt.spawns(), 1, "Continue/resume and uncertain status cannot create another workflow");
  await opt.taskmesh("off", opt.ctx);
  assert.equal(new TaskMeshSettings().value.enabled, false);
  await opt.taskmesh("run overlapping task", opt.ctx);
  assert.match(opt.notices.at(-1)!, /already active/);
  assert.equal(opt.spawns(), 1);
  for (const handler of opt.handlers.get("session_shutdown") ?? []) await handler({}, opt.ctx);

  const explicit = fixture(); extension(explicit.pi);
  for (const handler of explicit.handlers.get("session_start") ?? []) await handler({}, explicit.ctx);
  await explicit.taskmesh("run Single authorized task", explicit.ctx);
  assert.equal(explicit.spawns(), 1, "Explicit run works with automatic mode off and no Jev key");
  for (const handler of explicit.handlers.get("session_shutdown") ?? []) await handler({}, explicit.ctx);

  assert.equal(jevCalls, 0, "Default Pi backend must not invoke Jev even when a key exists");

  // Switch the real command and input hook without reloading; all calls remain local fakes.
  const backendSettings = new TaskMeshSettings();
  writeFileSync(backendSettings.path, JSON.stringify({ enabled: false, decisionBackend: "pi", maxConcurrency: 2, keep: 42 }));
  writeFileSync(join(root, "jev.json"), JSON.stringify({ typesafe: { apiKey: "offline-fixture" } }));
  process.env.PI_TASKMESH = "on";
  const backend = fixture(); extension(backend.pi);
  for (const handler of backend.handlers.get("session_start") ?? []) await handler({}, backend.ctx);
  const completeBackend = backend.completions.get("taskmesh")!;
  assert.deepEqual(completeBackend("back").map((item: any) => item.value), ["backend"]);
  assert.deepEqual(completeBackend("backend ").map((item: any) => item.value), ["backend pi", "backend jev"]);
  assert.deepEqual(completeBackend("backend j").map((item: any) => item.value), ["backend jev"]);
  assert.deepEqual(completeBackend("concurrency a").map((item: any) => item.value), ["concurrency auto"]);
  const savedConcurrency = readFileSync(backendSettings.path, "utf8");
  await backend.taskmesh("concurrency", backend.ctx);
  assert.equal(readFileSync(backendSettings.path, "utf8"), savedConcurrency);
  for (const value of ["0", "7", "1.5", "2 extra", "off"]) {
    await backend.taskmesh("concurrency " + value, backend.ctx);
    assert.match(backend.notices.at(-1)!, /Usage:.*concurrency/);
    assert.equal(readFileSync(backendSettings.path, "utf8"), savedConcurrency);
  }
  for (const value of ["auto", "6", "2"]) {
    await backend.taskmesh("concurrency " + value, backend.ctx);
    assert.equal(new TaskMeshSettings().value.maxConcurrency, value === "auto" ? "auto" : Number(value));
    assert.equal(new TaskMeshSettings().value.enabled, false);
    assert.equal(JSON.parse(readFileSync(backendSettings.path, "utf8")).keep, 42);
  }
  const beforeQuery = readFileSync(backendSettings.path, "utf8");
  await backend.taskmesh("backend", backend.ctx);
  assert.match(backend.notices.at(-1)!, /Decision backend: pi/);
  assert.equal(readFileSync(backendSettings.path, "utf8"), beforeQuery);
  for (const argument of ["off", "other", "pi extra"]) {
    await backend.taskmesh("backend " + argument, backend.ctx);
    assert.match(backend.notices.at(-1)!, /Usage:.*backend/);
    assert.equal(readFileSync(backendSettings.path, "utf8"), beforeQuery);
  }
  await backend.taskmesh("backend jev", backend.ctx);
  assert.deepEqual(JSON.parse(readFileSync(backendSettings.path, "utf8")), { enabled: false, decisionBackend: "jev", maxConcurrency: 2, keep: 42 });
  await backend.taskmesh("backend", backend.ctx);
  assert.match(backend.notices.at(-1)!, /on \(user opt-in\)/, "Backend changes must preserve the environment-enabled session");
  assert.equal(jevCalls, 0, "Querying or switching backend must not make a paid judgment");
  assert.equal(backend.plans.length, 0);
  assert.equal(backend.requests.length, 0);
  const backendInput = backend.handlers.get("input")![0];
  team = false;
  assert.equal((await backendInput({ source: "interactive", text: "A simple question" }, backend.ctx)).action, "continue");
  assert.equal(jevCalls, 1, "The next judgment must immediately use Jev");
  assert.equal(backend.plans.length, 0);
  await backend.taskmesh("backend pi", backend.ctx);
  assert.equal((await backendInput({ source: "interactive", text: "Another question" }, backend.ctx)).action, "continue");
  assert.equal(jevCalls, 1, "Switching back to Pi must stop Jev judgments");
  assert.equal(backend.plans.length, 1);
  const beforeFailure = readFileSync(backendSettings.path, "utf8");
  writeFileSync(backendSettings.path, "invalid JSON");
  await backend.taskmesh("concurrency auto", backend.ctx);
  assert.match(backend.notices.at(-1)!, /global save failed/);
  await backend.taskmesh("concurrency", backend.ctx);
  assert.match(backend.notices.at(-1)!, /Readers: 2/);
  await backend.taskmesh("backend jev", backend.ctx);
  assert.match(backend.notices.at(-1)!, /global save failed/);
  await backend.taskmesh("backend", backend.ctx);
  assert.match(backend.notices.at(-1)!, /Decision backend: pi/);
  assert.equal(readFileSync(backendSettings.path, "utf8"), "invalid JSON");
  writeFileSync(backendSettings.path, beforeFailure);
  team = true;
  assert.equal((await backendInput({ source: "interactive", text: "Refactor and review the parser" }, backend.ctx)).action, "handled");
  await backend.taskmesh("backend jev", backend.ctx);
  await backend.taskmesh("explain", backend.ctx);
  assert.match(backend.notices.at(-1)!, /State: running \| Run: owned-run/);
  assert.equal(backend.spawns(), 1, "Switching backend must not restart an active run");
  const retainedScript = backend.requests.find((r: any) => r.method === "spawn").params.script;
  await backend.taskmesh("concurrency auto", backend.ctx);
  assert.equal(backend.spawns(), 1);
  assert.equal(backend.requests.find((r: any) => r.method === "spawn").params.script, retainedScript);
  for (const handler of backend.handlers.get("session_shutdown") ?? []) await handler({}, backend.ctx);
  new TaskMeshSettings().save({ enabled: true });
  process.env.PI_TASKMESH = "off";
  const backendOff = fixture(); extension(backendOff.pi);
  await backendOff.taskmesh("backend pi", backendOff.ctx);
  await backendOff.taskmesh("backend", backendOff.ctx);
  assert.match(backendOff.notices.at(-1)!, /off \(explicit run only\)/, "Backend changes must preserve the environment-disabled session");
  assert.equal(new TaskMeshSettings().value.enabled, true, "Backend selection must preserve the saved opt-in");
  for (const handler of backendOff.handlers.get("session_shutdown") ?? []) await handler({}, backendOff.ctx);
  delete process.env.PI_TASKMESH;

  // Goal dispatch uses the same per-node Jev routing, without replacing the main model.
  new TaskMeshSettings().save({ enabled: true, decisionBackend: "jev", maxConcurrency: "auto" });
  const mixedGoal = await goalFixture();
  mixedGoal.goal.currentTaskId = "parser";
  mixedGoal.goal.taskList = { tasks: [{ id: "baseline", status: "complete", evidence: "frozen report" }, { id: "parser", status: "pending" }] };
  const preservedProgress = structuredClone(mixedGoal.goal.taskList);
  const judgmentsBefore = jevCalls;
  assert.equal((await mixedGoal.run()).terminate, true);
  assert.equal(jevCalls - judgmentsBefore, 2, "One assessment and one batched model choice");
  const goalSchedule = mixedGoal.entries.filter(e => e.customType === "taskmesh-orchestration").at(-1).data;
  assert.equal(goalSchedule.goal.goalId, mixedGoal.goal.id);
  assert.deepEqual(goalSchedule.plan.tasks.map((t: any) => t.model), ["alpha/quick", "alpha/quick", "beta/deep", "gamma/deep"]);
  assert.deepEqual(mixedGoal.goal.taskList, preservedProgress);
  const goalModels: string[] = [];
  const goalScript = mixedGoal.requests.find((r: any) => r.method === "spawn").params.script;
  await new AsyncFunction("runs", goalScript)({ async run(_id: string, params: any) {
    goalModels.push(params.model);
    return { ok: true, output: "owned Goal test evidence" };
  } });
  assert.deepEqual(goalModels, ["alpha/quick", "alpha/quick", "beta/deep", "gamma/deep"]);
  console.log("PASS: Goal checkpoint -> actual TaskMesh -> batched fake Jev -> distinct per-node models; progress preserved, no live models or children.");
  for (const h of mixedGoal.handlers.get("session_shutdown") ?? []) await h({}, mixedGoal.ctx);

  const configured = new TaskMeshSettings();
  writeFileSync(configured.path, JSON.stringify({ enabled: true, keep: 42 }));
  configured.save({ maxConcurrency: 1 });
  assert.equal(JSON.parse(readFileSync(configured.path, "utf8")).keep, 42);
  assert.equal(new TaskMeshSettings().value.maxConcurrency, 1);
  for (const value of [0, 7, 1.5, "6", "AUTO", null]) assert.throws(() => configured.save({ maxConcurrency: value as any }), /Invalid taskmesh/);
  writeFileSync(configured.path, "invalid JSON");
  assert.equal(new TaskMeshSettings().value.enabled, false);
  assert.ok(new TaskMeshSettings().error);
  assert.throws(() => configured.save({ enabled: true }));
  console.log("PASS: Pi decisions without Jev, scoped per-node models, bounded inference fallback, DAG dependencies, exclusive writers, review, correlated RPC, unknown launch fuse, session isolation and commands (offline).");
} finally {
  JevClient.prototype.evaluate = originalEvaluate;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  rmSync(root, { recursive: true, force: true });
}
