import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { JevClient } from "./jev.js";
import { classifyModelError, modelScore, type ModelProfile } from "./model-router.js";
import type { TaskPlan } from "./task-planner.js";
import type { QuestionConfig } from "./types.js";
import type { DecisionBackend } from "./taskmesh-config.js";
import { judgeChoices } from "./decision-backend.js";

export class CapabilityRouter {
  private blocked = new Map<string, number>();
  private outcomes = new Map<string, { completed: number; failed: number }>();

  available(ctx: ExtensionContext): Model<any>[] {
    const scoped = new Set(ctx.scopedModels?.map(x => this.id(x.model)));
    return ctx.modelRegistry.getAvailable().filter(m => (!scoped.size || scoped.has(this.id(m))) &&
      m.input?.includes("text") && Number.isFinite(m.contextWindow) && m.maxTokens > 0 &&
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
      // A shared gateway's one upstream failure does not disable its other models.
      this.blocked.set(model, Date.now() + (["auth", "quota", "rate-limit"].includes(kind) ? 600_000 : 60_000));
    }
  }

  ranked(ctx: ExtensionContext, profile: ModelProfile, tokens: number, load = new Map<string, number>()): Model<any>[] {
    return this.available(ctx).filter(m => m.contextWindow >= tokens + 4096).sort((a, b) => {
      const score = (m: Model<any>) => {
        const history = this.outcomes.get(this.id(m));
        return modelScore(m, profile, tokens * 3, false) - (load.get(this.id(m)) ?? 0) * 8 -
          (load.get("provider:" + m.provider) ?? 0) * 2 - (history?.failed ?? 0) / Math.max(1, (history?.completed ?? 0) + (history?.failed ?? 0)) * 3;
      };
      return score(b) - score(a) || this.id(a).localeCompare(this.id(b));
    });
  }

  async assign(
    plan: TaskPlan, context: string, ctx: ExtensionContext, backend: DecisionBackend = "pi",
    jev?: JevClient, signal = new AbortController().signal, load = new Map<string, number>()
  ): Promise<void> {
    const tokens = plan.tasks.map(t => Math.max(t.contextTokens,
      Math.ceil(Buffer.byteLength(context + t.task, "utf8") / 3) + (t.dependsOn.length ? 32000 : 0)));
    const candidates = plan.tasks.map((t, i) => this.ranked(ctx, t.profile, tokens[i], load).slice(0, 16));
    if (candidates.some(c => !c.length)) throw new Error("No authenticated, scoped model has enough context for a planned task");
    const questions: Record<string, QuestionConfig> = {};
    plan.tasks.forEach((t, i) => {
      questions["task_" + i] = { type: "choice", instructions: "Choose the best available model for task " + i +
        " using requirements, model metadata, observed outcomes and current load. Metadata and completed runs are not measured code quality. " +
        "Prefer an independent model for review when suitable. Never force variety at the expense of suitability.",
        criteria: Object.fromEntries(candidates[i].map((m, j) => ["model_" + j, JSON.stringify({ id: this.id(m), name: m.name,
          reasoning: m.reasoning, contextWindow: m.contextWindow, load: load.get(this.id(m)) ?? 0, outcomes: this.outcomes.get(this.id(m)) })])) };
    });
    let choices: Record<string, string> = {};
    let reason: string;
    try {
      const state = { tasks: plan.tasks, recentContext: context };
      const needed = Math.ceil(Buffer.byteLength(JSON.stringify({ state, questions }), "utf8") / 3) + 2000;
      const decision = await judgeChoices(backend, state, questions, this.ranked(ctx, "reasoning", needed, load), ctx, signal, jev,
        (model, error) => this.record(model, false, error));
      choices = decision.answers;
      reason = backend + " task-fit judgment (not a benchmark)";
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      reason = "Metadata, observed outcomes and load fallback (not a benchmark): " + String((error as Error).message ?? error).slice(0, 300);
    }
    plan.tasks.forEach((t, i) => {
      const choice = choices["task_" + i] ?? "";
      const index = /^model_[0-9]+$/.test(choice) ? Number(choice.slice(6)) : -1;
      const selected = candidates[i][index];
      const eligible = this.ranked(ctx, t.profile, tokens[i], load);
      const judged = selected && eligible.some(m => this.id(m) === this.id(selected));
      const model = judged ? selected : eligible[0];
      if (!model) throw new Error("No eligible model remains after decision failures");
      t.model = this.id(model);
      t.modelReason = judged ? reason : reason.startsWith("Metadata") ? reason :
        "Metadata, observed outcomes and load fallback (not a benchmark): judged candidate no longer eligible";
      load.set(t.model, (load.get(t.model) ?? 0) + 1);
      load.set("provider:" + model.provider, (load.get("provider:" + model.provider) ?? 0) + 1);
    });
  }
}
