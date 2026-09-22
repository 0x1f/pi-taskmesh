import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { JevClient, JevProviderPreference, JevProviderStatus } from "./jev.js";
import type { ToolRouter } from "./router.js";
import type { SkillRouter } from "./skills.js";
import type { AutoJev } from "./auto.js";
import type { AutoModelRouter } from "./model-router.js";
import type { JevCompactor } from "./compact.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { ToolGuard } from "./tool-guard.js";
import { designEvaluation } from "./designer.js";
import type { JevEvaluationRequest } from "./types.js";
import { JEV_TOOL_NAMES, isJevTool } from "./types.js";
import { JEV_THRESHOLD } from "./skills.js";

function providerStatus(jevClient: JevClient): JevProviderStatus {
  // The fallback keeps older tests/mocks and third-party wrappers compatible.
  const client = jevClient as any;
  if (typeof client.getProviderStatus === "function") {
    return client.getProviderStatus();
  }
  const origin =
    typeof client.getKeyOrigin === "function" ? client.getKeyOrigin() : null;
  return {
    preference: "typesafe",
    provider: origin ? "typesafe" : null,
    configured: Boolean(origin),
    keyOrigin: origin,
    model: origin ? "jev-latest" : null,
  };
}

function providerLabel(status: JevProviderStatus): string {
  if (status.provider === "vercel") return "Vercel AI Gateway / typesafe-ai/jev";
  if (status.provider === "typesafe") return "TypeSafe Direct / Jev";
  return status.preference === "auto" ? "auto (unresolved)" : status.preference;
}


const JEV_SUBCOMMANDS = [
  { value: "status", description: "Show Jev provider and feature status" },
  { value: "setup", description: "Persist provider and API key interactively" },
  { value: "provider", description: "Switch provider and save globally" },
  { value: "skills", description: "Discover relevant skills" },
  { value: "test", description: "Run a Jev connectivity/evaluation test" },
  { value: "enable", description: "Enable Jev tools and save globally" },
  { value: "disable", description: "Disable Jev tools and save globally" },
  { value: "auto", description: "Toggle automatic tool/skill routing" },
  { value: "auto-model", description: "Toggle automatic model routing" },
  { value: "tool-guard", description: "Toggle Jev tool-call guard" },
  { value: "compact", description: "Toggle Jev-assisted compaction" },
  { value: "agents", description: "Dispatch a task through Jev agent orchestration" },
  { value: "auto-agents", description: "Toggle automatic agent orchestration" },
  { value: "help", description: "Show Jev command help" },
] as const;

const PROVIDER_COMPLETIONS = [
  { value: "vercel", description: "Vercel AI Gateway / typesafe-ai/jev" },
  { value: "typesafe", description: "TypeSafe Direct / Jev" },
  { value: "auto", description: "Auto-detect configured provider" },
] as const;

const TOGGLE_COMPLETIONS = [
  { value: "on", description: "Enable" },
  { value: "off", description: "Disable" },
] as const;

function jevArgumentCompletions(prefix: string) {
  const normalized = prefix.trimStart();
  const [subcommand = "", ...rest] = normalized.split(/\s+/);
  const startedArgument = /\s/.test(normalized);

  if (!startedArgument) {
    const matches = JEV_SUBCOMMANDS.filter((item) =>
      item.value.startsWith(subcommand.toLowerCase())
    ).map((item) => ({
      value: item.value,
      label: item.value,
      description: item.description,
    }));
    return matches.length > 0 ? matches : null;
  }

  const argument = rest.join(" ").toLowerCase();

  if (subcommand === "setup" || subcommand === "provider") {
    const matches = PROVIDER_COMPLETIONS.filter((item) =>
      item.value.startsWith(argument)
    ).map((item) => ({
      value: `${subcommand} ${item.value}`,
      label: item.value,
      description: item.description,
    }));
    return matches.length > 0 ? matches : null;
  }

  if (
    subcommand === "auto" ||
    subcommand === "auto-model" ||
    subcommand === "tool-guard" ||
    subcommand === "compact" ||
    subcommand === "auto-agents"
  ) {
    const matches = TOGGLE_COMPLETIONS.filter((item) =>
      item.value.startsWith(argument)
    ).map((item) => ({
      value: `${subcommand} ${item.value}`,
      label: item.value,
      description: item.description,
    }));
    return matches.length > 0 ? matches : null;
  }

  return null;
}

