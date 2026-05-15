import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const LOG_DIR = resolve(process.cwd(), "logs");
const LOG_FILE = resolve(LOG_DIR, "runtime.log");
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB → rotaciona
const MAX_ROTATED = 3;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

export type LogLevel = "info" | "warn" | "error" | "debug";

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
  const metaStr = meta === undefined ? "" : " " + (typeof meta === "string" ? meta : safeJson(meta));
  return `${ts} [${level.toUpperCase()}] [${scope}] ${message}${metaStr}\n`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
