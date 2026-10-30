import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import extension from "../.test-build/extensions/index.js";
import { AgentOrchestrator } from "../.test-build/src/orchestrator.js";

// Optional installed-host contract test. Private settings/store, real scheduler/runtime, no models or children.
const goalRoot = resolve(process.argv[2] || process.env.PI_GOAL_DIR || join(homedir(), ".pi/agent/npm/node_modules/pi-goal-x"));
const goalURL = pathToFileURL(goalRoot + "/").href;
const root = mkdtempSync(join(tmpdir(), "taskmesh-native-goal-"));
const env = { ...process.env };
const originalFetch = globalThis.fetch;
const agentMethods = Object.getOwnPropertyDescriptors(AgentOrchestrator.prototype);
const schedulers = [];
const runtimes = [];
const goals = [];
const progress = { currentTaskId: "replay", usage: { tokensUsed: 3000000, activeSeconds: 2400 },
  taskList: { tasks: [{ id: "baseline", title: "Baseline", status: "complete", evidence: "Existing baseline report" },
    { id: "replay", title: "Replay", status: "pending" }], blockCompletion: true, proposedAt: "2026-10-18T01:00:00.000Z" } };
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // The bundled host supplies these peers; standalone Node uses the checked-out dev peers.
    if (specifier.startsWith("@earendil-works/pi-") && context.parentURL?.startsWith(goalURL)) return next(specifier, { ...context, parentURL: import.meta.url });
    return next(specifier, context);
  },
  load(url, context, next) {
  if (url.startsWith(goalURL) && url.endsWith(".ts")) return { format: "module", shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  return next(url, context);
} });
globalThis.fetch = async () => { throw new Error("Unexpected network request in native Goal contract test"); };
for (const key of Object.keys(process.env)) if (key.startsWith("PI_GOAL_") || /^(JEV_|PI_JEV_|PI_TASKMESH$|TYPESAFE_|AI_GATEWAY_API_KEY$)/.test(key)) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_TASKMESH = "1";
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = join(root, "global.json");
process.env.PI_GOAL_SETTINGS_FILE = join(root, "project.json");
writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE, "{}");
try {
  const [{ GoalScheduler }, { GoalRuntime }, { createGoal }, { newGoalScheduler }, { goalDetails }, { invalidateGoalSettingsCache }] = await Promise.all(
    ["goal-scheduler", "goal-runtime", "goal-record", "goal-scheduler-state", "goal-format", "goal-settings"].map(name => import(goalURL + "extensions/" + name + ".ts")));
  async function fixture(strict, early = false) {
    writeFileSync(process.env.PI_GOAL_SETTINGS_FILE, JSON.stringify({ strictExecutionContract: strict, maxAutonomousRuns: 5 }));
    invalidateGoalSettingsCache();
    const listeners = new Map(); const tools = new Map(); const delivered = []; const entries = [];
    const handlers = new Map(); const flags = new Map();
    const pi = { registerTool(t) { tools.set(t.name, t); }, registerCommand() {},
      registerFlag(name, options) { flags.set(name, options.default); }, getFlag: name => flags.get(name),
      getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [],
      on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, events: {
      on(name, fn) { const list = listeners.get(name) ?? new Set(); list.add(fn); listeners.set(name, list); return () => list.delete(fn); },
      emit(name, event) { for (const fn of listeners.get(name) ?? []) fn(event); },
    } };
    const ctx = { cwd: root, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "native-fixture" }, ui: { notify() {} } };
    const core = { pi, state: { goal: { ...createGoal({ objective: "Implement and verify the remaining parser work" }), autoContinue: true, ...structuredClone(progress),
      scheduler: { ...newGoalScheduler("native-fixture"), used: 3, phase: "ready", decision: { kind: "ready", purpose: "kickoff" } } } },
      updateUI() {}, reconcileFocusedGoalFromDisk() {}, clearActiveAccounting() {},
      interruption: { isHeld: () => false, resumed() {} },
      goalService: { flushForAudit() {}, isTurnBuffered: () => false, apply(_ctx, { expectedGoalId, mutate }) {
        assert.equal(expectedGoalId, core.state.goal.id);
        core.state.goal = mutate(structuredClone(core.state.goal));
        entries.push(structuredClone(core.state.goal));
        return { ok: true, goal: core.state.goal };
      } },
    };
    goals.push({ core, id: core.state.goal.id, createdAt: core.state.goal.createdAt });
    const scheduler = new GoalScheduler(core); schedulers.push(scheduler);
    const runtime = new GoalRuntime({ getGoal: () => core.state.goal,
      isActionable: id => core.state.goal.id === id && core.state.goal.status === "active" && core.state.goal.autoContinue,
      authorize: () => scheduler.claim(ctx), sendFollowUp(content, details) { delivered.push({ content, details }); },
    }); runtimes.push(runtime); core.runtime = runtime;
    ctx.executeTool = async (name, input) => ({ isError: false,
      result: name === "get_goal" ? { details: goalDetails(core.state.goal) }
        : (assert.equal(name, "update_goal"), scheduler.declare(ctx, input.continuation)) });
    let spawns = 0; let lease;
    const agents = { enabled: true, hasActive: () => false,
      goalSchedule: () => lease ? "Retained native workflow; read its existing results" : undefined,
      summary: () => "Native workflow retained", assessDetailed: async () => ({ kind: "team" }),
      async dispatch(_task, _ctx, automatic, beforeSpawn) {
        assert.equal(automatic, true);
        try { lease = await beforeSpawn(); } catch (error) { return { accepted: false, error: String(error) }; }
        assert.equal(core.state.goal.scheduler.wait.token, lease.waitToken);
        spawns++;
        if (early) pi.events.emit("pi-goal:wake", { goalId: lease.goalId, waitToken: lease.waitToken });
        return { accepted: true };
      },
    };
    for (const name of ["hasActive", "goalSchedule", "summary", "assessDetailed", "dispatch"]) AgentOrchestrator.prototype[name] = agents[name];
    extension(pi);
    scheduler.attach(ctx); scheduler.schedule(ctx);
    async function nextCheckpoint() {
      const deadline = Date.now() + 2000;
      while (!delivered.length && Date.now() < deadline) await new Promise(setImmediate);
      assert.ok(delivered.length, "Native runtime must deliver a bounded checkpoint");
      const message = { role: "custom", customType: "pi-goal-event", ...delivered.shift() };
      const admitted = structuredClone(core.state.goal.scheduler);
      const event = { messageType: "custom", message };
      const injections = [];
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await handler(event, ctx);
        if (result?.message) injections.push({ role: "custom", ...result.message });
      }
      scheduler.begin(ctx); scheduler.message(ctx, message);
      for (const injected of injections) scheduler.message(ctx, injected);
      assert.equal(core.state.goal.scheduler.phase, "running", "TaskMesh guidance must not take over the native checkpoint");
      assert.equal(core.state.goal.scheduler.generation, admitted.generation);
      assert.deepEqual(core.state.goal.scheduler.dispatch, admitted.dispatch);
      assert.equal(core.state.goal.scheduler.used, admitted.used);
      return message;
    }
    await nextCheckpoint();
    return { core, ctx, scheduler, runtime, pi, tools, nextCheckpoint, delivered, agents,
      run: () => tools.get("taskmesh_goal").execute("native-goal-call", {}, undefined, undefined, ctx),
      get lease() { return lease; }, spawns: () => spawns };
  }
  const declined = await fixture(false);
  const defaultResult = await declined.run();
  assert.equal(defaultResult.terminate, false); assert.equal(declined.spawns(), 0);
  assert.match(defaultResult.content[0].text, /strictExecutionContract/);
  assert.equal(declined.core.state.goal.scheduler.phase, "running");
  declined.scheduler.shutdown(); declined.runtime.clearContinuationState();

  for (const early of [false, true]) {
    const f = await fixture(true, early);
    const result = await f.run();
    assert.equal(result.terminate, true); assert.equal(f.spawns(), 1);
    assert.equal(f.core.state.goal.scheduler.phase, "waiting");
    f.scheduler.settled(f.ctx, true);
    if (!early) {
      f.pi.events.emit("pi-goal:wake", { goalId: f.lease.goalId, waitToken: "wrong-token" });
      assert.equal(f.core.state.goal.scheduler.wait.signalled, undefined, "Wrong token must not mutate the native wait");
      f.pi.events.emit("pi-goal:wake", { goalId: f.lease.goalId, waitToken: f.lease.waitToken });
    }
    await f.nextCheckpoint();
    assert.equal(f.core.state.goal.scheduler.dispatch.kind, "wake");
    assert.equal(f.core.state.goal.scheduler.used, 5);
    assert.equal((await f.run()).terminate, false);
    assert.equal(f.spawns(), 1, "A resumed checkpoint must reuse its retained workflow");
    f.scheduler.shutdown(); f.runtime.clearContinuationState();
  }
  const native = await fixture(true);
  await native.run(); native.scheduler.settled(native.ctx, true);
  native.scheduler.message(native.ctx, { role: "custom", customType: "subagent-notify", content: "Saved results" });
  assert.equal(native.core.state.goal.scheduler.phase, "idle");
  assert.equal(native.core.state.goal.scheduler.wait, undefined);
  assert.equal(native.core.state.goal.scheduler.used, 4, "Accepted native completion must not claim a duplicate Goal wake");
  native.scheduler.shutdown(); native.runtime.clearContinuationState();

  for (const message of [{ role: "user", content: "New user work" }, { role: "custom", customType: "unrelated-work", content: "New extension work" }]) {
    const superseded = await fixture(true);
    superseded.scheduler.message(superseded.ctx, message);
    const result = await superseded.run();
    assert.equal(result.terminate, false); assert.equal(superseded.spawns(), 0);
    assert.match(result.content[0].text, /Goal checkpoint is stale/);
    assert.equal(superseded.core.state.goal.scheduler.phase, "idle");
    assert.equal(superseded.core.state.goal.scheduler.used, 4);
    superseded.scheduler.shutdown(); superseded.runtime.clearContinuationState();
  }

  const finite = await fixture(true);
  finite.core.state.goal.tokenBudget = 1000;
  assert.equal((await finite.run()).terminate, false); assert.equal(finite.spawns(), 0);
  assert.equal(finite.core.state.goal.scheduler.phase, "running");
  finite.scheduler.shutdown(); finite.runtime.clearContinuationState();

  const exhausted = await fixture(true);
  exhausted.core.state.goal.scheduler.used = 5;
  assert.equal((await exhausted.run()).terminate, false); assert.equal(exhausted.spawns(), 0);
  assert.equal(exhausted.core.state.goal.scheduler.phase, "running");
  assert.equal(exhausted.core.state.goal.scheduler.used, 5);
  exhausted.scheduler.shutdown(); exhausted.runtime.clearContinuationState();
  for (const { core, id, createdAt } of goals) {
    assert.equal(core.state.goal.id, id); assert.equal(core.state.goal.createdAt, createdAt);
    assert.equal(core.state.goal.currentTaskId, progress.currentTaskId);
    assert.deepEqual(core.state.goal.usage, progress.usage);
    assert.deepEqual(core.state.goal.taskList, progress.taskList);
  }
  console.log("PASS: production TaskMesh startup/message lifecycle preserves the native checkpoint and Goal progress/usage/focus; installed Goal scheduler/runtime, default wait refusal, strict wait + terminate, early/late token wake, wrong token, genuine user/custom takeover, retained workflow and budget/allowance refusal; synthetic store, zero models/children.");
} finally {
  for (const scheduler of schedulers) scheduler.shutdown();
  for (const runtime of runtimes) runtime.clearContinuationState();
  Object.defineProperties(AgentOrchestrator.prototype, agentMethods);
  hooks.deregister(); globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env); rmSync(root, { recursive: true, force: true });
}
