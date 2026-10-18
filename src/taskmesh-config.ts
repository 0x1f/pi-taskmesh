import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DecisionBackend = "pi" | "jev";
export interface TaskMeshConfig {
  enabled: boolean;
  decisionBackend: DecisionBackend;
  maxConcurrency: number;
}
const DEFAULTS: TaskMeshConfig = { enabled: false, decisionBackend: "pi", maxConcurrency: 3 };

export class TaskMeshSettings {
  public value: TaskMeshConfig = { ...DEFAULTS };
  public error?: string;
  public readonly path = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "taskmesh.json");

  constructor() {
    try { this.value = this.validate(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = String((error as Error).message);
    }
  }

  private validate(raw: unknown): TaskMeshConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("taskmesh.json must be an object");
    const config = { ...DEFAULTS, ...raw };
    if (typeof config.enabled !== "boolean" || !["pi", "jev"].includes(config.decisionBackend) ||
        !Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 3) {
      throw new Error("Invalid taskmesh.json: enabled must be boolean, decisionBackend pi|jev, maxConcurrency 1–3");
    }
    return { enabled: config.enabled, decisionBackend: config.decisionBackend, maxConcurrency: config.maxConcurrency };
  }

  public save(patch: Partial<TaskMeshConfig>): void {
    // Preserve unknown fields; concurrent saves are last-writer-wins.
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); this.validate(raw); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = this.validate({ ...raw, ...patch });
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = this.path + ".tmp-" + crypto.randomUUID();
    try {
      writeFileSync(temp, JSON.stringify({ ...raw, ...next }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
    this.value = next;
    this.error = undefined;
  }
}
