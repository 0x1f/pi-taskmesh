import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentOrchestrator, GoalWait } from "./orchestrator.js";

interface Checkpoint { goalId: string; generation: string; dispatchId: string }
interface Goal {
  id: string; status: string; autoContinue: boolean; objective: string; tokenBudget?: number;
  verificationContract?: string; taskList?: unknown;
  scheduler?: { owner: string; generation: string; phase: string; dispatch?: { id: string }; wait?: { token: string } };
}
interface GoalResult {
  isError?: boolean; terminate?: boolean;
  details?: { version?: number; goal?: Goal | null; waitToken?: string; error?: boolean };
}
type GoalContext = ExtensionContext & {
  executeTool?: (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<GoalResult>;
};

/** Use the installed Goal tools: never read or rewrite its private files. */
export class GoalBridge {
  private checkpoint?: Checkpoint;
  private busy = false;
  constructor(pi: ExtensionAPI, private agents: AgentOrchestrator) {
    const tool = {
      name: "taskmesh_goal", label: "TaskMesh Goal",
      description: "Assess the current native Goal checkpoint for automatic delegation. Requires an active claimed checkpoint and Goal's permission to wait. Otherwise continue with the main agent.",
      exposure: "model-only" as const, executionMode: "sequential" as const,
      reachesTools: () => ["get_goal", "update_goal"],
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: (_id: string, _params: {}, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: GoalContext) => this.execute(ctx, signal),
    };
    pi.registerTool(tool);
  }

  reset(): void { this.checkpoint = undefined; }

  beforeStart(event: unknown): { customType: string; content: string; display: boolean } | undefined {
    this.reset();
    const e = event as { messageType?: string; message?: { role?: string; customType?: string; details?: Record<string, unknown> } };
    const d = e.message?.details;
    if (!this.agents.enabled || e.messageType !== "custom" || e.message?.customType !== "pi-goal-event" ||
        d?.version !== 3 || d.kind !== "checkpoint" ||
        ![d.goalId, d.generation, d.dispatchId].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)) return;
    this.checkpoint = { goalId: d.goalId as string, generation: d.generation as string, dispatchId: d.dispatchId as string };
    return { customType: "taskmesh-goal-checkpoint", display: false,
      content: "This turn is a Goal checkpoint. Call taskmesh_goal once before substantive work to apply the saved TaskMesh automatic preference. " +
        "It verifies the live Goal and may decline; then continue with the main agent under the Goal policy. " +
        "Never change Goal settings or its budget to enable delegation. A retained failed workflow must not be replayed automatically." };
  }

  private async execute(ctx: GoalContext, signal?: AbortSignal) {
    const checkpoint = this.checkpoint;
    let waiting = false;
    const response = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, terminate: waiting });
    if (!checkpoint || !this.agents.enabled || this.busy || !ctx.executeTool) {
      return response("TaskMesh Goal delegation unavailable: requires this turn's Goal checkpoint, automatic mode, and native nested tool support. Continue under the Goal policy.");
    }
    this.busy = true;
    const execute = ctx.executeTool.bind(ctx);
    const current = () => {
      if (this.checkpoint !== checkpoint || !this.agents.enabled || signal?.aborted) throw new Error("Goal checkpoint changed or delegation was cancelled");
    };
    const read = async (): Promise<Goal> => {
      current();
      const result = await execute("get_goal", {}, { signal });
      current();
      const goal = result.details?.goal;
      const s = goal?.scheduler;
      if (result.isError || result.details?.version !== 3 || !goal || goal.id !== checkpoint.goalId ||
          goal.status !== "active" || !goal.autoContinue || typeof goal.objective !== "string" ||
          !s || s.owner !== ctx.sessionManager.getSessionId() || s.generation !== checkpoint.generation ||
          s.dispatch?.id !== checkpoint.dispatchId || !["claimed", "running"].includes(s.phase)) {
        throw new Error("Goal checkpoint is stale, inactive, waiting, or owned by another session");
      }
      // Child usage is not charged to Goal's lifetime cap by this adapter.
      if (goal.tokenBudget !== undefined) throw new Error("Budgeted Goals stay with the main agent; child spending cannot be bounded by this adapter");
      return goal;
    };
    try {
      const goal = await read();
      const retained = this.agents.goalSchedule(goal.id);
      if (retained) return response(retained);
      if (this.agents.hasActive()) return response("Another TaskMesh workflow is already active. Inspect its retained results before starting concurrent work. " + this.agents.summary());
      const task = "Execute only the remaining authorized work for Goal " + goal.id + ". Reuse completed evidence; do not replay completed steps.\nObjective:\n" + goal.objective +
        "\nVerification contract:\n" + (goal.verificationContract ?? "") + "\nTask progress (background):\n" + JSON.stringify(goal.taskList ?? null);
      if (task.length > 32000) return response("Goal requirements exceed TaskMesh's bounded input. Continue with the main agent without truncating the requirements.");
      const decision = await this.agents.assessDetailed(task, ctx);
      current();
      if (decision.kind !== "team") return response("TaskMesh Goal decision: " + decision.kind + ". " + decision.reason + " Continue with the main agent under the Goal policy.");
      const result = await this.agents.dispatch(task, ctx, true, async (): Promise<GoalWait> => {
        await read(); // Planning can take time; recheck immediately before the wait and spawn.
        current();
        const wait = await execute("update_goal", { continuation: { kind: "wait", reason: "Waiting for the current TaskMesh workflow", deadline: new Date(Date.now() + 3_600_000).toISOString() } }, { signal });
        waiting = wait.terminate === true;
        const token = wait.details?.waitToken;
        if (wait.isError || wait.details?.error || !waiting || typeof token !== "string" || !token ||
            wait.details?.goal?.id !== goal.id || wait.details.goal.status !== "active" ||
            wait.details.goal.scheduler?.phase !== "waiting" || wait.details.goal.scheduler.wait?.token !== token) {
          throw new Error("Goal did not grant a usable wait. New waits require its strictExecutionContract opt-in; no workflow was launched and settings were not changed");
        }
        return { ...checkpoint, waitToken: token };
      });
      return response(result.accepted || result.uncertain ? this.agents.summary() : "TaskMesh Goal delegation not started: " + result.error + ". Continue under the Goal policy.");
    } catch (error) {
      return response("TaskMesh Goal delegation skipped: " + String((error as Error).message ?? error));
    } finally { this.busy = false; }
  }
}
