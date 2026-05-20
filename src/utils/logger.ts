import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const LOG_DIR = resolve(process.cwd(), "logs");
const LOG_FILE = resolve(LOG_DIR, "runtime.log");
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB → rotaciona
const MAX_ROTATED = 3;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

export type LogLevel = "info" | "warn" | "error" | "debug";

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|secret|token|password|passwd|pwd|jwt|authorization|x-api-key|private[-_]?key|access[-_]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
];

function rotateIfBig(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const sz = statSync(LOG_FILE).size;
    if (sz < MAX_FILE_BYTES) return;
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const cur = resolve(LOG_DIR, `runtime.log.${i}`);
      const nxt = resolve(LOG_DIR, `runtime.log.${i + 1}`);
      if (existsSync(cur)) {
        try { renameSync(cur, nxt); } catch {}
      }
    }
    renameSync(LOG_FILE, resolve(LOG_DIR, "runtime.log.1"));
  } catch {
    // ignora — logger nunca pode quebrar o sistema
  }
}

function formatLine(level: LogLevel, scope: string, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const safeMessage = redactSensitive(message);
  const metaStr = meta === undefined ? "" : " " + (typeof meta === "string" ? redactSensitive(meta) : safeJson(maskObject(meta)));
  return `${ts} [${level.toUpperCase()}] [${scope}] ${safeMessage}${metaStr}\n`;
}

function safeJson(value: unknown): string {
  try {
    return redactSensitive(JSON.stringify(value));
  } catch {
    return redactSensitive(String(value));
  }
}

export function redactSensitive(value: string): string {
  let output = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (match, prefix) => `${typeof prefix === "string" ? prefix : ""}***REDACTED***`);
  }
  output = output.replace(
    /(["']?)(api[-_]?key|secret|token|password|passwd|pwd|jwt|authorization|x-api-key|private[-_]?key|access[-_]?key)(["']?\s*[:=]\s*)(["']?)[^"',}\s]+/gi,
    "$1$2$3$4***REDACTED***"
  );
  return output;
}

function maskObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[MaxDepth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitive(value);
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitive(value.message),
      stack: value.stack ? redactSensitive(value.stack) : undefined
    };
  }
  if (Array.isArray(value)) return value.map((item) => maskObject(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "***REDACTED***" : maskObject(item, depth + 1);
  }
  return out;
}

export function log(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  try {
    rotateIfBig();
    appendFileSync(LOG_FILE, formatLine(level, scope, message, meta), "utf-8");
  } catch {
    // se disco cheio / permissão / etc, nunca derruba o processo
  }
}

export const logger = {
  info: (scope: string, msg: string, meta?: unknown) => log("info", scope, msg, meta),
  warn: (scope: string, msg: string, meta?: unknown) => log("warn", scope, msg, meta),
  error: (scope: string, msg: string, meta?: unknown) => log("error", scope, msg, meta),
  debug: (scope: string, msg: string, meta?: unknown) => log("debug", scope, msg, meta),
  errFromUnknown: (scope: string, err: unknown, ctx?: string) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log("error", scope, ctx ? `${ctx}: ${msg}` : msg);
  }
};

export const LOG_FILE_PATH = LOG_FILE;
