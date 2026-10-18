# pi-taskmesh

**English** | [简体中文](README.zh-CN.md)

Task-aware, multi-model orchestration for Pi. Version **0.8.1** evolves the existing pi-jev-multi-provider extension: TaskMesh handles task decomposition, routing and execution coordination; Jev is an optional judgment backend and compatibility feature set.

The default path uses chat models already authenticated in Pi. **No Jev key is required.** This package does not register chat providers or include a subagent executor.

## Quick start

Install from GitHub:

```bash
pi-bolt install git:github.com/0x1f/pi-taskmesh
```

For upstream Pi, use `pi` instead of `pi-bolt`. Restart or `/reload`. This checkout is the implementation source; use `pi-bolt -e ./extensions/index.ts` to load it without installing it globally. Only install a revision after it has been published to the repository.

Provide a compatible `pi-subagents` extension with the `subagents:rpc:v1` protocol, authenticated Pi models, and the agents used by your plan (`scout`, `researcher`, `worker`, `reviewer`, `evidence-auditor`). Then:

```text
/taskmesh run Refactor the request parser, verify behavior, and independently review the diff
/taskmesh status
/taskmesh explain
```

Automatic delegation is off by default. To authorize it for future eligible prompts:

```text
/taskmesh on
Please inspect this project and implement the requested change with verification and review.
/taskmesh resume
/taskmesh off
```

`on` persists the user's opt-in globally across projects and sessions. It authorizes decomposition and child execution for eligible tasks. A model's `team` classification is only a suitability decision; it does not create permission for destructive actions or remote changes. Requests forbidding delegation take priority. `off` stops future automatic delegation; existing work continues and explicit `run` remains available.

## Commands and configuration

| Command | Behavior |
| --- | --- |
| `/taskmesh on`, `/taskmesh off` | Save the global automatic-delegation preference. |
| `/taskmesh backend [pi\|jev]` | Show or switch the judgment backend; save globally and apply immediately to subsequent judgments. |
| `/taskmesh run <task>` | Explicitly authorize and start one workflow while the main agent is idle. |
| `/taskmesh status` | Show configuration and query the current native run, if any. |
| `/taskmesh explain` | Show the last decision, task graph, models, selection basis and launch state. |
| `/taskmesh resume` | Reconnect to the existing schedule and inspect status without launching another graph. |
| `/taskmesh help` | Show command usage. |

Global settings live in `~/.pi/agent/taskmesh.json`, or `$PI_CODING_AGENT_DIR/taskmesh.json`. Defaults:

```json
{
  "enabled": false,
  "decisionBackend": "pi",
  "maxConcurrency": 3
}
```

`maxConcurrency` is the number of concurrent read tasks, from 1 to 3. Writers run exclusively. Use `/taskmesh backend jev` only after configuring Jev, or `/taskmesh backend pi` to return to Pi judgments. Backend commands apply immediately without changing the automatic-delegation switch; direct file edits require a reload. Command saves are atomic, preserve unrelated fields, and report errors; invalid settings disable automatic delegation until repaired.

Use `PI_TASKMESH=1` or `--taskmesh` for a startup opt-in; `PI_TASKMESH=off` overrides a saved default after restarting. Old `jev.json.features.autoAgents`, `PI_JEV_AGENTS` and `--jev-agents` no longer initialize the new core. The interactive `/jev auto-agents on|off` compatibility command still saves the TaskMesh preference. Automatic orchestration is independent of `/jev auto` and `/jev auto-model`. Concurrent config saves use last-writer-wins; atomic replacement prevents partial files, not simultaneous-update loss.

### Use Jev for orchestration judgments

In Pi, configure Jev with `/jev setup typesafe` or `/jev setup vercel`, then check `/jev status`. Switch and inspect the backend in the same session:

```text
/taskmesh backend jev
/taskmesh backend
```

The selection is saved globally and takes effect on subsequent judgments without a reload. Use `/taskmesh backend pi` to return to Pi judgments. Enable automatic orchestration with `/taskmesh on`, or disable it with `/taskmesh off`; switching backend leaves that preference and existing work unchanged.

Jev judges whether an eligible request should be delegated and selects models for individual tasks. Pi chat models still produce the task plan, and native `pi-subagents` executes the children. `/jev agents <task>` uses the same TaskMesh backend as `/taskmesh run <task>`. No separate Jev setup is needed in each child. Selecting this backend does not enable Jev tool routing, tool guards or compaction. Jev judgments and Pi model calls may incur charges.

