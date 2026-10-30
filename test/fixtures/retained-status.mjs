// Loaded only by test:status with the installed native executor in a private Pi-Bolt process.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentOrchestrator } from "../../src/orchestrator.ts";
import { validatePlan } from "../../src/task-planner.ts";

globalThis.fetch = async () => { throw new Error("Unexpected network request in native status fixture"); };

export default function (pi) {
  pi.registerProvider("owned-status", { apiKey: "synthetic-local", api: "owned-status-api", baseUrl: "https://invalid.invalid",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple() { throw new Error("Unexpected model request in native status fixture"); } });
  pi.on("session_start", async (_event, hostCtx) => {
    try {
      const root = hostCtx.cwd;
      const runId = "owned-retained-workflow", requestId = "owned-spawn";
      const asyncDir = join(process.env.PI_SUBAGENTS_TEMP_ROOT, "async-subagent-runs", runId);
      mkdirSync(asyncDir, { recursive: true });
      const workflowReceiptPath = join(asyncDir, "workflow-receipt.json");
      const saved = { task: "Inspect owned fixture", cwd: root, state: "running", runId, requestId, plannerModel: "fixture/planner",
        plan: validatePlan({ reason: "One owned reader", tasks: [{ id: "read", agent: "scout", task: "Inspect fixture", dependsOn: [],
          profile: "fast", contextTokens: 1000, model: "fixture/reader" }] }) };
      const entries = [];
      let calls = 0;
      const events = {
        on(name, handler) { return pi.events.on(name, data => {
          if (name.startsWith("subagents:rpc:v1:reply:")) {
            assert.equal(data.success, true, JSON.stringify(data));
            assert.deepEqual(data.data.asyncSnapshot.runs, [], "The retained run must be absent from the live snapshot");
          }
          handler(data);
        }); },
        emit(name, data) {
          assert.equal(name, "subagents:rpc:v1:request");
          assert.equal(data.method, "status", "Recovery must not execute any other control");
          calls++; pi.events.emit(name, data);
        },
      };
      const ctx = { cwd: root, sessionManager: { getBranch: () => entries } };
      const adapter = { events, appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); } };
      const states = ["stopped", "failed", "completed", "paused"];
      for (const state of states) {
        writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ runId, toolCallId: "rpc-spawn-" + requestId,
          sessionId: hostCtx.sessionManager.getSessionFile() ?? hostCtx.sessionManager.getSessionId(),
          mode: "workflow", state, startedAt: 1, lastUpdate: 2, steps: [], workflowReceiptPath,
          workflowChildren: { version: 1, parentToolCallId: "rpc-spawn-" + requestId, workflowRunId: runId,
            inventoryComplete: true, workflowState: state, children: [] } }));
        entries.push({ type: "custom", customType: "taskmesh-orchestration", data: structuredClone(saved) });
        const agents = new AgentOrchestrator(adapter);
        try {
          agents.restore(ctx);
          await agents.status(ctx);
          assert.match(agents.summary(), new RegExp("^TaskMesh " + state + " "));
          assert.ok(agents.summary().includes(workflowReceiptPath));
          assert.equal(agents.hasActive(), state === "paused");
          agents.restore(ctx);
          assert.match(agents.summary(), new RegExp("TaskMesh " + state));
        } finally { agents.dispose(); }
      }
      writeFileSync(process.env.TASKMESH_STATUS_REPORT, JSON.stringify({ calls, states }));
    } catch (error) {
      writeFileSync(process.env.TASKMESH_STATUS_REPORT, JSON.stringify({ error: String(error.stack || error) }));
    } finally { hostCtx.shutdown(); }
  });
}
