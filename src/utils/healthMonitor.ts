import { logger } from "./logger.js";

const MAX_RECENT_ERRORS = 20;
const STALE_HEARTBEAT_MS = 90_000;

interface RecentError {
  timestamp: string;
  scope: string;
  message: string;
}

interface HealthState {
  startTime: number;
  lastHeartbeat: number;
  lastCycle: { timestamp: number; ativo: string; decisao: string } | null;
  lastBinanceFetch: { timestamp: number; symbol: string; klines: number } | null;
  lastError: RecentError | null;
  recentErrors: RecentError[];
  cyclesExecutados: number;
  fetchesBinance: number;
  errosTotais: number;
  watchdogId: NodeJS.Timeout | null;
  onWatchdogStale: ((idleMs: number) => void) | null;
}

const state: HealthState = {
  startTime: Date.now(),
  lastHeartbeat: Date.now(),
  lastCycle: null,
  lastBinanceFetch: null,
  lastError: null,
  recentErrors: [],
  cyclesExecutados: 0,
  fetchesBinance: 0,
  errosTotais: 0,
  watchdogId: null,
  onWatchdogStale: null
};

export function heartbeat(): void {
  state.lastHeartbeat = Date.now();
}

export function recordCycle(ativo: string, decisao: string): void {
  state.lastCycle = { timestamp: Date.now(), ativo, decisao };
  state.cyclesExecutados += 1;
  heartbeat();
}

export function recordBinanceFetch(symbol: string, klines: number): void {
  state.lastBinanceFetch = { timestamp: Date.now(), symbol, klines };
  state.fetchesBinance += 1;
  heartbeat();
}

export function recordError(scope: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const entry: RecentError = {
    timestamp: new Date().toISOString(),
    scope,
    message: message.slice(0, 1000) // evita log gigante
  };
  state.lastError = entry;
  state.recentErrors.push(entry);
  if (state.recentErrors.length > MAX_RECENT_ERRORS) {
    state.recentErrors.splice(0, state.recentErrors.length - MAX_RECENT_ERRORS);
  }
  state.errosTotais += 1;
  logger.error(scope, message);
}

export interface HealthSnapshot {
  online: boolean;
  uptime: number;
  uptimeMs: number;
  startedAt: string;
  lastHeartbeat: string;
  lastHeartbeatAgeMs: number;
  lastCycle: { timestamp: string; ativo: string; decisao: string; ageMs: number } | null;
  lastBinanceFetch: { timestamp: string; symbol: string; klines: number; ageMs: number } | null;
  memoryUsage: {
    rssMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
  };
  cyclesExecutados: number;
  fetchesBinance: number;
  errosTotais: number;
  errosRecentes: RecentError[];
  watchdog: { staleThresholdMs: number; stale: boolean };
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function getHealth(): HealthSnapshot {
  const now = Date.now();
  const uptimeMs = now - state.startTime;
  const lastHeartbeatAgeMs = now - state.lastHeartbeat;
  const stale = lastHeartbeatAgeMs > STALE_HEARTBEAT_MS;
  const mem = process.memoryUsage();
  return {
    online: !stale,
    uptime: Math.round(uptimeMs / 1000),
    uptimeMs,
    startedAt: new Date(state.startTime).toISOString(),
    lastHeartbeat: new Date(state.lastHeartbeat).toISOString(),
    lastHeartbeatAgeMs,
    lastCycle: state.lastCycle
      ? {
          timestamp: new Date(state.lastCycle.timestamp).toISOString(),
          ativo: state.lastCycle.ativo,
          decisao: state.lastCycle.decisao,
          ageMs: now - state.lastCycle.timestamp
        }
      : null,
    lastBinanceFetch: state.lastBinanceFetch
      ? {
          timestamp: new Date(state.lastBinanceFetch.timestamp).toISOString(),
          symbol: state.lastBinanceFetch.symbol,
          klines: state.lastBinanceFetch.klines,
          ageMs: now - state.lastBinanceFetch.timestamp
        }
      : null,
    memoryUsage: {
      rssMB: toMB(mem.rss),
      heapUsedMB: toMB(mem.heapUsed),
      heapTotalMB: toMB(mem.heapTotal),
      externalMB: toMB(mem.external)
    },
    cyclesExecutados: state.cyclesExecutados,
    fetchesBinance: state.fetchesBinance,
    errosTotais: state.errosTotais,
    errosRecentes: state.recentErrors.slice(-10),
    watchdog: { staleThresholdMs: STALE_HEARTBEAT_MS, stale }
  };
}

export function startWatchdog(onStale: (idleMs: number) => void): void {
  state.onWatchdogStale = onStale;
  if (state.watchdogId) clearInterval(state.watchdogId);
  state.watchdogId = setInterval(() => {
    const idleMs = Date.now() - state.lastHeartbeat;
    if (idleMs > STALE_HEARTBEAT_MS) {
      logger.warn("watchdog", `Sem heartbeat há ${Math.round(idleMs / 1000)}s — disparando recuperação`);
      try {
        state.onWatchdogStale && state.onWatchdogStale(idleMs);
      } catch (err) {
        recordError("watchdog:onStale", err);
      }
      // reset heartbeat para evitar loop de warnings sucessivos
      state.lastHeartbeat = Date.now();
    }
  }, 15_000);
}

export function stopWatchdog(): void {
  if (state.watchdogId) clearInterval(state.watchdogId);
  state.watchdogId = null;
}

export const HEALTH_STALE_THRESHOLD_MS = STALE_HEARTBEAT_MS;