## Decisions, model routing and execution

1. Eligible text input is classified as `solo`, `team`, `resume` or `uncertain`. Simple/uncertain input normally continues to the main agent; uncertainty during an active run shows its status. Current delegation refusals bypass the classifier for common Chinese/English phrasing. Images, generic extension messages and streaming follow-ups keep their normal path. Native Goal checkpoints use the guarded tool path below.
2. Pi plans **1–6 validated tasks** using the current request, up to 10,000 characters of recent public conversation and up to 6,000 characters of recent goals. Thinking and tool-result blocks are excluded. Dependencies must exist, the graph must be acyclic, and every writer needs a later review depending on it.
3. Each task gets an explicit `provider/model` from authenticated models inside the session's scope, checked against its estimated context requirement. A Pi JSON judgment (or optional Jev choice judgment) compares up to 16 candidates per task using requirements, reasoning/context metadata, load and reported outcomes. If routing judgment fails, metadata/load scoring selects an eligible model. These are estimates, **not measured coding benchmarks**. Review model diversity is encouraged when suitable; a distinct model is not guaranteed.
4. The generated script runs through native `pi-subagents`. Readers can run in parallel, workers run exclusively in the shared cwd, and dependency outputs reach later tasks. Read-only task instructions are advisory; enforce filesystem permissions or sandboxing separately when needed. Children receive bounded context rather than a full session fork.
5. A reported failure cools down that exact `provider/model`. Incomplete streams such as `Antigravity: the reply ended before it was complete` are classified as `incomplete-stream` and cool down that model for 60 seconds. Other models behind the same gateway remain eligible. Runtime completion/failure counts are not quality scores and reset on session reload.

Each pure Pi inference tries at most two models with a 30-second limit per attempt. Planning and model selection happen before child launch. There is **no automatic replay of child work or a launch with an unknown outcome**. A missing spawn reply is retained with its request ID and blocks another workflow until authoritative native status or completion resolves it. Legacy `jev-orchestration` session entries still restore; new entries use `taskmesh-orchestration`.

Native `pi-subagents` owns child execution, completion notification and result delivery. `resume` inspects/reconnects; it does not restart failed/paused workflows or relaunch unfinished side effects. Retained-child continuation requires the native executor's explicit controls. Without a compatible executor, the capability check fails after about 10 seconds and no child is launched.

Automatic mode can make a paid Pi judgment even for requests ultimately kept solo. A delegated request normally adds assessment, planning and model-selection calls, followed by child calls; bounded model retries and enabled Jev features can add cost. There is no spending cap or live capability benchmark.

### Continuing after completion or failure

When automatic judgment classifies a message such as `continue` as `resume`, an active/paused/unknown workflow shows its concise status. For a terminal workflow, the original message proceeds to the main agent with a hidden handoff identifying the retained run, failure/task/model when available, and saved-result paths. The main agent can inspect the evidence and continue the authorized parent task. A completed workflow does not by itself establish that the parent's goal is satisfied. An explicit `/taskmesh resume` remains a status command; it never retries children.

### Native Goal checkpoints

With `/taskmesh on`, a version-3 checkpoint from a compatible `pi-goal-x` uses the same saved Pi/Jev decision backend. TaskMesh adds a model-only `taskmesh_goal` tool instead of treating arbitrary extension messages as user authorization. It verifies the live Goal ID, owner session, generation, dispatch ID, active status and automatic-continuation preference through `get_goal`, then asks the normal decision/planning path whether delegation is suitable.

**Existing unfinished Goals work without recreation or migration.** Reload the extension at a safe point; the next native checkpoint reads the same Goal ID, completed task evidence, current task and accumulated usage. TaskMesh passes the current task and existing progress to planning; it does not reset them or rerun completed steps on its own. A paused Goal still needs the user to resume it through Goal\'s normal controls; a completed Goal is not reopened. The wait-policy and budget restrictions below also apply to existing Goals.

`taskmesh_goal` must be a **standalone direct model tool call**, not `tools.taskmesh_goal()` inside `codemode` and not a slash command. Its model-only exposure deliberately excludes it from `ALL_TOOLS` and codemode discovery, preserving native end-turn/wait semantics. The tested Pi-Bolt declares it directly in both codemode `on` and `only` modes. If it is missing from the model\'s declared tools, reload/check the extension rather than inventing a nested or shell fallback. Version 0.8.1 also corrects the native `ctx.executeTool` result envelope; 0.8.0 could incorrectly reject a valid existing Goal as stale.

