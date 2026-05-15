import { db } from "../state/database.js";
import { getInitialBalance } from "../utils/riskManager.js";

export interface MonteCarloResult {
  source: string;
  iterations: number;
  horizonTrades: number;
  initialBalance: number;
  survivalProbability: number;
  ruinProbability: number;
  expectedFinalEquity: number;
  medianFinalEquity: number;
  pessimisticFinalEquity: number;
  optimisticFinalEquity: number;
  expectedMaxDrawdownPct: number;
  sampleTrades: number;
  updatedAt: string;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function percentile(values: number[], pct: number): number {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * pct));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function historicalPnls(): number[] {
  const rows = db.prepare(`
    SELECT realized_pnl
    FROM execution_positions
    WHERE status IN ('CLOSED', 'STOPPED') OR realized_pnl != 0
    ORDER BY datetime(opened_at) ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => finite(r.realized_pnl)).filter((n) => Number.isFinite(n));
}

function fallbackDistribution(initialBalance: number): number[] {
  const unit = Math.max(1, initialBalance * 0.003);
  return [unit * 0.65, unit * 0.9, unit * 1.2, -unit * 0.55, -unit * 0.8, -unit * 1.05];
}

function maxDrawdownPct(path: number[]): number {
  let peak = path[0] ?? 0;
  let dd = 0;
  for (const equity of path) {
    peak = Math.max(peak, equity);
    if (peak > 0) dd = Math.max(dd, ((peak - equity) / peak) * 100);
  }
  return dd;
}

export function runMonteCarlo(iterationsInput = 1000, horizonTradesInput = 120): MonteCarloResult {
  const iterations = Math.max(100, Math.min(10_000, Math.trunc(finite(iterationsInput, 1000))));
  const horizonTrades = Math.max(20, Math.min(1_000, Math.trunc(finite(horizonTradesInput, 120))));
  const initialBalance = getInitialBalance();
  const sample = historicalPnls();
  const distribution = sample.length >= 8 ? sample : fallbackDistribution(initialBalance);
  const ruinThreshold = initialBalance * 0.35;
  const finals: number[] = [];
  const drawdowns: number[] = [];
  let ruined = 0;

  for (let i = 0; i < iterations; i += 1) {
    let equity = initialBalance;
    const path = [equity];
    let isRuined = false;
    for (let j = 0; j < horizonTrades; j += 1) {
      const pnl = distribution[Math.floor(Math.random() * distribution.length)] ?? 0;
      const stressShock = Math.random() < 0.04 ? -Math.abs(pnl) * (1.2 + Math.random() * 1.8) : 0;
      equity = Math.max(0, equity + pnl + stressShock);
      path.push(equity);
      if (equity <= ruinThreshold) isRuined = true;
      if (equity <= 0) break;
    }
    if (isRuined) ruined += 1;
    finals.push(equity);
    drawdowns.push(maxDrawdownPct(path));
  }

  return {
    source: "monte-carlo-engine",
    iterations,
    horizonTrades,
    initialBalance,
    survivalProbability: round(((iterations - ruined) / iterations) * 100, 2),
    ruinProbability: round((ruined / iterations) * 100, 2),
    expectedFinalEquity: round(finals.reduce((sum, n) => sum + n, 0) / finals.length, 2),
    medianFinalEquity: round(percentile(finals, 0.5), 2),
    pessimisticFinalEquity: round(percentile(finals, 0.05), 2),
    optimisticFinalEquity: round(percentile(finals, 0.95), 2),
    expectedMaxDrawdownPct: round(drawdowns.reduce((sum, n) => sum + n, 0) / drawdowns.length, 2),
    sampleTrades: sample.length,
    updatedAt: new Date().toISOString()
  };
}
