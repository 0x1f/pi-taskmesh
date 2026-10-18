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
  const commands = new Map<string, Function>();
  const bus = {
    on(name: string, handler: Function) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => { set.delete(handler); }; },
    emit(name: string, data: any) {
      for (const handler of listeners.get(name) ?? []) handler(data);
      if (name !== "subagents:rpc:v1:request") return;
      requests.push(data);
      if (mode === "no-executor") { controller.abort(); return; }
      let payload: any = data.method === "ping" ? { capabilities: { asyncSpawn: true } } : { fleet: { entries: [] }, asyncSnapshot: { runs: [] }, text: "executor status" };
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
    registerTool() {},
    registerCommand(name: string, options: any) { commands.set(name, options.handler); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getActiveTools() { return ["read"]; }, setActiveTools() {}, getAllTools() { return [{ name: "read" }]; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, signal: controller.signal, scopedModels: [], isIdle: () => true,
    sessionManager: { getBranch: () => entries },
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
  return { pi, ctx, bus, entries, requests, notices, handlers, plans, listeners, controller, onSpawn: (callback: () => void) => { onSpawn = callback; }, spawns: () => spawns, command: (...args: any[]) => commands.get("jev")!(...args), taskmesh: (...args: any[]) => commands.get("taskmesh")!(...args) };
}

try {
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
  assert.throws(() => taskBatches(plan, 4), /concurrency/);
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

  const configured = new TaskMeshSettings();
  writeFileSync(configured.path, JSON.stringify({ enabled: true, keep: 42 }));
  configured.save({ maxConcurrency: 1 });
  assert.equal(JSON.parse(readFileSync(configured.path, "utf8")).keep, 42);
  assert.equal(new TaskMeshSettings().value.maxConcurrency, 1);
  assert.throws(() => configured.save({ maxConcurrency: 4 }), /Invalid taskmesh/);
  writeFileSync(configured.path, "invalid JSON");
  assert.equal(new TaskMeshSettings().value.enabled, false);
  assert.ok(new TaskMeshSettings().error);
  assert.throws(() => configured.save({ enabled: true }));
  assert.equal(jevCalls, 0, "Default Pi backend must not invoke Jev even when a key exists");
  console.log("PASS: Pi decisions without Jev, scoped per-node models, bounded inference fallback, DAG dependencies, exclusive writers, review, correlated RPC, unknown launch fuse, session isolation and commands (offline).");
} finally {
  JevClient.prototype.evaluate = originalEvaluate;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  rmSync(root, { recursive: true, force: true });
}
