import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "taskmesh-native-status-"));
try {
  const report = join(root, "report.json");
  const executor = resolve(process.argv[2] || process.env.PI_SUBAGENTS_DIR || join(homedir(), ".pi/agent/npm/node_modules/pi-subagents"));
  const result = spawnSync(process.env.PI_BOLT_BIN || "pi-bolt", [
    "--offline", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--no-session", "--no-builtin-tools",
    "-e", join(executor, "bundle/index.js"),
    "-e", fileURLToPath(new URL("./fixtures/retained-status.mjs", import.meta.url)),
    "--model", "owned-status/fixture", "--mode", "rpc",
  ], { cwd: root, encoding: "utf8", timeout: 30000,
    env: { PATH: process.env.PATH, HOME: root, TERM: "dumb", NO_COLOR: "1", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root,
      TASKMESH_STATUS_REPORT: report, PI_SUBAGENTS_TEMP_ROOT: join(root, "native") } });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  const data = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(data.error, undefined, data.error);
  assert.deepEqual(data, { calls: 4, states: ["stopped", "failed", "completed", "paused"] });
  console.log("PASS: actual Pi-Bolt + installed native disk status/RPC with an empty live snapshot corrects and persists retained states/paths; only status controls, zero model calls or children.");
} finally { rmSync(root, { recursive: true, force: true }); }
