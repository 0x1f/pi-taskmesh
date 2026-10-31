import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "taskmesh-goal-host-"));
try {
  for (const mode of ["on", "only"]) {
    for (const [entry, deny, decision = "team", trigger = "checkpoint"] of [["taskmesh_goal", ""], ["codemode", ""], ["taskmesh_goal", "get_goal"], ["taskmesh_goal", "update_goal"], ["taskmesh_goal", "", "resume"],
      ["taskmesh_goal", "", "team", "user"], ["taskmesh_goal", "", "team", "completion"], ["taskmesh_goal", "", "team", "malformed"]]) {
      const dir = join(root, mode + "-" + entry + "-" + deny + "-" + decision + "-" + trigger); mkdirSync(dir);
      const report = join(dir, "report.json");
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ codemode: { mode } }));
      const result = spawnSync(process.env.PI_BOLT_BIN || "pi-bolt", [
        "--offline", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--no-session", "--no-builtin-tools",
        "--tools", "taskmesh_goal,get_goal,update_goal,codemode", "-e", "builtin:codemode",
        "-e", fileURLToPath(new URL("./fixtures/goal-tool.mjs", import.meta.url)),
        "--model", "owned-fixture/fixture", "-p", "Owned offline Goal tool fixture",
      ], { cwd: dir, encoding: "utf8", timeout: 30000,
        env: { PATH: process.env.PATH, HOME: dir, TERM: "dumb", NO_COLOR: "1", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: dir,
          TASKMESH_HOST_REPORT: report, TASKMESH_HOST_ENTRY: entry, TASKMESH_HOST_DENY: deny, TASKMESH_HOST_DECISION: decision, TASKMESH_HOST_TRIGGER: trigger } });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
      const data = JSON.parse(readFileSync(report, "utf8"));
      const diagnostic = JSON.stringify({ mode, entry, deny, ...data });
      assert.equal(data.exposure, "model-only");
      assert.ok(data.active.includes("codemode"));
      assert.equal(data.active.includes("taskmesh_goal"), false, "The checkpoint tool must start inactive");
      assert.equal(data.declared[0].includes("taskmesh_goal"), trigger === "checkpoint", "Only a native checkpoint may expose the Goal tool, including in codemode-only mode");
      assert.ok(data.declared[0].includes("codemode"));
      assert.equal(data.declared[0].includes("get_goal"), mode === "on");
      if (trigger !== "checkpoint") {
        assert.deepEqual(data.calls, []);
        assert.deepEqual(data.toolCalls, []);
        assert.equal(data.spawns, 0);
        assert.equal(data.requests, 1);
        assert.equal(data.goal.scheduler.phase, "running");
        continue;
      }
      const delegated = entry === "taskmesh_goal" && !deny && decision === "team";
      if (entry === "taskmesh_goal") assert.deepEqual(data.toolCalls, ["taskmesh_goal", ...data.calls], "Nested Goal calls must reach the host tool hooks, breaking consecutive TaskMesh calls");
      if (!delegated && entry === "taskmesh_goal") assert.equal(data.declared[1].includes("taskmesh_goal"), false, "A refusal must leave the tool unavailable on the next model request");
      assert.equal(data.spawns, delegated ? 1 : 0, diagnostic);
      assert.equal(data.requests, delegated ? 1 : 2, "A granted wait must end the parent turn; a refusal must not");
      assert.equal(data.goal.scheduler.phase, delegated ? "waiting" : "running");
      assert.deepEqual(data.goal.taskList.tasks, [{ id: "baseline", title: "Baseline", status: "complete" }, { id: "replay", title: "Replay", status: "pending" }]);
      assert.equal(data.goal.currentTaskId, "replay");
      assert.deepEqual(data.goal.usage, { tokensUsed: 3000000, activeSeconds: 2400 });
      assert.match(data.hint, /not through codemode/);
      assert.equal(data.customMessages.includes("taskmesh-goal-checkpoint"), false, "Guidance must not become a scheduler takeover message");
      if (delegated) {
        assert.deepEqual(data.calls, ["get_goal", "get_goal", "update_goal"]);
        assert.match(data.task, /remaining authorized work/);
        assert.match(data.task, /"id":"baseline","title":"Baseline","status":"complete"/);
        assert.match(data.task, /Current task: replay/);
      } else if (decision === "resume") {
        assert.deepEqual(data.calls, ["get_goal"]);
        assert.match(JSON.stringify(data.results), /update_goal_task/);
        assert.match(JSON.stringify(data.results), /request completion with update_goal/);
        assert.match(JSON.stringify(data.results), /Do not end with only a checkpoint acknowledgement/);
      } else if (entry === "codemode") {
        assert.deepEqual(data.calls, []);
        assert.match(JSON.stringify(data.results), /tools.taskmesh_goal does not exist/);
      } else {
        assert.match(JSON.stringify(data.results), /Owned Goal rejection/);
      }
    }
  }
  console.log("PASS: actual Pi-Bolt checkpoint-only model declaration in codemode on/only, one assessment per checkpoint, native nested results, wait termination, rejected Goal tools, actionable resume handback, preserved progress and codemode negative control. Synthetic model/Goal/executor; no network or real children.");
} finally { rmSync(root, { recursive: true, force: true }); }
