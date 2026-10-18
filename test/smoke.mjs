import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "taskmesh-host-"));
const report = join(root, "report.json");
const checker = join(root, "check.ts");
writeFileSync(checker,   "import {writeFileSync} from 'node:fs';\n" +
  "globalThis.fetch = async () => { throw new Error('Unexpected network request in offline host smoke'); };\n" +
  "export default function(pi) { pi.on('session_start', async (_event, ctx) => {\n" +
  "const commands = pi.getCommands().map(c => c.name);\n" +
  "const checks = {taskmesh:commands.includes('taskmesh'), legacy:commands.includes('jev'), inference:typeof ctx.modelRegistry.complete === 'function', available:typeof ctx.modelRegistry.getAvailable === 'function', bus:typeof pi.events.emit === 'function', noJevTools:!pi.getActiveTools().some(n => n.startsWith('jev_'))};\n" +
  "writeFileSync(process.env.TASKMESH_SMOKE_REPORT, JSON.stringify(checks)); ctx.shutdown(); }); }\n");
try {
  const result = spawnSync(process.env.PI_BOLT_BIN || "pi-bolt", [
    "--offline", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--no-session", "--no-tools",
    "-e", fileURLToPath(new URL("../extensions/index.ts", import.meta.url)), "-e", checker, "-p",
  ], {
    cwd: root, input: "", encoding: "utf8", timeout: 30000,
    env: { PATH: process.env.PATH, TERM: "dumb", NO_COLOR: "1", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: root, TASKMESH_SMOKE_REPORT: report },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  const checks = JSON.parse(readFileSync(report, "utf8"));
  for (const [key, value] of Object.entries(checks)) assert.equal(value, true, key);
  console.log("PASS: actual Pi-Bolt loads TaskMesh, legacy commands and required APIs in private offline config; no models, tools or user credentials used.");
} finally { rmSync(root, { recursive: true, force: true }); }
