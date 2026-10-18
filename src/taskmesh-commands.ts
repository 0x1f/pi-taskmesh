import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentOrchestrator } from "./orchestrator.js";

export function registerTaskMeshCommands(pi: ExtensionAPI, agents: AgentOrchestrator): void {
  const commands = ["on", "off", "backend", "concurrency", "status", "explain", "run", "resume", "help"];
  const usage = "/taskmesh on|off|status|explain|resume, /taskmesh backend [pi|jev], /taskmesh concurrency [auto|1–6], /taskmesh run <task>";
  pi.registerCommand("taskmesh", {
    description: "Control TaskMesh orchestration and inspect task/model decisions",
    getArgumentCompletions(prefix) {
      const normalized = prefix.trimStart().toLowerCase();
      const values = normalized.startsWith("backend ") ? ["backend pi", "backend jev"] :
        normalized.startsWith("concurrency ") ? ["auto", "1", "2", "3", "4", "5", "6"].map(value => "concurrency " + value) : commands;
      const matches = values.filter(value => value.startsWith(normalized));
      return matches.length ? matches.map(value => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const clean = args.trim();
      const sub = clean.split(/\s/, 1)[0].toLowerCase();
      const rest = clean.slice(sub.length).trim();
      if (sub === "on" || sub === "off") {
        if (rest) { ctx.ui.notify("Usage: /taskmesh on|off", "warning"); return; }
        try {
          agents.configure({ enabled: sub === "on" });
          ctx.ui.setStatus("taskmesh", agents.enabled ? "taskmesh: auto" : "taskmesh: explicit");
          ctx.ui.notify(sub === "on"
            ? "TaskMesh automatic delegation enabled and saved globally. This authorizes task decomposition and child execution for eligible future prompts; current requests forbidding delegation still take priority."
            : "TaskMesh automatic delegation disabled and saved globally. Explicit /taskmesh run remains available; an existing run continues.", "info");
        } catch (error) { ctx.ui.notify("TaskMesh global save failed: " + String((error as Error).message ?? error), "error"); }
        return;
      }
      if (sub === "backend") {
        if (!rest) { ctx.ui.notify(agents.configuration(), "info"); return; }
        const backend = rest.toLowerCase();
        if (backend !== "pi" && backend !== "jev") { ctx.ui.notify("Usage: /taskmesh backend [pi|jev]", "warning"); return; }
        try {
          agents.configure({ decisionBackend: backend });
          ctx.ui.notify("TaskMesh decision backend saved globally as " + backend + ". Applies immediately to subsequent judgments; existing tasks continue.", "info");
        } catch (error) { ctx.ui.notify("TaskMesh global save failed: " + String((error as Error).message ?? error), "error"); }
        return;
      }
      if (sub === "concurrency") {
        if (!rest) { ctx.ui.notify(agents.configuration(), "info"); return; }
        const value = rest.toLowerCase();
        if (value !== "auto" && !/^[1-6]$/.test(value)) { ctx.ui.notify("Usage: /taskmesh concurrency [auto|1–6]", "warning"); return; }
        try {
          agents.configure({ maxConcurrency: value === "auto" ? "auto" : Number(value) });
          ctx.ui.notify("TaskMesh reader concurrency saved globally as " + value +
            ". Applies to future plans only; writers remain exclusive and existing runs are unchanged.", "info");
        } catch (error) { ctx.ui.notify("TaskMesh global save failed: " + String((error as Error).message ?? error), "error"); }
        return;
      }
      if (!sub || sub === "status") { ctx.ui.notify(await agents.status(ctx), "info"); return; }
      if (sub === "explain") { ctx.ui.notify(agents.explain(), "info"); return; }
      if (sub === "resume") { ctx.ui.notify(await agents.resume(ctx), "info"); return; }
      if (sub === "run") {
        if (!rest) { ctx.ui.notify("Usage: /taskmesh run <task>", "warning"); return; }
        if (!ctx.isIdle()) { ctx.ui.notify("Wait until the main agent is idle before starting a TaskMesh run.", "warning"); return; }
        const result = await agents.dispatch(rest, ctx);
        if (!result.accepted) ctx.ui.notify(result.error ?? "Orchestration unavailable", "warning");
        return;
      }
      ctx.ui.notify(usage, sub === "help" ? "info" : "warning");
    },
  });
}
