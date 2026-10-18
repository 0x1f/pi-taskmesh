import assert from "node:assert/strict";
import { taskBatches, validatePlan } from "../src/task-planner.js";

const readers = Array.from({ length: 6 }, (_, i) => ({
  id: "read_" + i, agent: "scout", task: "Inspect independent area " + i,
  dependsOn: [], profile: "fast", contextTokens: 1000,
}));
const allReaders = validatePlan({ reason: "Independent inspection", tasks: readers });
assert.deepEqual(taskBatches(allReaders).map(batch => batch.length), [3, 3], "Default remains three");
assert.deepEqual(taskBatches(allReaders, "auto").map(batch => batch.length), [6], "Auto uses the ready graph width");
const mixed = validatePlan({ reason: "Read then implement then review", tasks: [
  ...readers.slice(0, 4),
  { id: "write", agent: "worker", task: "Apply fix", dependsOn: readers.slice(0, 4).map(t => t.id), profile: "reasoning", contextTokens: 1000 },
  { id: "review", agent: "reviewer", task: "Review fix", dependsOn: ["write"], profile: "reasoning", contextTokens: 1000 },
] });
assert.deepEqual(taskBatches(mixed, "auto").map(batch => batch.length), [4, 1, 1]);
const finished = new Set<string>();
for (const batch of taskBatches(mixed, "auto")) {
  assert.ok(batch.every(t => t.dependsOn.every(id => finished.has(id))));
  if (batch.some(t => t.writes)) assert.equal(batch.length, 1);
  for (const task of batch) finished.add(task.id);
}
assert.deepEqual(taskBatches(allReaders, 2).map(batch => batch.length), [2, 2, 2]);
assert.deepEqual(taskBatches(allReaders, 6).map(batch => batch.length), [6]);
for (const invalid of [0, 7, 1.5, NaN, "6", "AUTO", null]) {
  assert.throws(() => taskBatches(allReaders, invalid as any), /concurrency/);
}
console.log("PASS: auto ready-width batches, six-reader bound, dependency order, exclusive writers, numeric limits and validation");
