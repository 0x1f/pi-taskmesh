# pi-jev-multi-provider

**English** | [简体中文](README.zh-CN.md)

Jev System One structured judgments, tool routing, and skill recommendations for the [Pi coding agent](https://github.com/earendil-works/pi), with **TypeSafe Direct** and **Vercel AI Gateway** transports.

Maintained by `0x1f`. Current package version: **0.5.2**.

> “Multi-provider” means choosing the service used for Jev evaluations. This extension does not register two general-purpose chat models in Pi. `auto` selects a provider by available credentials; it does not fail over after a request fails.

## Quick start

### 1. Install

You need Pi, Git, and a Node.js version supported by your Pi installation. This extension declares Node.js `>=20`; Pi itself may require a newer version. Development dependencies target Pi `^0.85.0`, which does not imply compatibility with every Pi release.

```bash
pi install git:github.com/0x1f/pi-jev-multi-provider
```

Restart Pi after installation, or try `/reload` in an existing session. To pin a revision, use `git:github.com/0x1f/pi-jev-multi-provider@<commit>`, replacing `<commit>` with an actual commit SHA.

If you installed an older repository version, run `pi list`, remove its exact source entry, and install this repository. Old installation URLs are not migrated automatically. Check for other enabled Jev routers to avoid duplicate tools and automatic requests. **Do not remove unrelated extensions.**

### 2. Configure inside Pi

```text
/jev setup
```

Choose `Vercel AI Gateway`, `TypeSafe Direct`, or `Auto-detect`. You can also specify the provider directly:

```text
/jev setup vercel
/jev setup typesafe
/jev setup auto
```

- `vercel` / `typesafe` prompt for a key. Leave it blank to keep existing credentials, or cancel to exit.
- `auto` only saves the provider preference; it does not request or generate a key.
- The provider preference is saved in the global `jev.json`; keys go into the corresponding secret files. The code sets `0600` permissions, with best-effort handling on filesystems without POSIX modes.
- Key entry uses ordinary `ctx.ui.input()`. Do not assume the input is masked; avoid entering keys while recording or sharing your terminal, and do not put keys in chat messages or slash-command arguments.

### 3. Check configuration and connectivity

```text
/jev status
/jev test
```

`status` checks configuration and session statistics; it is **not a network test**. `test` sends a fixed example to the selected Jev service and may incur charges. Once configured, the three Jev tools can be used on demand. All five automatic/auxiliary features are off by default.

## Providers and configuration

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

## Commands and feature switches

| Command | Purpose / persistence |
| --- | --- |
| `/jev`, `/jev status` | Show provider, credential source, feature status, and successful-request statistics. |
| `/jev setup [auto\|typesafe\|vercel]` | Interactive setup saved globally. |
| `/jev provider [auto\|typesafe\|vercel]` | Inspect or switch the provider; changes are saved globally. |
| `/jev test` | Send a fixed example to Jev. |
| `/jev test <prompt>` | Ask Pi's current chat model to design questions, then call Jev. Both need credentials and may incur charges. |
| `/jev skills [query]` | List skills without a query, or find matching skills with one. |
| `/jev enable`, `/jev disable` | Change only the three Jev tools' activation state and save globally. |
| `/jev auto [on\|off]` | Route tools and recommend skills before each prompt. |
| `/jev auto-model [on\|off]` | Select a Pi chat model with local rules, not a Jev model-selection judgment. |
| `/jev tool-guard [on\|off]` | Use Jev to detect apparently fabricated tool arguments and classify tool errors. |
| `/jev compact [on\|off]` | Supply Jev-selected history excerpts during Pi context compaction. |
| `/jev auto-agents [on\|off]` | Toggle automatic agent orchestration. |
| `/jev agents <task>` | Explicitly dispatch a workflow through compatible `pi-subagents`. |
| `/jev help` | Show built-in command help. |

Calling one of the five feature-switch commands without `on` or `off` **toggles it**; it does not query its state. Changes apply immediately and are saved as global defaults for future sessions/projects. If saving fails, a warning is shown and the session change still applies.

`/jev provider` and `/jev enable` / `/jev disable` now persist immediately too. Tool activation is stored as `toolsEnabled` in `jev.json` and restored on startup/reload, even without credentials; unrelated tools and automatic feature switches are unchanged. Without a saved `toolsEnabled`, Pi's initial tool selection is preserved. Preferences are global, not per-project. Existing environment overrides still take precedence after restarting.

| JSON field | Environment variable | Startup flag |
| --- | --- | --- |
| `features.auto` | `PI_JEV_AUTO` | `--jev-auto` |
| `features.autoModel` | `PI_JEV_AUTO_MODEL` | `--jev-auto-model` |
| `features.toolGuard` | `PI_JEV_TOOL_GUARD` | `--jev-tool-guard` |
| `features.compact` | `PI_JEV_COMPACT` | `--jev-compact` |
| `features.autoAgents` | `PI_JEV_AGENTS` | `--jev-agents` |

Unset switches default to `false`. Environment variables accept `1/true/yes/on` and `0/false/no/off`, overriding saved startup defaults. Pi's corresponding CLI flags can further override startup values.

**Automatic model selection and automatic agent orchestration currently run inside the `auto` event entrypoint, so they also require `/jev auto on`.** Explicit `/jev agents <task>` does not require `auto` or `auto-agents` to be enabled.

Automatic routing evaluates tools and skills separately. When both have candidates, this makes **2 Jev calls**, not a fixed one call per prompt. Tool guard, orchestration, and compaction may add further requests.

If you already have a permission system or dedicated compactor, start with:

```text
/jev enable
/jev auto on
/jev auto-model off
/jev tool-guard off
/jev compact off
/jev auto-agents off
```

`/jev disable` **is not a master off switch** and does not disable event hooks. Set all five feature switches above to `off` to stop those automatic features. To unload the extension entirely, use `pi remove` and restart Pi.

## Optional integrations and limitations

### Agent orchestration

Integration uses the `subagents:rpc:v1:request` event protocol with a compatible `pi-subagents` extension. This package **does not include a subagent executor**. Depending on the workflow, provide agent definitions such as `scout`, `worker`, `reviewer`, `researcher`, and `evidence-auditor`. Without a compatible listener, dispatch times out after about 10 seconds.

Jev selects an implementation / research / review / general workflow, falling back to local keyword classification when unavailable. Requests targeting `agent: "jev"` / `"typesafe-jev"` perform structured judgments; they are not general-purpose coding agents.

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

## Code structure

| Path | Responsibility |
| --- | --- |
| [`extensions/index.ts`](extensions/index.ts) | Tools, commands, startup flags, and lifecycle hooks. |
| [`src/jev.ts`](src/jev.ts) | Provider/credential resolution, global configuration, transports, and response normalization. |
| [`src/router.ts`](src/router.ts), [`src/skills.ts`](src/skills.ts), [`src/auto.ts`](src/auto.ts) | Shortlisting, additive activation, skill recommendations, and automatic dispatch. |
| [`src/tools.ts`](src/tools.ts), [`src/commands.ts`](src/commands.ts) | Tool parameters and `/jev` commands. |
| [`src/designer.ts`](src/designer.ts) | Evaluation design using the current Pi model. |
| [`src/model-router.ts`](src/model-router.ts) | Local model selection and temporary avoidance after some HTTP errors. |
| [`src/agent.ts`](src/agent.ts), [`src/orchestrator.ts`](src/orchestrator.ts) | Jev agent RPC and multi-agent workflows. |
| [`src/tool-guard.ts`](src/tool-guard.ts), [`src/compact.ts`](src/compact.ts) | Optional argument checks and bounded history compaction. |
| [`src/gate.ts`](src/gate.ts), [`bin/jev-gate.js`](bin/jev-gate.js) | Evaluation-based gate CLI and launcher. |

## Development and verification scope

```bash
git clone https://github.com/0x1f/pi-jev-multi-provider.git
cd pi-jev-multi-provider
npm install
npm run typecheck
npm test
```

The package also has `npm run smoke`, which starts Pi and submits a prompt. It may use local model credentials, make network requests, and incur charges; it is not an offline unit test. `typecheck` currently excludes `bin/jev-gate-runner.ts`. `npm test` runs offline persistence regressions in fresh child processes with a temporary config directory and no real credentials. No dependency lockfile is included.

This documentation was checked against source code, not certified through live TypeSafe/Vercel compatibility or security testing. No paid inference, `smoke`, or orchestration tasks were run for this documentation update. Validate your chosen Pi version and provider in a controlled environment before deployment.