Before any child launch, `update_goal` must accept a native `wait` disposition and return its wait token. In the tested Goal 0.32.3, new waits require the existing `strictExecutionContract` opt-in, which defaults to `false`. To opt into that Goal policy, merge this existing setting into the project's `.pi/pi-goal-x-settings.json` or the global `~/.pi/agent/pi-goal-x-settings.json`:

```json
{
  "strictExecutionContract": true
}
```

This also changes Goal's continuation contract outside TaskMesh. TaskMesh does not change it automatically. If the wait is refused, Goal remains with the main agent and no child is launched; assessment/planning calls can still incur cost before that refusal.

The wait token is persisted before spawning. The outer Goal tool ends the parent turn only after Goal grants the wait. Native completion delivery resumes the parent; where no native turn was accepted, TaskMesh emits Goal's token-checked wake event. The wait has a one-hour deadline handled by Goal's policy. A known pre-launch rejection releases the wait; an unknown launch stays retained and is never replayed. Later checkpoints reuse the Goal's recorded workflow, including after switching Goals or reloading the session branch.

Goals with a defined `tokenBudget` stay with the main agent because this adapter cannot charge and bound child spending against Goal's lifetime cap. Native autonomous-run limits and pause state also remain authoritative. Without native nested-tool support or a matching live checkpoint, the tool declines delegation.

## Jev compatibility commands

Jev tools and automatic features are inactive by default. Existing explicit preferences are preserved. To use them, configure a provider with `/jev setup`, inspect `/jev status`, and enable the three tools with `/jev enable`. `/jev test` sends a real example and may incur charges. Keys entered in `ctx.ui.input()` may be visible; never put keys in chat or slash-command arguments.

| Command | Purpose |
| --- | --- |
| `/jev setup [auto\|typesafe\|vercel]` | Save provider selection and optionally credentials. |
| `/jev provider [auto\|typesafe\|vercel]` | Inspect/change the global provider preference. |
| `/jev enable`, `/jev disable` | Save Jev tool activation; unrelated tools are preserved. |
| `/jev test [prompt]` | Paid connectivity/evaluation test; a prompt also uses a Pi model. |
| `/jev skills [query]` | List or find existing skills. |
| `/jev auto [on\|off]` | Jev tool/skill routing. |
| `/jev auto-model [on\|off]` | Local main-model selection, independent of orchestration. |
| `/jev tool-guard [on\|off]`, `/jev compact [on\|off]` | Optional argument checks/history excerpts. |
| `/jev auto-agents [on\|off]` | Compatibility switch for TaskMesh automatic delegation. |
| `/jev agents <task>` | Compatibility explicit workflow command. |
| `/jev schedule explain`, `/jev schedule status` | Compatibility schedule diagnostics. |

Legacy feature commands without `on`/`off` toggle; use `/jev status` to inspect them. Settings remain in `jev.json`, except TaskMesh's independent preference. `/jev disable` only hides Jev tools; turn off automatic features separately. Old environment variables `PI_JEV_AUTO`, `PI_JEV_AUTO_MODEL`, `PI_JEV_TOOL_GUARD`, `PI_JEV_COMPACT` and matching `--jev-*` flags still override saved startup defaults. Boolean values accept `1/true/yes/on` and `0/false/no/off`.

The TypeSafe SDK is an optional, lazily imported dependency. The default Pi backend works without it. Jev transport choice does not automatically change after a failed request.

## Optional Jev: providers, configuration and tools

| Selection | Default model | Credential environment variable | Transport |
| --- | --- | --- | --- |
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` | `systemOne()` from `@typesafe-ai/sdk` |
| `vercel` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | Native `fetch()` using the Gateway evaluation-model protocol |
| `auto` | Depends on the selected provider | Either variable or another credential source | TypeSafe when its credentials exist; otherwise Vercel |

With no credentials, Jev is unconfigured. If an explicitly selected provider lacks credentials, or a provider chosen by `auto` fails a request, **the client does not automatically switch providers**.

### Global configuration and secret files

Default paths are shown below. Set `PI_CODING_AGENT_DIR` to change this extension's configuration root.

```text
~/.pi/agent/
├── jev.json
└── secrets/
    ├── typesafe_api_key
    └── ai_gateway_api_key
