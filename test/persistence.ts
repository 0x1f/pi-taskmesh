import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import { JevClient } from "../src/jev.js";
import { JEV_TOOL_NAMES } from "../src/types.js";

// Every child uses a private config directory, no real credentials or network.
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const switches = ["auto", "auto-model", "tool-guard", "compact", "auto-agents"];
const labels = ["Auto mode", "Auto-model", "Tool guard", "Jev compaction", "Agent orchestration"];
const mode = process.argv[2];
if (!mode) {
  const root = mkdtempSync(join(tmpdir(), "jev-persistence-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: root };
  for (const key of Object.keys(env)) {
    if (/^(JEV_|PI_JEV_|TYPESAFE_|AI_GATEWAY_API_KEY$)/.test(key)) delete env[key];
  }
  try {
    writeFileSync(join(root, "jev.json"), JSON.stringify({ vercel: { model: "custom-model" }, keep: 42 }));
    for (const phase of ["save", "overrides", "restore", "restore-off", "enable", "restore-enabled", "failure"]) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), phase], { env, encoding: "utf8" });
      assert.equal(child.status, 0, `${phase}: ${child.stdout}\n${child.stderr}`);
    }
    console.log("PASS: provider, tool activation and five feature switches survive fresh processes; save failures are reported.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  if (mode === "overrides") {
    process.env.JEV_PROVIDER = "typesafe";
    for (const name of ["PI_JEV_AUTO", "PI_JEV_AUTO_MODEL", "PI_JEV_TOOL_GUARD", "PI_JEV_COMPACT", "PI_JEV_AGENTS"]) process.env[name] = "off";
  }
  const flags = new Map<string, unknown>();
  const handlers = new Map<string, Function[]>();
  let command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let active: string[] = ["read", "unrelated_tool", ...(mode === "save" ? [] : JEV_TOOL_NAMES)];
  const notices: string[] = [];
  const pi = {
    registerFlag(name: string, options: { default: unknown }) { flags.set(name, options.default); },
    getFlag: (name: string) => flags.get(name),
    registerTool() {},
    registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: { on() { return () => {}; } },
    getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names; },
    getAllTools: () => ["read", "unrelated_tool", ...JEV_TOOL_NAMES].map(name => ({ name })),
  } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getBranch: () => [] }, ui: { notify(text: string) { notices.push(text); }, setStatus() {} } } as unknown as ExtensionCommandContext;
  extension(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  const run = (args: string) => command(args, ctx);
  const client = new JevClient();
  const config = () => JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "jev.json"), "utf8"));
  if (mode === "save") {
    assert.deepEqual(active, ["read", "unrelated_tool"]);
    await run("provider vercel");
    assert.equal(config().provider, "vercel");
    for (const toggle of switches) await run(`${toggle} on`);
    await run("disable");
    assert.deepEqual(active, ["read", "unrelated_tool"]);
    assert.equal(config().keep, 42);
    assert.equal(config().vercel.model, "custom-model");
  } else if (mode === "overrides") {
    assert.equal(client.getProviderPreference(), "typesafe");
    await run("status");
    for (const label of labels) assert.ok(notices.at(-1)!.includes(`${label}: off`));
    assert.equal(config().provider, "vercel");
    assert.equal(config().features.auto, true);
  } else if (mode === "restore" || mode === "restore-off") {
    assert.equal(client.getProviderPreference(), mode === "restore" ? "vercel" : "typesafe");
    assert.deepEqual(active, ["read", "unrelated_tool"]);
    await run("status");
    for (const label of labels) assert.ok(notices.at(-1)!.includes(`${label}: ${mode === "restore" ? "on" : "off"}`));
    if (mode === "restore") {
      await run("provider typesafe");
      for (const toggle of switches) await run(`${toggle} off`);
    }
  } else if (mode === "enable") {
    await run("enable");
    assert.deepEqual(active, ["read", "unrelated_tool", ...JEV_TOOL_NAMES]);
  } else if (mode === "restore-enabled") {
    // A saved explicit enable must also restore tools omitted by the host.
    active = ["read", "unrelated_tool"];
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
    assert.deepEqual(active, ["read", "unrelated_tool", ...JEV_TOOL_NAMES]);
    assert.equal(config().keep, 42);
  } else if (mode === "failure") {
    const blocked = join(process.env.PI_CODING_AGENT_DIR!, "blocked");
    writeFileSync(blocked, "not a directory");
    process.env.PI_CODING_AGENT_DIR = blocked;
    await run("provider auto");
    assert.match(notices.at(-1)!, /global save failed/);
    await run("disable");
    assert.match(notices.at(-1)!, /global save failed/);
    assert.deepEqual(active, ["read", "unrelated_tool"]);
  }
}
