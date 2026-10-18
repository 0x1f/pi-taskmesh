import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWorkflowScript } from "../.test-build/src/orchestrator.js";
import { validatePlan } from "../.test-build/src/task-planner.js";

const executor = resolve(process.argv[2] || process.env.PI_SUBAGENTS_DIR || join(homedir(), ".pi/agent/npm/node_modules/pi-subagents"));
const { validateWorkflowScript, runWorkflowScript } = await import(pathToFileURL(join(executor, "src/workflows/scripted-workflow.js")).href);
globalThis.fetch = async () => { throw new Error("Unexpected network request in native contract test"); };
const plan = validatePlan({ reason: "Independent inspection, one writer and review", tasks: [
  ...["a", "b", "c"].map(id => ({ id, agent: "scout", task: "Inspect " + id, dependsOn: [], profile: "fast", contextTokens: 12000 })),
  { id: "fix", agent: "worker", task: "Apply the fix and verify", dependsOn: ["a", "b", "c"], profile: "reasoning", contextTokens: 20000 },
  { id: "review", agent: "reviewer", task: "Review the resulting diff and evidence", dependsOn: ["fix"], profile: "reasoning", contextTokens: 20000 },
] });
for (const task of plan.tasks) task.model = task.writes ? "writer/model" : "reader/model";
const script = buildWorkflowScript("Quoted goal: \u0060 \u0024{globalThis.INJECTED = true}", plan, "Frozen goal context", 2);
const validation = validateWorkflowScript(script);
assert.equal(validation.ok, true, JSON.stringify(validation.errors));
const bad = validateWorkflowScript("const nested = async () => runs.run('bad', {agent:'scout',task:'read'}); return await nested();");
assert.equal(bad.ok, false);
assert.match(bad.errors.map(error => error.message).join("\n"), /nested async/i);

let active = 0;
let maximum = 0;
const calls = [];
let releaseReaders;
const readersReady = new Promise(resolve => { releaseReaders = resolve; });
const result = await runWorkflowScript({
  script, timeoutMs: 10000,
  async launch(key, params, signal) {
    assert.equal(signal.aborted, false);
    active++; maximum = Math.max(maximum, active);
    calls.push(key);
    assert.equal(params.context, "fresh");
    assert.ok(params.label.length > 0);
    assert.equal(params.model, key === "fix" ? "writer/model" : "reader/model");
    assert.match(params.task, /Frozen goal context/);
    assert.match(params.task, /Do not delegate further or replay failed work/);
    if (key !== "fix") assert.match(params.task, /Read-only task/);
    if (key === "fix") {
      assert.equal(active, 1);
      for (const dependency of ["a", "b", "c"]) assert.ok(params.task.includes(dependency + ": evidence-" + dependency));
    }
    if (key === "review") { assert.equal(active, 1); assert.match(params.task, /fix: evidence-fix/); }
    if (key === "a" || key === "b") { if (active === 2) releaseReaders(); await readersReady; }
    active--;
    return { key, ok: true, output: "evidence-" + key, artifactPaths: [] };
  },
  async status() { throw new Error("Unexpected status polling"); },
});
assert.equal(maximum, 2);
assert.deepEqual(calls, ["a", "b", "c", "fix", "review"]);
assert.deepEqual(Object.keys(result.value), calls);
assert.equal(globalThis.INJECTED, undefined);
let failedCalls = 0;
await assert.rejects(runWorkflowScript({
  script, timeoutMs: 10000,
  async launch(key) { failedCalls++; return { key, ok: false, output: "Owned failure", artifactPaths: [] }; },
  async status() { throw new Error("Unexpected status polling"); },
}), error => {
  assert.match(error.message, /Owned failure/);
  assert.equal(error.errorKind, "child");
  assert.ok(error.partial.children.every(child => ["a", "b"].includes(child.key)));
  return true;
});
assert.equal(failedCalls, 2);
const widePlan = validatePlan({ reason: "All independent readers", tasks: Array.from({ length: 6 }, (_, i) => ({
  id: "read_" + i, agent: "scout", task: "Inspect area " + i, dependsOn: [], profile: "fast", contextTokens: 1000,
})) });
for (const task of widePlan.tasks) task.model = "reader/" + task.id;
const mixedPlan = validatePlan({ reason: "Four readers, writer, reviewer", tasks: [
  ...widePlan.tasks.slice(0, 4),
  { id: "write", agent: "worker", task: "Apply minimal fix", dependsOn: widePlan.tasks.slice(0, 4).map(t => t.id), profile: "reasoning", contextTokens: 1000 },
  { id: "review", agent: "reviewer", task: "Verify", dependsOn: ["write"], profile: "reasoning", contextTokens: 1000 },
] });
for (const task of mixedPlan.tasks) task.model = task.agent + "/" + task.id;
for (const [autoPlan, expectedPeak, globalConcurrencyLimit] of [[widePlan, 6], [mixedPlan, 4], [widePlan, 2, 2]]) {
  const autoScript = buildWorkflowScript("Bounded auto concurrency", autoPlan, "", "auto");
  assert.equal(validateWorkflowScript(autoScript).ok, true);
  let active = 0, peak = 0;
  const done = new Set();
  let release;
  const readersReady = new Promise(resolve => { release = resolve; });
  await runWorkflowScript({ script: autoScript, timeoutMs: 10000, globalConcurrencyLimit, async launch(key, params) {
    const task = autoPlan.tasks.find(t => t.id === key);
    active++; peak = Math.max(peak, active);
    assert.equal(params.model, task.model);
    assert.ok(task.dependsOn.every(id => done.has(id)));
    if (task.writes) assert.equal(active, 1);
    // A barrier proves admission width without relying on worker message timing.
    if (!task.dependsOn.length) { if (active === expectedPeak) release(); await readersReady; }
    active--; done.add(key);
    return { key, ok: true, output: "synthetic evidence", artifactPaths: [] };
  }, async status() { throw new Error("Unexpected status polling"); } });
  assert.equal(peak, expectedPeak);
  assert.equal(done.size, autoPlan.tasks.length);
}
console.log("PASS: installed native workflow validator + sandbox, exact models, fixed and auto (six/four) reader width, executor cap two, exclusive writer, dependencies and failure without replay; zero real children.");
