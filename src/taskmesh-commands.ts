import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentOrchestrator } from "./orchestrator.js";

export function registerTaskMeshCommands(pi: ExtensionAPI, agents: AgentOrchestrator): void {
  const commands = ["on", "off", "status", "explain", "run", "resume", "help"];
  const usage = "/taskmesh on|off|status|explain|resume, /taskmesh run <task>";
  pi.registerCommand("taskmesh", {
    description: "Control TaskMesh orchestration and inspect task/model decisions",
    getArgumentCompletions(prefix) {
      const matches = commands.filter(value => value.startsWith(prefix));
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