```

Vercel also accepts `secrets/vercel_ai_gateway_api_key`; `ai_gateway_api_key` takes precedence.

Keep keys in separate files and use `jev.json` for preferences and feature switches. This example **explicitly enables automatic routing**; it is not the factory default:

```json
{
  "provider": "vercel",
  "features": {
    "auto": true,
    "autoModel": false,
    "toolGuard": false,
    "compact": false,
    "autoAgents": false
  }
}
```

JSON credentials at `typesafe.apiKey` / `vercel.apiKey` are also supported. Separate secret files simplify permissions and backup management, but both options are **local plaintext storage**.

### Environment variables

Choose one provider in the shell used to start Pi. These keys are placeholders; supply real credentials through `/jev setup` or a trusted credential manager rather than writing them into shell history.

```bash
export JEV_PROVIDER=vercel
export AI_GATEWAY_API_KEY="YOUR_VERCEL_KEY"
```

```bash
export JEV_PROVIDER=typesafe
export TYPESAFE_API_KEY="YOUR_TYPESAFE_KEY"
```

Provider selection precedence:

1. The current `JevClient` session override, set by `/jev provider` or when `/jev setup` saves a choice.
2. `JEV_PROVIDER`, or the compatibility alias `PI_JEV_PROVIDER` when the former is unset.
3. `provider` in the global `jev.json`.
4. `auto`.

Credential precedence within each provider: **session key → environment variable → `jev.json` → secret file**.

A key saved by `/jev setup` takes precedence in the current session. After restarting, an old environment variable or JSON key can override that secret file. Check the credential source in `/jev status`. Environment variables also override the saved provider preference after restarting.

### Model and endpoint overrides

Merge these fields into `jev.json` without overwriting feature switches you want to keep:

```json
{
  "provider": "vercel",
  "vercel": {
    "model": "typesafe-ai/jev",
    "baseURL": "https://ai-gateway.vercel.sh/v4/ai"
  },
  "typesafe": {
    "model": "jev-latest"
  }
}
```

- Model precedence: request-level `model` → provider-specific JSON `model` → default model.
- TypeSafe endpoint: `TYPESAFE_BASE_URL` → `typesafe.baseURL` → SDK default.
- Vercel endpoint: `JEV_VERCEL_BASE_URL` → `vercel.baseURL` → `https://ai-gateway.vercel.sh/v4/ai`.
- Vercel appends `/evaluation-model` to the root URL; do not include that suffix twice. This is not an OpenAI Chat Completions endpoint.
- Default model names are normalized between the two protocols. Custom model availability depends on the service.
- `/jev status` currently displays the provider's default model, not necessarily a JSON or request-level override.

Only use trusted endpoints: request content and authentication credentials are sent to the configured address.

## Three tools

| Tool | Behavior |
| --- | --- |
| `jev_find_tools` | Shortlists registered but inactive tools, evaluates them with Jev, and activates matches additively. It does not install tools or remove currently active ones. |
| `jev_find_skill` | Recommends skills already discovered by Pi and their paths. It does not execute skills; read the `SKILL.md` or invoke the corresponding skill command. |
| `jev_evaluate` | Submits `choice`, `noul`, or `score` questions about a `state` and returns structured judgments rather than free-form text. |

The default tool/skill threshold is the source constant `JEV_THRESHOLD = 0.65`, not an environment variable. Manual tool calls can override it with `threshold`.

Example arguments for `jev_evaluate`:

```json
{
  "state": {
    "message": "Payment failed because the card expired."
  },
  "questions": {
    "is_billing": {
      "type": "noul",
      "instructions": "Is this a billing issue?"
    },
    "category": {
      "type": "choice",
      "instructions": "Classify the issue.",
      "criteria": {
        "billing": "Payments, invoices, or cards",
        "bug": "Software malfunction",
        "other": "Other requests"
      }
    }
  }
}
```

`noul` represents a yes/no probability. `choice` uses an object mapping option keys to descriptions for `criteria`; `score` uses an array of rubric-level strings. Answers contain `type` and `value`, with fields such as `confidence` / `distribution` when provided by the service. Model probabilities are not proof of facts or permission grants.

### Routing limitations

Local keyword shortlisting happens before Jev evaluation: at most **10 tools** and **12 skills** are considered. Keywords are split using ASCII letters and digits. A Chinese-only query may therefore select the first few directory entries; relevant tools outside the shortlist will not be evaluated. Including tool names or English technical keywords can help.

When unconfigured or offline, manual tool routing does not activate candidates. Skill lookup may return keyword matches marked as fallback with probability `0`; these are not valid Jev probabilities. Automatic routing is skipped entirely when unconfigured.

