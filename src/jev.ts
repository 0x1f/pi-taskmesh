import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevSessionStats,
  QuestionConfig,
} from "./types.js";

export type JevProvider = "typesafe" | "vercel";
export type JevProviderPreference = JevProvider | "auto";
export type ApiKeySource = "env" | "file" | "config" | "session";

export interface JevProviderStatus {
  preference: JevProviderPreference;
  provider: JevProvider | null;
  configured: boolean;
  keyOrigin: string | null;
  model: string | null;
  error?: string;
}

interface ResolvedCredential {
  key: string;
  source: ApiKeySource;
  origin: string;
}

interface ResolvedProvider extends ResolvedCredential {
  provider: JevProvider;
  model: string;
}

interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export type JevFeatureName = "auto" | "autoModel" | "toolGuard" | "compact" | "autoAgents";

interface JevFeatureConfig {
  auto?: boolean;
  autoModel?: boolean;
  toolGuard?: boolean;
  compact?: boolean;
  autoAgents?: boolean;
}

interface JevGlobalConfig {
  provider?: JevProviderPreference;
  features?: JevFeatureConfig;
  typesafe?: ProviderConfig;
  vercel?: ProviderConfig;
}

const DEFAULT_TYPESAFE_MODEL = "jev-latest";
const DEFAULT_VERCEL_MODEL = "typesafe-ai/jev";
const DEFAULT_VERCEL_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function globalConfigPath(): string {
  return path.join(agentDir(), "jev.json");
}

function readGlobalConfig(): JevGlobalConfig {
  const filename = globalConfigPath();
  if (!fs.existsSync(filename)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JevGlobalConfig)
      : {};
  } catch {
    return {};
  }
}

