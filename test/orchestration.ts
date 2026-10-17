import assert from "node:assert/strict";
import ts from "typescript";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import { JevClient } from "../src/jev.js";
import { CapabilityRouter } from "../src/capability-router.js";
import { AgentOrchestrator, buildWorkflowScript } from "../src/orchestrator.js";
import { conversationContext, taskBatches, validatePlan } from "../src/task-planner.js";

// Model responses, Jev and executor transport are local fakes; no real credentials or children.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const root = mkdtempSync(join(tmpdir(), "jev-orchestration-"));
const env = { ...process.env };
for (const key of Object.keys(process.env)) if (/^(JEV_|PI_JEV_|TYPESAFE_|AI_GATEWAY_API_KEY$)/.test(key)) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "jev.json"), JSON.stringify({ typesafe: { apiKey: "offline-fixture" }, features: { auto: true, autoAgents: true } }));
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
JevClient.prototype.evaluate = async function(request: any): Promise<any> {
  const answers: any = {};
  if (request.questions.delegation) answers.delegation = { value: team ? "team" : "solo" };
  else for (const [key, question] of Object.entries(request.questions) as [string, any][]) {
    const index = Number(key.slice(5));
    const desired = index < 2 ? "alpha/quick" : index === 2 ? "beta/deep" : "gamma/deep";
    answers[key] = { value: Object.keys(question.criteria).find(k => JSON.parse(question.criteria[k]).id === desired) ?? "unknown" };
  }
  return { answers };
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
  let command: Function;
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
    registerCommand(_name: string, options: any) { command = options.handler; },
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
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(rawPlan) }] };
      },
    },
    ui: { notify(text: string) { notices.push(text); }, setStatus() {} },
  } as unknown as ExtensionContext;
  return { pi, ctx, bus, entries, requests, notices, handlers, plans, listeners, controller, onSpawn: (callback: () => void) => { onSpawn = callback; }, spawns: () => spawns, command: (...args: any[]) => command(...args) };
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
  await router.assign(plan, recent, f.ctx, new JevClient());
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
      assert.match(instance.notices.at(-1)!, /Jev task-fit/);
      await instance.command("schedule status", instance.ctx);
      assert.match(instance.notices.at(-1)!, /executor status/);
    }
    for (const h of instance.handlers.get("session_shutdown") ?? []) await h({}, instance.ctx);
    assert.ok([...instance.listeners].filter(([name]) => name === "subagent:async-complete" || name.startsWith("subagents:rpc:v1:reply:")).every(([, set]) => set.size === 0));
  }
  console.log("PASS: Chinese semantic delegation, per-node models/scopes, DAG dependencies, exclusive writers, independent review, RPC correlation, unknown launch fuse, completion ownership and schedule diagnostics (offline).");
} finally {
  JevClient.prototype.evaluate = originalEvaluate;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  rmSync(root, { recursive: true, force: true });
}
