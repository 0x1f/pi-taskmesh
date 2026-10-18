import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "../src/jev.js";
import { CapabilityRouter, modelRoute, recordModelLoad } from "../src/capability-router.js";
import { validatePlan } from "../src/task-planner.js";

globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
function model(id: string, contextWindow = 256000) {
  return { provider: "gateway", id, name: id, input: ["text"], reasoning: true,
    contextWindow, maxTokens: 8192, cost: { input: 1 } };
}
function context(catalog: ReturnType<typeof model>[]): ExtensionContext {
  return { scopedModels: [], modelRegistry: { getAvailable: () => catalog,
    complete: async () => { throw new Error("Unexpected real model inference"); } } } as unknown as ExtensionContext;
}
function plan() {
  return validatePlan({ reason: "Inspect current task only", tasks: [
    { id: "inspect", agent: "scout", task: "Inspect callers", dependsOn: [], profile: "reasoning", contextTokens: 12000 },
  ] });
}

assert.deepEqual(modelRoute("future-provider/new-backend/model-v999"), {
  provider: "future-provider", namespace: "future-provider/new-backend", indirect: false,
});
assert.deepEqual(modelRoute("flat/model"), { provider: "flat", namespace: "flat", indirect: false });
const observedLoad = new Map<string, number>();
recordModelLoad(observedLoad, "gateway/first/a");
recordModelLoad(observedLoad, "gateway/first/b");
recordModelLoad(observedLoad, "gateway/second/a");
assert.equal(observedLoad.get("provider:gateway"), 3);
assert.equal(observedLoad.get("route:gateway/first"), 2);
assert.equal(observedLoad.get("route:gateway/second"), 1);
assert.equal(observedLoad.get("gateway/first/a"), 1);

const failures: string[] = [];
async function check(name: string, test: () => void | Promise<void>) {
  try { await test(); console.log("PASS: " + name); }
  catch (error) { failures.push(name); console.error("FAIL: " + name, error); }
}

await check("separate catalog route load behind one gateway", () => {
  const ctx = context([model("first/a"), model("first/b"), model("second/a")]);
  const load = new Map([["provider:gateway", 2], ["route:gateway/first", 2], ["gateway/first/a", 2]]);
  assert.equal(new CapabilityRouter().ranked(ctx, "reasoning", 1000, load)[0].id, "second/a");
});

await check("large alias family cannot hide every concrete route from Jev", async () => {
  const catalog = [...Array.from({ length: 20 }, (_, i) => model("group/alias-" + i, 1000000)),
    model("new-upstream/model-9000"), model("other-upstream/model-42")];
  let candidates: any[] = [];
  const jev = { isConfigured: () => true, evaluate: async (request: any) => {
    candidates = Object.values(request.questions.task_0.criteria).map(raw => JSON.parse(raw as string));
    assert.match(request.questions.task_0.instructions, /Different aliases do not establish independent review/);
    assert.ok(candidates.filter(m => m.id.includes("/group/")).every(m => m.indirectRoute === true && m.routeNamespace === "gateway/group"));
    assert.ok(candidates.filter(m => !m.id.includes("/group/")).every(m => m.indirectRoute === false));
    return { answers: { task_0: { value: "model_0" } } };
  } } as unknown as JevClient;
  await new CapabilityRouter().assign(plan(), "Read-only inspection", context(catalog), "jev", jev);
  assert.equal(candidates.length, 16);
  assert.ok(candidates.some(m => m.id === "gateway/new-upstream/model-9000"));
  assert.ok(candidates.some(m => m.id === "gateway/other-upstream/model-42"));
  assert.equal(new Set(candidates.map(m => m.id)).size, 16);
});

await check("explicitly scoped group remains usable and visibly indirect", async () => {
  const alias = model("group/synthetic-policy", 1000000);
  const ctx = context([alias, model("other/concrete")]);
  ctx.scopedModels = [{ model: alias, thinkingLevel: "off" }] as any;
  let count = 0;
  const jev = { isConfigured: () => true, evaluate: async (request: any) => {
    count++;
    const criteria = request.questions.task_0.criteria;
    assert.equal(Object.keys(criteria).length, 1);
    return { answers: { task_0: { value: "model_0" } } };
  } } as unknown as JevClient;
  const taskPlan = plan();
  await new CapabilityRouter().assign(taskPlan, "inspect", ctx, "jev", jev);
  assert.equal(count, 1);
  assert.equal(taskPlan.tasks[0].model, "gateway/group/synthetic-policy");
  assert.match(taskPlan.tasks[0].modelReason!, /indirect.*actual backend unknown/i);
});

await check("context, scope, cooldown and uncertain judgment remain hard boundaries", async () => {
  const catalog = [model("first/a"), model("first/b"), model("group/alias"), model("small/c", 8000)];
  const router = new CapabilityRouter();
  router.record("gateway/first/a", false, "HTTP 429 rate limit");
  const taskPlan = plan();
  const load = new Map<string, number>();
  recordModelLoad(load, "gateway/first/b");
  const unavailable = { isConfigured: () => true, evaluate: async () => { throw new Error("Owned classifier failure"); } } as unknown as JevClient;
  await router.assign(taskPlan, "inspect", context(catalog), "jev", unavailable, undefined, load);
  assert.equal(taskPlan.tasks[0].model, "gateway/group/alias");
  assert.match(taskPlan.tasks[0].modelReason!, /Metadata.*Owned classifier failure/);
  assert.match(taskPlan.tasks[0].modelReason!, /actual backend unknown/);
  assert.equal(load.get("route:gateway/group"), 1);
  assert.equal(load.get("provider:gateway"), 2);
  const ranked = router.ranked(context(catalog), "reasoning", 12000);
  assert.ok(!ranked.some(m => m.id === "first/a" || m.id === "small/c"));
  assert.ok(ranked.some(m => m.id === "first/b"));
});

assert.deepEqual(failures, [], "Routing regressions failed");
