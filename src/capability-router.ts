import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { JevClient } from "./jev.js";
import { classifyModelError, modelScore, type ModelProfile } from "./model-router.js";
import type { TaskPlan } from "./task-planner.js";
import type { QuestionConfig } from "./types.js";

export class CapabilityRouter {
  private blocked = new Map<string, number>();
  private outcomes = new Map<string, { completed: number; failed: number }>();

  available(ctx: ExtensionContext): Model<any>[] {
    const scoped = new Set(ctx.scopedModels?.map(x => this.id(x.model)));
    return ctx.modelRegistry.getAvailable().filter(m => (!scoped.size || scoped.has(this.id(m))) &&
      m.input?.includes("text") && Number.isFinite(m.contextWindow) &&
      (this.blocked.get(this.id(m)) ?? 0) <= Date.now());
  }

  id(model: Model<any>): string { return model.provider + "/" + model.id; }

  record(model: string, ok: boolean, error = ""): void {
    const counts = this.outcomes.get(model) ?? { completed: 0, failed: 0 };
    counts[ok ? "completed" : "failed"]++;
    this.outcomes.set(model, counts);
    if (ok) return;
    const kind = classifyModelError(error);
    if (["auth", "quota", "rate-limit", "timeout", "unavailable", "context-limit"].includes(kind)) {
      const until = Date.now() + (["auth", "quota", "rate-limit"].includes(kind) ? 600_000 : 60_000);
      this.blocked.set(model, until);
      if (["auth", "quota", "rate-limit"].includes(kind)) this.blocked.set("provider:" + model.slice(0, model.indexOf("/")), until);
    }
  }

  ranked(ctx: ExtensionContext, profile: ModelProfile, tokens: number, load = new Map<string, number>()): Model<any>[] {
    return this.available(ctx).filter(m => m.contextWindow >= tokens + 4096 &&
      (this.blocked.get("provider:" + m.provider) ?? 0) <= Date.now()).sort((a, b) => {
      const score = (m: Model<any>) => {
        const history = this.outcomes.get(this.id(m));
        return modelScore(m, profile, tokens * 3, false) - (load.get(this.id(m)) ?? 0) * 8 -
          (load.get("provider:" + m.provider) ?? 0) * 2 - (history?.failed ?? 0) / Math.max(1, (history?.completed ?? 0) + (history?.failed ?? 0)) * 3;
      };
      return score(b) - score(a) || this.id(a).localeCompare(this.id(b));
    });
  }

  async assign(plan: TaskPlan, context: string, ctx: ExtensionContext, jev?: JevClient, signal?: AbortSignal, load = new Map<string, number>()): Promise<void> {
    const tokens = plan.tasks.map(t => Math.max(t.contextTokens, Math.ceil((context.length + t.task.length + (t.dependsOn.length ? 32000 : 0)) / 3)));
    const candidates = plan.tasks.map((t, i) => this.ranked(ctx, t.profile, tokens[i], load).slice(0, 16));
    if (candidates.some(c => !c.length)) throw new Error("No authenticated, scoped model has enough context for a planned task");
    const questions: Record<string, QuestionConfig> = {};
    plan.tasks.forEach((t, i) => {
      questions["task_" + i] = { type: "choice", instructions: "Choose the best available model for task " + i + " using task requirements, declared model metadata, observed outcomes and current load. Metadata and completed runs are not measured code quality. Prefer a different provider for independent review when suitable.",
        criteria: Object.fromEntries(candidates[i].map((m, j) => ["model_" + j, JSON.stringify({ id: this.id(m), name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, load: load.get(this.id(m)) ?? 0, outcomes: this.outcomes.get(this.id(m)) })])) };
    });
    let choices: Record<string, string | number | boolean> = {};
    if (jev?.isConfigured()) {
      try {
        const result = await jev.evaluate({ state: { tasks: plan.tasks, recentContext: context }, questions }, signal);
        choices = Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id, a.value]));
      } catch { if (signal?.aborted) throw signal.reason; }
    }
    plan.tasks.forEach((t, i) => {
      const choice = String(choices["task_" + i] ?? "");
      const index = /^model_[0-9]+$/.test(choice) ? Number(choice.slice(6)) : -1;
      const selected = candidates[i][index];
      const model = selected ?? this.ranked(ctx, t.profile, tokens[i], load)[0];
      t.model = this.id(model);
      t.modelReason = selected ? "Jev task-fit judgment (not a benchmark)" : "Metadata, observed outcomes and load fallback (not a benchmark)";
      load.set(t.model, (load.get(t.model) ?? 0) + 1);
      load.set("provider:" + model.provider, (load.get("provider:" + model.provider) ?? 0) + 1);
    });
  }
}