function writeGlobalConfig(config: JevGlobalConfig): void {
  const filename = globalConfigPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, filename);
  try {
    fs.chmodSync(filename, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function secretPath(name: string): string {
  return path.join(agentDir(), "secrets", name);
}

function readSecretFile(names: string[]): { key: string; origin: string } | null {
  for (const name of names) {
    const filename = secretPath(name);
    if (!fs.existsSync(filename)) continue;
    try {
      const content = fs.readFileSync(filename, "utf8").trim();
      if (content) {
        return { key: content, origin: `~/.pi/agent/secrets/${name}` };
      }
    } catch {
      // Ignore unreadable secret files and continue to the next source.
    }
  }
  return null;
}

function normalizeProviderPreference(value: string | undefined): JevProviderPreference {
  const raw = (value ?? "auto").trim().toLowerCase();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "typesafe" || raw === "direct") return "typesafe";
  if (raw === "vercel" || raw === "gateway" || raw === "vercel-ai-gateway") return "vercel";
  throw new Error(
    `Unsupported JEV_PROVIDER="${value}". Expected auto, typesafe, or vercel.`
  );
}

function envProviderPreference(): JevProviderPreference | null {
  const raw = process.env.JEV_PROVIDER ?? process.env.PI_JEV_PROVIDER;
  return raw?.trim() ? normalizeProviderPreference(raw) : null;
}

function configuredProviderPreference(): JevProviderPreference {
  const fromEnv = envProviderPreference();
  if (fromEnv) return fromEnv;

  const configured = readGlobalConfig().provider;
  return configured ? normalizeProviderPreference(configured) : "auto";
}

function normalizeVercelModel(model?: string): string {
  const requested = model?.trim();
  if (!requested || requested === "jev-latest") return DEFAULT_VERCEL_MODEL;
  if (requested.startsWith("typesafe-ai/")) return requested;
  if (/^jev(?:-|$)/.test(requested)) return `typesafe-ai/${requested}`;
  return requested;
}

function normalizeTypeSafeModel(model?: string): string {
  const requested = model?.trim();
  if (!requested || requested === DEFAULT_VERCEL_MODEL) return DEFAULT_TYPESAFE_MODEL;
  if (requested.startsWith("typesafe-ai/")) {
    return requested.slice("typesafe-ai/".length);
  }
  return requested;
}

function credentialFor(
  provider: JevProvider,
  sessionKeys: Partial<Record<JevProvider, string>>
): ResolvedCredential | null {
  const session = sessionKeys[provider]?.trim();
  if (session) {
    return {
      key: session,
      source: "session",
      origin: `set in-session (${provider})`,
    };
  }

  const config = readGlobalConfig();

  if (provider === "typesafe") {
    const envKey = process.env.TYPESAFE_API_KEY?.trim();
    if (envKey) return { key: envKey, source: "env", origin: "$TYPESAFE_API_KEY" };

    const configKey = config.typesafe?.apiKey?.trim();
    if (configKey) {
      return {
        key: configKey,
        source: "config",
        origin: "~/.pi/agent/jev.json (typesafe.apiKey)",
      };
    }

    const file = readSecretFile(["typesafe_api_key"]);
    if (file) return { key: file.key, source: "file", origin: file.origin };
    return null;
  }

  const envKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (envKey) return { key: envKey, source: "env", origin: "$AI_GATEWAY_API_KEY" };

  const configKey = config.vercel?.apiKey?.trim();
  if (configKey) {
    return {
      key: configKey,
      source: "config",
      origin: "~/.pi/agent/jev.json (vercel.apiKey)",
    };
  }

  const file = readSecretFile(["ai_gateway_api_key", "vercel_ai_gateway_api_key"]);
  if (file) return { key: file.key, source: "file", origin: file.origin };
  return null;
}

function resolveProvider(
  preference: JevProviderPreference,
  sessionKeys: Partial<Record<JevProvider, string>>
): ResolvedProvider {
  if (preference === "typesafe" || preference === "vercel") {
    const credential = credentialFor(preference, sessionKeys);
    if (!credential) {
      const hint =
        preference === "typesafe"
          ? "Set TYPESAFE_API_KEY, typesafe.apiKey in ~/.pi/agent/jev.json, or ~/.pi/agent/secrets/typesafe_api_key."
          : "Set AI_GATEWAY_API_KEY, vercel.apiKey in ~/.pi/agent/jev.json, or ~/.pi/agent/secrets/ai_gateway_api_key.";
      throw new Error(`JEV_PROVIDER=${preference} is selected but no credential is configured. ${hint}`);
    }
    return {
      ...credential,
      provider: preference,
      model: preference === "typesafe" ? DEFAULT_TYPESAFE_MODEL : DEFAULT_VERCEL_MODEL,
    };
  }

  // Auto mode prefers the direct TypeSafe transport when both are configured.
  const typesafe = credentialFor("typesafe", sessionKeys);
  if (typesafe) {
    return {
      ...typesafe,
      provider: "typesafe",
      model: DEFAULT_TYPESAFE_MODEL,
    };
  }

  const vercel = credentialFor("vercel", sessionKeys);
  if (vercel) {
    return {
      ...vercel,
      provider: "vercel",
      model: DEFAULT_VERCEL_MODEL,
    };
  }

  throw new Error(
    "No Jev provider credentials found. Configure ~/.pi/agent/jev.json, " +
      "set TYPESAFE_API_KEY / AI_GATEWAY_API_KEY, or add a Pi Jev secret file."
  );
}

/** Resolve the currently selected provider and credential source for status reporting. */
export function resolveApiKeySource(): {
  key: string;
  source: ApiKeySource;
  origin: string;
  provider: JevProvider;
} | null {
  try {
    const resolved = resolveProvider(configuredProviderPreference(), {});
    return {
      key: resolved.key,
      source: resolved.source,
      origin: resolved.origin,
      provider: resolved.provider,
    };
  } catch {
    return null;
  }
}

function normalizeUsage(raw: any): JevEvaluationResponse["usage"] {
  if (!raw || typeof raw !== "object") return undefined;
  const inputTokens = Number(raw.inputTokens ?? raw.input_tokens ?? 0) || 0;
  const outputTokens = Number(raw.outputTokens ?? raw.output_tokens ?? 0) || 0;
  const totalTokens =
    Number(raw.totalTokens ?? raw.total_tokens ?? 0) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function normalizeAnswers(
  rawAnswers: Record<string, unknown> | null | undefined,
  questions: Record<string, QuestionConfig>,
  confidenceById: Record<string, number> = {}
): Record<string, JevAnswerResult> {
  const answers: Record<string, JevAnswerResult> = {};

  for (const [id, rawAns] of Object.entries(rawAnswers ?? {})) {
    const qConfig = questions[id];
    if (!qConfig) continue;

    const raw = (rawAns ?? {}) as Record<string, any>;
    const confidence =
      typeof raw.confidence === "number"
        ? raw.confidence
        : typeof confidenceById[id] === "number"
          ? confidenceById[id]
          : undefined;

    if (qConfig.type === "choice") {
      const value = raw.choice ?? raw.value;
      answers[id] = {
        type: "choice",
        value,
        confidence,
        distribution: raw.distribution ?? raw.probabilities,
        raw: rawAns,
      };
    } else if (qConfig.type === "noul") {
      const probability = raw.noul ?? raw.probability ?? raw.value ?? 0;
      answers[id] = {
        type: "noul",
        value: probability,
        raw: rawAns,
      };
    } else if (qConfig.type === "score") {
      const value = raw.score ?? raw.value ?? 0;
      answers[id] = {
        type: "score",
        value,
        confidence,
        distribution: raw.distribution ?? raw.probabilities,
        raw: rawAns,
      };
    }
  }

  return answers;
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vercelQuestions(
  questions: Record<string, QuestionConfig>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};

  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      out[id] = {
        type: "boolean",
        instructions: q.instructions,
      };
    } else {
      out[id] = {
        type: q.type,
        instructions: q.instructions,
        criteria: q.criteria,
      };
    }
  }

  return out;
}