export function registerJevCommands(
  pi: ExtensionAPI,
  jevClient: JevClient,
  router: ToolRouter,
  skillRouter: SkillRouter,
  auto: AutoJev,
  autoModel?: AutoModelRouter,
  compactor?: JevCompactor,
  agents?: AgentOrchestrator,
  toolGuard?: ToolGuard
): void {
  const agentMode = agents ?? { enabled: false, setEnabled: () => {}, dispatch: async () => ({ accepted: false, error: "disabled" }) };
  const compactMode = compactor ?? { enabled: false, setEnabled: () => {} };
  const modelMode = autoModel ?? { enabled: false, setEnabled: () => {} };
  const guardMode = toolGuard ?? { enabled: false, setEnabled: () => {} };
  pi.registerCommand("jev", {
    description: "Manage Jev integration (provider, status, enable, disable, auto, test, skills)",
    getArgumentCompletions: (prefix) => jevArgumentCompletions(prefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "").toLowerCase();
      const rest = tokens.slice(1).join(" ");
      const usage =
        "Available options: /jev status, /jev setup [auto|typesafe|vercel], /jev provider [auto|typesafe|vercel], /jev skills [query], /jev test [prompt], /jev enable, /jev disable, /jev auto [on|off], /jev auto-model [on|off], /jev compact [on|off], /jev auto-agents [on|off], /jev tool-guard [on|off], /jev agents [task]";

      if (sub === "status" || sub === "") {
        const status = providerStatus(jevClient);
        const origin = status.keyOrigin;
        const activeTools = pi.getActiveTools();
        const allTools = pi.getAllTools();
        const activeSet = new Set(activeTools);
        const routable = allTools.filter(
          (t: any) => !activeSet.has(t.name) && !isJevTool(t.name)
        ).length;

        ctx.ui.notify(
          `Jev Status:\n` +
            `• Provider preference: ${status.preference}\n` +
            `• Active provider: ${providerLabel(status)}\n` +
            `• Model: ${status.model ?? "n/a"}\n` +
            `• Configured: ${origin ? `Yes (from ${origin})` : "No"}\n` +
            `• Requests in session: ${jevClient.stats.requestsCount}\n` +
            `• Total tokens used: ${jevClient.stats.totalTokens}\n` +
            `• Auto mode: ${auto.enabled ? "on" : "off"}${auto.enabled && !status.configured ? " (inactive: Jev unconfigured)" : ""}\n` +
            `• Auto-model: ${modelMode.enabled ? "on" : "off"}\n` +
            `• Tool guard: ${guardMode.enabled ? "on" : "off"}\n` +
            `• Jev compaction: ${compactMode.enabled ? "on" : "off"}\n` +
            `• Agent orchestration: ${agentMode.enabled ? "on" : "off"}\n` +
            `• Active tools: ${activeTools.length} / Available: ${allTools.length} (${routable} routable)\n` +
            (status.error ? `• Provider error: ${status.error}\n` : "") +
            (jevClient.stats.lastError ? `• Last error: ${jevClient.stats.lastError}` : ""),
          status.configured ? "info" : "warning"
        );
        return;
      }

      if (sub === "help") {
        ctx.ui.notify(`Jev commands:\n${usage}`, "info");
        return;
      }

      if (sub === "setup" || sub === "configure" || sub === "config") {
        const client = jevClient as any;
        if (
          typeof client.persistProvider !== "function" ||
          typeof client.persistApiKey !== "function"
        ) {
          ctx.ui.notify("This pi-jev build does not support interactive setup.", "error");
          return;
        }

        let selected = rest.trim().toLowerCase();
        if (!selected) {
          const choice = await ctx.ui.select("Jev provider", [
            "Vercel AI Gateway",
            "TypeSafe Direct",
            "Auto-detect",
          ]);
          if (!choice) return;
          selected =
            choice === "Vercel AI Gateway"
              ? "vercel"
              : choice === "TypeSafe Direct"
                ? "typesafe"
                : "auto";
        }

        if (selected !== "auto" && selected !== "typesafe" && selected !== "vercel") {
          ctx.ui.notify(
            `Unknown Jev provider "${rest}". Use /jev setup auto|typesafe|vercel.`,
            "warning"
          );
          return;
        }

        if (selected === "auto") {
          client.persistProvider("auto");
          const status = providerStatus(jevClient);
          ctx.ui.notify(
            status.configured
              ? `Jev saved globally as auto → ${providerLabel(status)}.`
              : "Jev saved globally as auto, but no provider credential is configured yet.",
            status.configured ? "info" : "warning"
          );
          return;
        }

        const providerName =
          selected === "vercel" ? "Vercel AI Gateway" : "TypeSafe Direct";
        const placeholder =
          selected === "vercel"
            ? "AI Gateway API key (leave blank to keep existing)"
            : "TypeSafe API key (leave blank to keep existing)";

        const key = await ctx.ui.input(`${providerName} API key`, placeholder);
        if (key === undefined || key === null) return;

        client.persistProvider(selected as JevProviderPreference);

        if (key.trim()) {
          const filename = client.persistApiKey(selected, key);
          ctx.ui.notify(
            `Jev configured globally: ${providerName}. Credential saved to ${filename} with restricted permissions.`,
            "info"
          );
        } else {
          const status = providerStatus(jevClient);
          ctx.ui.notify(
            status.configured
              ? `Jev provider saved globally as ${selected}; existing credential kept (${status.keyOrigin}).`
              : `Jev provider saved globally as ${selected}, but no credential exists yet. Run /jev setup ${selected} again to add one.`,
            status.configured ? "info" : "warning"
          );
        }
        return;
      }

      if (sub === "provider") {
        const arg = rest.trim().toLowerCase();
        if (!arg) {
          const status = providerStatus(jevClient);
          ctx.ui.notify(
            `Jev provider: ${status.preference} → ${providerLabel(status)}\n` +
              `Credential: ${status.keyOrigin ?? "not configured"}\n` +
              `Changes are saved globally in jev.json. JEV_PROVIDER / PI_JEV_PROVIDER can override them after restart.`,
            status.configured ? "info" : "warning"
          );
          return;
        }

        if (arg !== "auto" && arg !== "typesafe" && arg !== "vercel") {
          ctx.ui.notify(
            `Unknown Jev provider "${rest}". Use /jev provider auto|typesafe|vercel.`,
            "warning"
          );
          return;
        }

        const client = jevClient as any;
        if (typeof client.setProvider !== "function") {
          ctx.ui.notify("This pi-jev build does not support provider switching.", "error");
          return;
        }

        client.setProvider(arg as JevProviderPreference);
        try {
          client.persistProvider(arg as JevProviderPreference);
        } catch (err: any) {
          ctx.ui.notify(
            `Jev provider set to ${arg} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
          return;
        }
        const status = providerStatus(jevClient);
        ctx.ui.notify(
          (status.configured
            ? `Jev provider saved globally as ${arg}: ${providerLabel(status)} (${status.keyOrigin}).`
            : `Jev provider saved globally as ${arg}, but it is not configured: ${status.error ?? "missing credential"}`) +
            " JEV_PROVIDER / PI_JEV_PROVIDER can override this after restart.",
          status.configured ? "info" : "warning"
        );
        return;
      }

      if (sub === "test" || sub === "eval" || sub === "evaluate") {
        const status = providerStatus(jevClient);
        if (!status.configured) {
          ctx.ui.notify(
            "Cannot run evaluation: no Jev provider credential. " +
              "Configure ~/.pi/agent/jev.json, set TYPESAFE_API_KEY / AI_GATEWAY_API_KEY, " +
              "or use ~/.pi/agent/secrets/typesafe_api_key / ai_gateway_api_key.",
            "error"
          );
          return;
        }

        // With a prompt: the active model designs the evaluation. Without one: fixed smoke test.
        let request: JevEvaluationRequest;
        if (rest) {
          ctx.ui.notify(`Designing a Jev evaluation for: "${rest}"...`, "info");
          try {
            request = await designEvaluation(ctx, rest, ctx.signal);
          } catch (err: any) {
            ctx.ui.notify(`Could not design evaluation: ${err?.message || err}`, "error");
            return;
          }
          ctx.ui.notify(
            `Designed ${Object.keys(request.questions).length} question(s): ${Object.keys(request.questions).join(", ")}\nSending to ${providerLabel(status)}...`,
            "info"
          );
        } else {
          ctx.ui.notify(`Sending test evaluation request to ${providerLabel(status)}...`, "info");
          request = {
            state: { message: "Payment processing failed due to credit card expiration." },
            questions: {
              is_billing: {
                type: "noul" as const,
                instructions: "Is this message related to a billing issue?",
              },
              category: {
                type: "choice" as const,
                instructions: "Which category does this issue fall into?",
                criteria: {
                  billing: "Billing, invoices, card issues",
                  bug: "Software bug or crash",
                  other: "General questions",
                },
              },
            },
          };
        }

        try {
          const res = await jevClient.evaluate(request);

          ctx.ui.notify(
            (rest ? `Jev Evaluation (${res.elapsedMs}ms):\n` : `Jev Test Successful (${res.elapsedMs}ms):\n`) +
              Object.entries(res.answers)
                .map(([id, ans]) => {
                  const value =
                    ans.type === "noul"
                      ? `${ans.value}${typeof ans.value === "number" ? ` (${(ans.value * 100).toFixed(0)}% yes)` : ""}`
                      : `${ans.value}${ans.confidence !== undefined ? ` (confidence: ${ans.confidence})` : ""}`;
                  return `• ${id}: ${value}`;
                })
                .join("\n"),
            "info"
          );
        } catch (err: any) {
          ctx.ui.notify(`Jev Evaluation Failed: ${err?.message || err}`, "error");
        }
        return;
      }

      if (sub === "skills" || sub === "skill") {
        const query = rest;
        if (!query) {
          const available = skillRouter.getAvailableSkills(ctx);
          ctx.ui.notify(
            `Available skills (${available.length}):\n` +
              available.map((s) => `• ${s.name}: ${s.description.slice(0, 80)}...`).join("\n"),
            "info"
          );
          return;
        }

        ctx.ui.notify(`Searching skills for: "${query}"...`, "info");
        const res = await skillRouter.findSkills(query, JEV_THRESHOLD, ctx);
        if (res.recommended.length === 0) {
          ctx.ui.notify(`No skills matched "${query}".`, "info");
          return;
        }

        ctx.ui.notify(
          `Matching skills for "${query}":\n` +
            res.recommended
              .map((r) => `• /skill:${r.name} (P=${r.probability.toFixed(2)}) - ${r.description}`)
              .join("\n") +
            (res.fallbackUsed
              ? "\n(Note: Jev unconfigured/offline — local keyword shortlist, probabilities are not Jev judgments)"
              : ""),
          res.fallbackUsed ? "warning" : "info"
        );
        return;
      }

      if (sub === "agents" || sub === "orchestrate") {
        if (!rest) {
          ctx.ui.notify("Usage: /jev agents <task>", "warning");
          return;
        }
        const result = await agentMode.dispatch(rest, ctx);
        if (!result.accepted) ctx.ui.notify(`Agent orchestration unavailable: ${result.error ?? "unknown error"}`, "warning");
        return;
      }

      if (sub === "tool-guard" || sub === "toolguard" || sub === "guard") {
        const arg = rest.toLowerCase();
        if (arg !== "" && arg !== "on" && arg !== "off") {
          ctx.ui.notify(`Unknown /jev tool-guard argument "${rest}". ${usage}`, "warning");
          return;
        }
        const enabled = arg === "on" ? true : arg === "off" ? false : !guardMode.enabled;
        guardMode.setEnabled(enabled);
        try {
          jevClient.persistFeature("toolGuard", enabled);
          ctx.ui.notify(
            `Jev tool guard ${enabled ? "enabled" : "disabled"} and saved globally.`,
            "info"
          );
        } catch (err: any) {
          ctx.ui.notify(
            `Jev tool guard ${enabled ? "enabled" : "disabled"} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
        }
        return;
      }

      if (sub === "compact") {
        const arg = rest.toLowerCase();
        if (arg !== "" && arg !== "on" && arg !== "off") {
          ctx.ui.notify(`Unknown /jev compact argument "${rest}". ${usage}`, "warning");
          return;
        }
        const enabled = arg === "on" ? true : arg === "off" ? false : !compactMode.enabled;
        compactMode.setEnabled(enabled);
        try {
          jevClient.persistFeature("compact", enabled);
          ctx.ui.notify(
            `Jev compaction ${enabled ? "enabled" : "disabled"} and saved globally. Use /compact to run it.`,
            "info"
          );
        } catch (err: any) {
          ctx.ui.notify(
            `Jev compaction ${enabled ? "enabled" : "disabled"} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
        }
        return;
      }

      if (sub === "auto-agents" || sub === "autoagents") {
        const arg = rest.toLowerCase();
        if (arg !== "" && arg !== "on" && arg !== "off") {
          ctx.ui.notify(`Unknown /jev auto-agents argument "${rest}". ${usage}`, "warning");
          return;
        }
        const enabled = arg === "on" ? true : arg === "off" ? false : !agentMode.enabled;
        agentMode.setEnabled(enabled);
        try {
          jevClient.persistFeature("autoAgents", enabled);
          ctx.ui.notify(
            `Automatic agent orchestration ${enabled ? "enabled" : "disabled"} and saved globally.`,
            "info"
          );
        } catch (err: any) {
          ctx.ui.notify(
            `Automatic agent orchestration ${enabled ? "enabled" : "disabled"} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
        }
        return;
      }

      if (sub === "auto-model" || sub === "automodel") {
        const arg = rest.toLowerCase();
        if (arg !== "" && arg !== "on" && arg !== "off") {
          ctx.ui.notify(`Unknown /jev auto-model argument "${rest}". ${usage}`, "warning");
          return;
        }
        const enabled = arg === "on" ? true : arg === "off" ? false : !modelMode.enabled;
        modelMode.setEnabled(enabled);
        try {
          jevClient.persistFeature("autoModel", enabled);
          ctx.ui.notify(
            `Jev auto-model mode ${enabled ? "enabled" : "disabled"} and saved globally.`,
            "info"
          );
        } catch (err: any) {
          ctx.ui.notify(
            `Jev auto-model mode ${enabled ? "enabled" : "disabled"} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
        }
        return;
      }

      if (sub === "auto") {
        const arg = rest.toLowerCase();
        if (arg !== "" && arg !== "on" && arg !== "off") {
          ctx.ui.notify(`Unknown /jev auto argument "${rest}". ${usage}`, "warning");
          return;
        }
        const enabled = arg === "on" ? true : arg === "off" ? false : !auto.enabled;
        auto.setEnabled(enabled);
        try {
          jevClient.persistFeature("auto", enabled);
          ctx.ui.notify(
            enabled
              ? "Jev auto mode enabled and saved globally: each prompt routes tools and suggests skills. Costs one Jev request per prompt."
              : "Jev auto mode disabled and saved globally.",
            "info"
          );
        } catch (err: any) {
          ctx.ui.notify(
            `Jev auto mode ${enabled ? "enabled" : "disabled"} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
        }
        return;
      }

      if (sub === "enable" || sub === "disable") {
        const enabled = sub === "enable";
        pi.setActiveTools(enabled
          ? [...new Set([...pi.getActiveTools(), ...JEV_TOOL_NAMES])]
          : pi.getActiveTools().filter((t) => !isJevTool(t)));
        try {
          jevClient.persistToolsEnabled(enabled);
          ctx.ui.notify(`Jev tools ${enabled ? "enabled" : "disabled"} and saved globally. Automatic feature switches are unchanged.`, "info");
        } catch (err: any) {
          ctx.ui.notify(
            `Jev tools ${enabled ? "enabled" : "disabled"} for this session, but global save failed: ${err?.message || err}`,
            "warning"
          );
        }
        return;
      }

      ctx.ui.notify(`Unknown command /jev ${sub}.\n${usage}`, "warning");
    },
  });
}