### Tool guard and compaction

- Tool guard evaluates only the tool name and arguments, not actual filesystem existence. It blocks calls when the probability of fabricated parameters reaches `0.85`. Evaluation errors **fail open**, so it cannot replace sandboxing, permissions, or deterministic validation.
- Compaction currently considers the **first 24** `branchEntries`, serializes and truncates each to **900 characters**, and uses a retention threshold of `0.55`. This is a bounded excerpt, not a complete semantic summary. Use it cautiously in long sessions to avoid losing important context.

### Gate CLI

The package declares `pi-jev-gate` and `jev-gate` bins. They evaluate whether supplied text, a file, or a diff meets a criterion, with a default passing probability of `0.7`. They do not run tests or prove test success through a model probability.

**Current packaging limitation:** `bin/jev-gate.js` always launches with `node --import tsx`, but `package.json` does not declare `tsx`. Do not assume the CLI works in a fresh installation. To use it from a source checkout, explicitly prepare the loader:

```bash
npm install
npm install --no-save --package-lock=false tsx
node ./bin/jev-gate.js --help
node ./bin/jev-gate.js --criteria "The supplied text explains installation and configuration." --file README.md --json
```

The last command sends the file content to the selected Jev service. Inputs include `--diff` (`git diff HEAD`, excluding untracked files), `--file`, and stdin. Normal evaluations exit `0` when passing and `1` when failing; configuration/API and other errors caught by the runner exit `2`. `--fail-open` turns caught errors into successful exits and is unsuitable for mandatory acceptance checks. Launcher failures should not be treated as valid judgments.

The CLI creates its own `JevClient`, reading environment variables and global configuration. It reads a successfully saved `/jev provider` choice, but does not inherit another Pi process's in-memory overrides.

## Source and verification

| Path | Responsibility |
| --- | --- |
| [extensions/index.ts](extensions/index.ts) | Integration, hooks and compatibility features. |
| [src/taskmesh-config.ts](src/taskmesh-config.ts), [src/taskmesh-commands.ts](src/taskmesh-commands.ts) | Independent settings and commands. |
| [src/decision-backend.ts](src/decision-backend.ts) | Pi/optional Jev decisions, validated JSON and bounded pure inference. |
| [src/task-planner.ts](src/task-planner.ts), [src/capability-router.ts](src/capability-router.ts) | Context, DAG validation and scoped model assignment. |
| [src/orchestrator.ts](src/orchestrator.ts) | Native scripts, RPC correlation, state restoration and duplicate protection. |
| [src/goal-bridge.ts](src/goal-bridge.ts) | Live Goal checkpoint validation, native wait and guarded delegation. |
| [src/jev.ts](src/jev.ts) | Legacy provider/credential resolution and optional Jev transports. |

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:native  # requires the installed compatible pi-subagents package
npm run test:goal    # requires compatible pi-goal-x and Node with module.registerHooks
npm run test:host    # requires pi-bolt; actual tool dispatch with synthetic model/Goal/executor
npm run smoke        # requires pi-bolt; private offline startup only
```

The lockfile fixes development dependencies, including Pi SDK 0.85.0; typechecking against that SDK does not establish support for every Pi version. The extension declares Node >=20.3; the host may require a newer Node. The native workflow test accepts a package directory as its first argument or `PI_SUBAGENTS_DIR`; the Goal test accepts `PI_GOAL_DIR` or its first argument. The Goal test uses the installed scheduler/runtime with a synthetic store and fake executor, including default-policy refusal, accepted wait, early/late completion, wrong tokens, native-notification takeover and budget/allowance refusal.

The host tool test runs both codemode modes with synthetic streamed tool calls, exercises native nested-tool result envelopes and outer wait termination, and includes codemode misuse and rejected-tool negative controls. The native Goal tests also retain pre-existing completed tasks, current-task focus, token/time usage and autonomous-run accounting. Neither test opens or edits a real Goal.

Verification uses synthetic data, fake model/executor responses, fresh-process settings checks, the installed native workflow validator/sandbox with local fake children, and an actual Pi-Bolt load in a private offline config. Smoke blocks network requests and makes no model calls. Runtime regressions and actual host startup were also verified with the optional TypeSafe SDK physically absent. `typecheck` still excludes the legacy Gate runner. These checks establish local contracts; they do not prove live provider compatibility, model quality or paid end-to-end child execution.