export class JevClient {
  private typeSafeClient: TypeSafeClient | null = null;
  private typeSafeClientKey: string | null = null;
  private providerOverride: JevProviderPreference | null = null;
  private sessionKeys: Partial<Record<JevProvider, string>> = {};

  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
  };

  public getProviderPreference(): JevProviderPreference {
    return this.providerOverride ?? configuredProviderPreference();
  }

  public setProvider(provider: JevProviderPreference): void {
    this.providerOverride = normalizeProviderPreference(provider);
    this.typeSafeClient = null;
    this.typeSafeClientKey = null;
  }

  public persistProvider(provider: JevProviderPreference): void {
    const normalized = normalizeProviderPreference(provider);
    const config = readGlobalConfig();
    config.provider = normalized;
    writeGlobalConfig(config);
    this.setProvider(normalized);
  }

  public getFeatureDefault(feature: JevFeatureName): boolean {
    return readGlobalConfig().features?.[feature] ?? false;
  }

  public persistFeature(feature: JevFeatureName, enabled: boolean): void {
    const config = readGlobalConfig();
    config.features = { ...(config.features ?? {}), [feature]: enabled };
    writeGlobalConfig(config);
  }

  public persistApiKey(provider: JevProvider, key: string): string {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("API key cannot be empty.");

    const filename =
      provider === "typesafe"
        ? secretPath("typesafe_api_key")
        : secretPath("ai_gateway_api_key");

    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, trimmed + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(filename, 0o600);
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }

    this.setApiKey(trimmed, provider);
    return filename;
  }

  public getProviderStatus(): JevProviderStatus {
    const preference = this.getProviderPreference();
    try {
      const resolved = resolveProvider(preference, this.sessionKeys);
      return {
        preference,
        provider: resolved.provider,
        configured: true,
        keyOrigin: resolved.origin,
        model: resolved.model,
      };
    } catch (err: any) {
      return {
        preference,
        provider: preference === "auto" ? null : preference,
        configured: false,
        keyOrigin: null,
        model:
          preference === "typesafe"
            ? DEFAULT_TYPESAFE_MODEL
            : preference === "vercel"
              ? DEFAULT_VERCEL_MODEL
              : null,
        error: err?.message || String(err),
      };
    }
  }

  public isConfigured(): boolean {
    return this.getProviderStatus().configured;
  }

  /** Human-readable description of where the selected provider's API key came from. */
  public getKeyOrigin(): string | null {
    return this.getProviderStatus().keyOrigin;
  }

  /**
   * Set an in-session credential. Existing callers that omit provider keep the
   * historical behavior and set the TypeSafe direct key.
   */
  public setApiKey(key: string, provider: JevProvider = "typesafe"): void {
    this.sessionKeys[provider] = key.trim();
    if (provider === "typesafe") {
      this.typeSafeClient = null;
      this.typeSafeClientKey = null;
    }
  }

  private getTypeSafeClient(key: string): TypeSafeClient {
    if (!this.typeSafeClient || this.typeSafeClientKey !== key) {
      const baseURL =
        process.env.TYPESAFE_BASE_URL?.trim() || readGlobalConfig().typesafe?.baseURL?.trim();
      this.typeSafeClient = new TypeSafeClient({
        apiKey: key,
        ...(baseURL ? { baseURL } : {}),
      } as any);
      this.typeSafeClientKey = key;
    }
    return this.typeSafeClient;
  }

  private async evaluateTypeSafe(
    resolved: ResolvedProvider,
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<{ answers: Record<string, unknown>; model: string; usage?: any }> {
    const formattedQuestions: Record<string, any> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        formattedQuestions[id] = choice(q.instructions, q.criteria);
      } else if (q.type === "noul") {
        formattedQuestions[id] = noul(q.instructions);
      } else if (q.type === "score") {
        formattedQuestions[id] = score(q.instructions, q.criteria as any);
      }
    }

    const statePayload: any =
      typeof request.state === "string" ? { text: request.state } : request.state;
    const model = normalizeTypeSafeModel(
      request.model ?? readGlobalConfig().typesafe?.model
    );
    const client = this.getTypeSafeClient(resolved.key);

    const response: any = await client.systemOne(
      {
        state: statePayload,
        questions: formattedQuestions,
        model,
      },
      { signal }
    );

    return {
      answers: response.answers ?? {},
      model: response.model || model,
      usage: response.usage,
    };
  }

  private async evaluateVercel(
    resolved: ResolvedProvider,
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<{
    answers: Record<string, unknown>;
    confidence: Record<string, number>;
    model: string;
    usage?: any;
  }> {
    const config = readGlobalConfig();
    const model = normalizeVercelModel(request.model ?? config.vercel?.model);
    const baseURL = (
      process.env.JEV_VERCEL_BASE_URL?.trim() ||
      config.vercel?.baseURL?.trim() ||
      DEFAULT_VERCEL_BASE_URL
    ).replace(/\/+$/, "");

    const response = await fetch(`${baseURL}/evaluation-model`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.key}`,
        "Content-Type": "application/json",
        "Ai-Gateway-Protocol-Version": "0.0.1",
        "Ai-Gateway-Auth-Method": "api-key",
        "Ai-Evaluation-Model-Specification-Version": "4",
        "Ai-Model-Id": model,
        "User-Agent": "pi-jev/0.5.0",
      },
      body: JSON.stringify({
        state: request.state,
        questions: vercelQuestions(request.questions),
      }),
      signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      const safeBody = redactSecret(rawText, resolved.key).slice(0, 500);
      throw new Error(
        `Vercel AI Gateway evaluation ${response.status}: ${safeBody || response.statusText}`
      );
    }

    let body: unknown;
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error("Vercel AI Gateway returned invalid JSON.");
    }

    if (!isRecord(body) || !isRecord(body.answers)) {
      throw new Error("Vercel AI Gateway returned an invalid evaluation response (missing answers).");
    }

    const providerMetadata = isRecord(body.providerMetadata)
      ? body.providerMetadata
      : {};
    const typesafeMetadata = isRecord(providerMetadata.typesafe)
      ? providerMetadata.typesafe
      : {};
    const confidence = isRecord(typesafeMetadata.confidence)
      ? Object.fromEntries(
          Object.entries(typesafeMetadata.confidence).filter(
            ([, value]) => typeof value === "number"
          )
        ) as Record<string, number>
      : {};

    return {
      answers: body.answers,
      confidence,
      model,
      usage: body.usage,
    };
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    const preference = this.getProviderPreference();

    try {
      const resolved = resolveProvider(preference, this.sessionKeys);

      const raw =
        resolved.provider === "vercel"
          ? await this.evaluateVercel(resolved, request, signal)
          : await this.evaluateTypeSafe(resolved, request, signal);

      const usage = normalizeUsage(raw.usage);
      const elapsedMs = Date.now() - startTime;

      this.stats.requestsCount += 1;
      this.stats.totalTokens += usage?.totalTokens ?? 0;
      this.stats.lastElapsedMs = elapsedMs;
      this.stats.lastError = undefined;

      return {
        answers: normalizeAnswers(
          raw.answers,
          request.questions,
          "confidence" in raw ? (raw.confidence as Record<string, number>) : {}
        ),
        model: raw.model,
        usage,
        elapsedMs,
      };
    } catch (err: any) {
      this.stats.lastError = err?.message || String(err);
      throw err;
    }
  }
}
