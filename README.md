# pi-jev-multi-provider

A multi-provider fork of [`TheoOliveira/pi-jev`](https://github.com/TheoOliveira/pi-jev) for the Pi coding agent.

It keeps the full `pi-jev` System One feature set while allowing the same Jev client to use either:

- **Vercel AI Gateway** — `typesafe-ai/jev`
- **TypeSafe Direct** — `jev-latest`
- **auto** — prefers TypeSafe Direct when both credentials exist, otherwise Vercel

No second router plugin is required. The selected provider powers the same `JevClient.evaluate()` path used by tool routing, skill discovery, typed judgments, Jev subagents, orchestration, tool guard, compaction, and gate checks.

## Install

```bash
pi install git:github.com/0xlf/pi-jev-multi-provider
```

If another Jev router is installed, remove it first to avoid overlapping automation:

```bash
pi remove npm:pi-jev-router
pi remove npm:pi-typesafe-router
pi remove git:github.com/0x1f/pi-goal-x-jev-gate
```

Only remove packages that are actually present on your system.

## Pi global configuration (recommended)

You can configure the plugin globally without shell `export` statements.

Create:

```text
~/.pi/agent/jev.json
```

For Vercel:

```json
{
  "provider": "vercel",
  "vercel": {
    "apiKey": "your_vercel_ai_gateway_key"
  }
}
```

For TypeSafe Direct:

```json
{
  "provider": "typesafe",
  "typesafe": {
    "apiKey": "ts_..."
  }
}
```

Or keep the key outside the JSON and only persist the provider:

```json
{
  "provider": "vercel"
}
```

with:

```text
~/.pi/agent/secrets/ai_gateway_api_key
```

This is the recommended layout for secrets.

The plugin also supports optional provider-specific overrides:

```json
{
  "provider": "vercel",
  "vercel": {
    "apiKey": "...",
    "model": "typesafe-ai/jev",
    "baseURL": "https://ai-gateway.vercel.sh/v4/ai"
  },
  "typesafe": {
    "apiKey": "ts_...",
    "model": "jev-latest",
    "baseURL": "https://api.typesafe.ai"
  }
}
```

Provider selection precedence is:

1. runtime `/jev provider ...`
2. `JEV_PROVIDER` / `PI_JEV_PROVIDER`
3. `~/.pi/agent/jev.json`
4. `auto`

Credential precedence is:

1. in-session credential
2. environment variable
3. `~/.pi/agent/jev.json`
4. Pi Jev secret file

## Provider setup

### Vercel AI Gateway

```bash
export JEV_PROVIDER=vercel
export AI_GATEWAY_API_KEY="your_vercel_ai_gateway_key"
```

The Vercel transport uses:

```text
https://ai-gateway.vercel.sh/v4/ai/evaluation-model
model: typesafe-ai/jev
```

### TypeSafe Direct

```bash
export JEV_PROVIDER=typesafe
export TYPESAFE_API_KEY="ts_..."
```

### Auto

```bash
export JEV_PROVIDER=auto
```

Resolution order in `auto` mode:

1. TypeSafe Direct if a TypeSafe credential is available.
2. Vercel AI Gateway if a Vercel credential is available.
3. Unconfigured if neither credential exists.

`PI_JEV_PROVIDER` is also accepted as a compatibility alias for `JEV_PROVIDER`.

## Secret files

Instead of environment variables you can use Pi's secret directory:

```bash
mkdir -p ~/.pi/agent/secrets
printf '%s\n' 'ts_...' > ~/.pi/agent/secrets/typesafe_api_key
printf '%s\n' 'your_vercel_key' > ~/.pi/agent/secrets/ai_gateway_api_key
chmod 600 ~/.pi/agent/secrets/typesafe_api_key ~/.pi/agent/secrets/ai_gateway_api_key
```

For Vercel, `~/.pi/agent/secrets/vercel_ai_gateway_api_key` is also recognized.

## Runtime provider switching

Inside Pi:

```text
/jev provider
/jev provider vercel
/jev provider typesafe
/jev provider auto
/jev status
/jev test
```

The `/jev provider ...` command changes the provider for the current Pi session. Use `~/.pi/agent/jev.json` to persist the choice without shell environment variables, or set `JEV_PROVIDER` if you prefer environment-based configuration.

## Full Jev feature set

This fork retains the upstream features:

- `jev_find_tools` semantic tool routing
- `jev_find_skill` skill discovery
- `jev_evaluate` typed Choice / Noul / Score judgments
- `/jev auto` per-prompt tool and skill routing
- `/jev auto-model` local model-profile routing
- `/jev tool-guard` Jev tool validation
- `/jev compact` Jev-assisted compaction
- `agent: "jev"` typed Jev subagent support for `pi-subagents`
- `/jev agents <task>` orchestration
- `pi-jev-gate` / `jev-gate` CLI gate checks

All Jev-backed judgment paths use the currently selected provider.

## Recommended setup with a larger Pi stack

If you already use a deterministic permission system and a dedicated compactor, a clean starting point is:

```text
/jev enable
/jev auto on
/jev auto-model off
/jev tool-guard off
/jev compact off
/jev auto-agents off
```

Then use Jev primarily for semantic tool/skill routing, typed decisions, and on-demand agent orchestration.

## Vercel protocol notes

The Vercel transport talks directly to the AI Gateway evaluation-model protocol and adds no `ai` SDK dependency.

It maps upstream Jev types as follows:

- Jev `noul` -> Vercel `boolean`
- Vercel boolean `probability` -> Jev `noul`
- Choice/Score `probabilities` -> `distribution`
- `providerMetadata.typesafe.confidence` -> Jev answer confidence

Gateway error bodies are redacted before being surfaced if they contain the configured API key.

For testing or a compatible proxy, override the gateway root with:

```bash
export JEV_VERCEL_BASE_URL="https://ai-gateway.vercel.sh/v4/ai"
```

## Development

```bash
npm install
npm run typecheck
```

## Upstream

This repository is based on `TheoOliveira/pi-jev` 0.5.0 and retains the upstream MIT license and core implementation. Multi-provider transport and runtime provider switching were added in this fork.

## License

MIT. See `LICENSE`.
