import { db } from "../state/database.js";
import { getCurrentModelMeta } from "../ml/predictSignal.js";
import { DEFAULT_INITIAL_BALANCE, RISK_PER_TRADE_PCT, LOSS_COOLDOWN_CANDLES } from "../utils/riskManager.js";
import { clamp, safeRound } from "../utils/safeMath.js";
import { logger } from "../utils/logger.js";
import type { MarketData } from "../types/index.js";
import type { MarketRegime } from "../utils/marketRegime.js";
import type { SetupType } from "../utils/strategyIntelligence.js";

export type RiskMode = "AGGRESSIVE" | "NORMAL" | "DEFENSIVE" | "SAFE_MODE";
export type StressLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

interface MetaTradeRow {
  id: number;
  ativo: string;
  decisao: string;
  timestamp: string;
  resultado: string;
  preco_entrada: number;
  preco_atual: number;
  lucro_prejuizo?: number | null;
  setup?: string | null;
  regime?: string | null;
  regime_confidence?: number | null;
  edge_score?: number | null;
  execution_quality?: number | null;
  adverse_excursion?: number | null;
  favorable_excursion?: number | null;
}

export interface WindowPerformance {
  trades: number;
  pnl: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  drawdown: number;
  sharpe: number;
  volatility: number;
  wins: number;
  losses: number;
}

export interface StrategyHealth {
  setup: SetupType | "indefinido";
  totalTrades: number;
  healthScore: number;
  dnaScore: number;
  consistencyScore: number;
  stabilityScore: number;
  regimeCompatibility: number;
  edgeScore: number;
  status: "ACTIVE" | "DEGRADED" | "DISABLED" | "RECOVERING";
  bestRegimes: string[];
  worstRegimes: string[];
  signature: {
    winRate: number;
    profitFactor: number;
    expectancy: number;
    avgMae: number;
    avgMfe: number;
  };
  idealBehavior: string[];
  forbiddenBehavior: string[];
  explanation: string;
}

export interface AdaptiveRiskDirective {
  riskMode: RiskMode;
  riskPerTradePct: number;
  cooldownCandles: number;
  aggressiveness: number;
  minScore: number;
  globalConfidence: number;
  reasons: string[];
  safeMode: boolean;
  mlWeight: number;
}

export interface MarketStressResult {
  level: StressLevel;
  score: number;
  blocked: boolean;
  fakeBreakoutRisk: number;
  volatilitySpike: number;
  chopZone: number;
  lowLiquidity: number;
  regimeTransition: number;
  reasons: string[];
}

export interface PortfolioBrain {
  generatedAt: string;
  riskMode: RiskMode;
  globalConfidence: number;
  currentEdge: number;
  dominantSetup: string;
  mlHealth: number;
  adaptiveRisk: AdaptiveRiskDirective;
  marketStress: MarketStressResult;
  recent20: WindowPerformance;
  recent100: WindowPerformance;
  drawdownRecent: number;
  sharpeRecent: number;
  winStreak: number;
  lossStreak: number;
  strategyVolatility: number;
  statisticalDegradation: boolean;
  detections: string[];
  strategyRotation: StrategyHealth[];
  capitalAllocation: Array<{ setup: string; ativo: string; allocationPct: number; riskBudgetPct: number; reason: string }>;
  adaptiveMlWeight: number;
  explainer: string[];
}

export interface BrainContext {
  ativo?: string;
  setup?: SetupType | string;
  regime?: MarketRegime | string;
  regimeConfidence?: number;
  confidence?: number;
  edgeScore?: number;
  market?: MarketData;
}

const SETUPS: Array<SetupType | "indefinido"> = ["trend_follow", "breakout", "pullback", "reversal", "scalp", "lateral_range", "indefinido"];

const stmtTrades = db.prepare(`
  SELECT id, ativo, decisao, timestamp, resultado, preco_entrada, preco_atual,
         lucro_prejuizo, setup, regime, regime_confidence, edge_score,
         execution_quality, adverse_excursion, favorable_excursion
  FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
  ORDER BY datetime(timestamp) ASC, id ASC
`);
const stmtLog = db.prepare(`
  INSERT INTO meta_brain_logs (created_at, severity, scope, message, setup, ativo, regime, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtRecentLogs = db.prepare(`
  SELECT created_at, severity, scope, message, setup, ativo, regime, metadata_json
  FROM meta_brain_logs
  ORDER BY datetime(created_at) DESC, id DESC
  LIMIT ?
`);

function nowIso(): string {
  return new Date().toISOString();
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number, decimals = 2): number {
  return safeRound(value, decimals);
}

function setupOf(row: MetaTradeRow): SetupType | "indefinido" {
  return SETUPS.includes(row.setup as SetupType) ? row.setup as SetupType : "indefinido";
}

function rowPnl(row: MetaTradeRow): number {
  const stored = Number(row.lucro_prejuizo);
  if (row.lucro_prejuizo !== null && row.lucro_prejuizo !== undefined && Number.isFinite(stored)) return stored;
  const pe = Number(row.preco_entrada);
  const pa = Number(row.preco_atual);
  if (!Number.isFinite(pe) || !Number.isFinite(pa) || pe <= 0 || pa <= 0) return 0;
  if (row.decisao === "compra") return ((pa - pe) / pe) * 100;
  if (row.decisao === "venda") return ((pe - pa) / pe) * 100;
  return 0;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdownFromPnls(pnls: number[], initial = DEFAULT_INITIAL_BALANCE): number {
  let equity = initial;
  let peak = initial;
  let dd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }
  return round(dd, 4);
}

function performanceWindow(rows: MetaTradeRow[]): WindowPerformance {
  const pnls = rows.map(rowPnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((sum, p) => sum + p, 0);
  const grossLoss = losses.reduce((sum, p) => sum + Math.abs(p), 0);
  const expectancy = pnls.length ? pnls.reduce((sum, p) => sum + p, 0) / pnls.length : 0;
  const volatility = std(pnls);
  return {
    trades: rows.length,
    pnl: round(pnls.reduce((sum, p) => sum + p, 0), 4),
    winRate: rows.length ? round((wins.length / rows.length) * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? 999 : 0,
    expectancy: round(expectancy, 4),
    drawdown: maxDrawdownFromPnls(pnls),
    sharpe: volatility > 0 ? round(expectancy / volatility, 4) : 0,
    volatility: round(volatility, 4),
    wins: wins.length,
    losses: losses.length
  };
}

function streaks(rows: MetaTradeRow[]): { winStreak: number; lossStreak: number } {
  let winStreak = 0;
  let lossStreak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const pnl = rowPnl(rows[i]);
    if (pnl > 0 && lossStreak === 0) winStreak += 1;
    else if (pnl < 0 && winStreak === 0) lossStreak += 1;
    else break;
  }
  return { winStreak, lossStreak };
}

function rows(): MetaTradeRow[] {
  return stmtTrades.all() as unknown as MetaTradeRow[];
}

function logBrain(severity: "info" | "warn" | "error", scope: string, message: string, context: Partial<BrainContext> = {}, metadata?: unknown): void {
  try {
    stmtLog.run(nowIso(), severity, scope, message, context.setup ?? null, context.ativo ?? null, context.regime ?? null, metadata ? JSON.stringify(metadata) : null);
  } catch {
    // logging cannot affect trading
  }
  logger[severity === "error" ? "error" : severity === "warn" ? "warn" : "info"]("meta.brain", message, { context, metadata });
}

function marketMetrics(market?: MarketData): {
  atrPct: number;
  volumeRelativo: number;
  rangeExpansion: number;
  wickNoise: number;
  chop: number;
  momentumShift: number;
} {
  if (!Array.isArray(market) || market.length < 30) {
    return { atrPct: 0, volumeRelativo: 1, rangeExpansion: 1, wickNoise: 0, chop: 0, momentumShift: 0 };
  }
  const nums = (v: unknown[]) => v.map(Number).filter(Number.isFinite);
  const close = nums(market.map((k) => k[4]));
  const high = nums(market.map((k) => k[2]));
  const low = nums(market.map((k) => k[3]));
  const volume = nums(market.map((k) => k[5]));
  const lastClose = close[close.length - 1] ?? 0;
  const ranges = market.slice(-20).map((k) => Math.max(0, Number(k[2]) - Number(k[3]))).filter(Number.isFinite);
  const prevRanges = market.slice(-40, -20).map((k) => Math.max(0, Number(k[2]) - Number(k[3]))).filter(Number.isFinite);
  const avgRange = ranges.length ? ranges.reduce((s, n) => s + n, 0) / ranges.length : 0;
  const prevRange = prevRanges.length ? prevRanges.reduce((s, n) => s + n, 0) / prevRanges.length : avgRange;
  const atrPct = lastClose > 0 ? (avgRange / lastClose) * 100 : 0;
  const currentVol = volume[volume.length - 1] ?? 0;
  const avgVol = volume.slice(-21, -1).reduce((s, n) => s + n, 0) / Math.max(1, volume.slice(-21, -1).length);
  const bodyRatios = market.slice(-12).map((k) => {
    const o = Number(k[1]);
    const h = Number(k[2]);
    const l = Number(k[3]);
    const c = Number(k[4]);
    const range = Math.max(0, h - l);
    return range > 0 ? Math.abs(c - o) / range : 1;
  }).filter(Number.isFinite);
  const wickNoise = bodyRatios.length ? 1 - (bodyRatios.reduce((s, n) => s + n, 0) / bodyRatios.length) : 0;
  const range20 = Math.max(...high.slice(-20)) - Math.min(...low.slice(-20));
  const netMove = Math.abs((close[close.length - 1] ?? 0) - (close[close.length - 20] ?? close[0] ?? 0));
  const chop = range20 > 0 ? 1 - clamp(netMove / range20, 0, 1) : 0;
  const momFast = close.length > 6 && close[close.length - 6] > 0 ? ((close[close.length - 1] - close[close.length - 6]) / close[close.length - 6]) * 100 : 0;
  const momSlow = close.length > 18 && close[close.length - 18] > 0 ? ((close[close.length - 1] - close[close.length - 18]) / close[close.length - 18]) * 100 : 0;
  return {
    atrPct: round(atrPct, 4),
    volumeRelativo: avgVol > 0 ? round(currentVol / avgVol, 4) : 1,
    rangeExpansion: prevRange > 0 ? round(avgRange / prevRange, 4) : 1,
    wickNoise: round(clamp(wickNoise, 0, 1), 4),
    chop: round(clamp(chop, 0, 1), 4),
    momentumShift: round(Math.abs(momFast - momSlow), 4)
  };
}

export function detectMarketStress(context: BrainContext = {}): MarketStressResult {
  const m = marketMetrics(context.market);
  const fakeBreakoutRisk = clamp((m.wickNoise * 45) + (m.chop * 35) + (m.volumeRelativo < 0.8 ? 20 : 0), 0, 100);
  const volatilitySpike = clamp((m.rangeExpansion - 1) * 70 + m.atrPct * 120, 0, 100);
  const chopZone = clamp(m.chop * 100 + (m.wickNoise * 25), 0, 100);
  const lowLiquidity = clamp((1 - m.volumeRelativo) * 90, 0, 100);
  const regimeTransition = clamp(m.momentumShift * 25 + Math.max(0, m.rangeExpansion - 1.25) * 35, 0, 100);
  const score = round(fakeBreakoutRisk * 0.22 + volatilitySpike * 0.26 + chopZone * 0.22 + lowLiquidity * 0.16 + regimeTransition * 0.14, 2);
  const level: StressLevel = score >= 88 ? "EXTREME" : score >= 68 ? "HIGH" : score >= 42 ? "MEDIUM" : "LOW";
  const reasons: string[] = [];
  if (fakeBreakoutRisk >= 60) reasons.push("risco de fake breakout");
  if (volatilitySpike >= 60) reasons.push("volatility spike");
  if (chopZone >= 65) reasons.push("chop zone");
  if (lowLiquidity >= 45) reasons.push("liquidez fraca");
  if (regimeTransition >= 55) reasons.push("transição de regime");
  return {
    level,
    score,
    blocked: level === "EXTREME" && lowLiquidity >= 55,
    fakeBreakoutRisk: round(fakeBreakoutRisk, 2),
    volatilitySpike: round(volatilitySpike, 2),
    chopZone: round(chopZone, 2),
    lowLiquidity: round(lowLiquidity, 2),
    regimeTransition: round(regimeTransition, 2),
    reasons
  };
}

function regimeCompatibility(setup: string, rowsForSetup: MetaTradeRow[], currentRegime?: string): number {
  if (!currentRegime) return 50;
  const same = rowsForSetup.filter((r) => r.regime === currentRegime);
  if (same.length < 5) return 50;
  return clamp(50 + performanceWindow(same).expectancy * 12 + (performanceWindow(same).profitFactor - 1) * 20, 0, 100);
}

function strategyHealth(allRows: MetaTradeRow[], context: BrainContext = {}): StrategyHealth[] {
  const out: StrategyHealth[] = [];
  for (const setup of SETUPS) {
    const setupRows = allRows.filter((r) => setupOf(r) === setup);
    if (!setupRows.length) continue;
    const recent = setupRows.slice(-60);
    const perf = performanceWindow(recent);
    const perf20 = performanceWindow(setupRows.slice(-20));
    const avgMae = avg(setupRows.map((r) => finite(r.adverse_excursion)).filter((n) => n > 0));
    const avgMfe = avg(setupRows.map((r) => finite(r.favorable_excursion)).filter((n) => n > 0));
    const consistencyScore = clamp(perf.winRate * 0.55 + clamp(perf.profitFactor, 0, 2) * 22.5, 0, 100);
    const stabilityScore = clamp(100 - perf.volatility * 6 - perf.drawdown * 2.5, 0, 100);
    const compatibility = regimeCompatibility(setup, setupRows, context.regime);
    const edgeScore = clamp(50 + perf.expectancy * 10 + (perf.profitFactor - 1) * 25 - perf.drawdown * 1.2, 0, 100);
    const healthScore = round(consistencyScore * 0.32 + stabilityScore * 0.26 + compatibility * 0.18 + edgeScore * 0.24, 2);
    const dnaScore = round(healthScore * 0.45 + consistencyScore * 0.25 + stabilityScore * 0.2 + compatibility * 0.1, 2);
    const byRegime = new Map<string, MetaTradeRow[]>();
    for (const row of setupRows) {
      const key = row.regime ?? "NEUTRAL";
      const bucket = byRegime.get(key) ?? [];
      bucket.push(row);
      byRegime.set(key, bucket);
    }
    const regimeStats = [...byRegime.entries()]
      .map(([regime, bucket]) => ({ regime, score: performanceWindow(bucket).expectancy + Math.min(2, performanceWindow(bucket).profitFactor) }))
      .sort((a, b) => b.score - a.score);
    const bestRegimes = regimeStats.slice(0, 2).map((r) => r.regime);
    const worstRegimes = regimeStats.slice(-2).reverse().map((r) => r.regime);
    const degraded = perf20.trades >= 8 && (perf20.profitFactor < 0.9 || perf20.expectancy < 0);
    const severeDegradation = degraded && (healthScore < 42 || perf20.drawdown > Math.max(8, perf.drawdown * 1.25));
    const status: StrategyHealth["status"] = severeDegradation || healthScore < 35
      ? "DISABLED"
      : degraded || healthScore < 50
        ? "DEGRADED"
        : perf20.profitFactor > perf.profitFactor && healthScore < 65
          ? "RECOVERING"
          : "ACTIVE";
    const explanation = `${setup} ${status.toLowerCase()} com health ${healthScore}, PF ${perf.profitFactor}, expectancy ${perf.expectancy}, DD ${perf.drawdown}%`;
    out.push({
      setup,
      totalTrades: setupRows.length,
      healthScore,
      dnaScore,
      consistencyScore: round(consistencyScore, 2),
      stabilityScore: round(stabilityScore, 2),
      regimeCompatibility: round(compatibility, 2),
      edgeScore: round(edgeScore, 2),
      status,
      bestRegimes,
      worstRegimes,
      signature: {
        winRate: perf.winRate,
        profitFactor: perf.profitFactor,
        expectancy: perf.expectancy,
        avgMae: round(avgMae, 4),
        avgMfe: round(avgMfe, 4)
      },
      idealBehavior: [`operar em ${bestRegimes.join(", ") || "regime validado"}`, "manter PF acima de 1.2", "MAE contido e MFE crescente"],
      forbiddenBehavior: [`evitar ${worstRegimes.join(", ") || "regimes sem amostra"}`, "evitar baixa liquidez", "evitar chop com wick noise alto"],
      explanation
    });
  }
  return out.sort((a, b) => b.healthScore - a.healthScore);
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
}

function mlHealth(): { score: number; weight: number; reasons: string[] } {
  const meta = getCurrentModelMeta();
  if (!meta) return { score: 35, weight: 0.35, reasons: ["modelo indisponível"] };
  const baseRateOk = meta.baseRate >= 8 && meta.baseRate <= 92;
  const samplesScore = clamp((meta.sampleCount / 300) * 100, 0, 100);
  const baseRateScore = baseRateOk ? 85 : 25;
  const accuracyScore = clamp(finite(meta.accuracy, 50), 0, 100);
  const score = round(samplesScore * 0.35 + baseRateScore * 0.35 + accuracyScore * 0.3, 2);
  const weight = round(clamp(score / 100, 0.2, 1.15), 3);
  const reasons = [];
  if (!baseRateOk) reasons.push(`baseRate degenerado (${meta.baseRate}%)`);
  if (meta.sampleCount < 80) reasons.push(`amostra ML baixa (${meta.sampleCount})`);
  if (accuracyScore < 52) reasons.push("accuracy fraca");
  return { score, weight, reasons };
}

function detectDegradation(recent20: WindowPerformance, recent100: WindowPerformance, lossStreak: number): string[] {
  const detections: string[] = [];
  if (recent20.trades >= 10 && recent20.profitFactor < recent100.profitFactor * 0.65) detections.push("degradação estatística: PF recente colapsou");
  if (recent20.trades >= 10 && recent20.expectancy < 0 && recent100.expectancy >= 0) detections.push("edge desaparecendo: expectancy recente negativa");
  if (recent20.drawdown >= 12 || recent100.drawdown >= 22) detections.push("drawdown recente elevado");
  if (lossStreak >= 4) detections.push("sequência anormal de losses");
  if (recent20.sharpe < -0.15 && recent20.trades >= 10) detections.push("Sharpe recente negativo");
  if (recent20.volatility > recent100.volatility * 1.7 && recent100.volatility > 0) detections.push("volatilidade da estratégia aumentou");
  return detections;
}

export function buildAdaptiveRiskDirective(context: BrainContext = {}): AdaptiveRiskDirective {
  const allRows = rows();
  const recent20 = performanceWindow(allRows.slice(-20));
  const recent100 = performanceWindow(allRows.slice(-100));
  const { lossStreak } = streaks(allRows);
  const stress = detectMarketStress(context);
  const ml = mlHealth();
  const detections = detectDegradation(recent20, recent100, lossStreak);
  const edge = finite(context.edgeScore, 50);
  const confidence = finite(context.confidence, 50);
  let riskMode: RiskMode = "NORMAL";
  const reasons: string[] = [];
  if (detections.length >= 3 || stress.level === "EXTREME" || recent20.drawdown >= 18 || lossStreak >= 6) {
    riskMode = "SAFE_MODE";
    reasons.push("self-healing: condições severas detectadas");
  } else if (detections.length >= 2 || stress.level === "HIGH" || recent20.drawdown >= 10 || lossStreak >= 4) {
    riskMode = "DEFENSIVE";
    reasons.push("modo defensivo por stress/degradação");
  } else if (edge >= 75 && confidence >= 70 && recent20.profitFactor >= 1.35 && stress.level === "LOW") {
    riskMode = "AGGRESSIVE";
    reasons.push("edge forte com stress baixo");
  }
  reasons.push(...detections, ...stress.reasons, ...ml.reasons);

  const modeFactor = riskMode === "SAFE_MODE" ? 0.55 : riskMode === "DEFENSIVE" ? 0.75 : riskMode === "AGGRESSIVE" ? 1.2 : 1;
  const edgeFactor = clamp(edge / 60, 0.55, 1.35);
  const confidenceFactor = clamp(confidence / 65, 0.55, 1.2);
  const ddFactor = clamp(1 - recent20.drawdown / 30, 0.25, 1);
  const stressFactor = clamp(1 - stress.score / 140, 0.25, 1);
  const riskPerTradePct = round(clamp(RISK_PER_TRADE_PCT * modeFactor * edgeFactor * confidenceFactor * ddFactor * stressFactor, 0.25, RISK_PER_TRADE_PCT * 1.35), 4);
  const cooldownCandles = Math.round(LOSS_COOLDOWN_CANDLES * (riskMode === "SAFE_MODE" ? 1.35 : riskMode === "DEFENSIVE" ? 1.15 : riskMode === "AGGRESSIVE" ? 0.65 : 0.85));
  const minScore = Math.round(riskMode === "SAFE_MODE" ? 64 : riskMode === "DEFENSIVE" ? 60 : riskMode === "AGGRESSIVE" ? 52 : 56);
  const degradationPenalty = detections.length * 14 + Math.max(0, lossStreak - 2) * 8;
  const modePenalty = riskMode === "SAFE_MODE" ? 24 : riskMode === "DEFENSIVE" ? 10 : 0;
  const globalConfidence = round(clamp(72 - recent20.drawdown * 2 - stress.score * 0.35 - degradationPenalty - modePenalty + (edge - 50) * 0.25 + ml.score * 0.15, 0, 100), 2);
  return {
    riskMode,
    riskPerTradePct,
    cooldownCandles,
    aggressiveness: round(clamp(riskPerTradePct / Math.max(0.1, RISK_PER_TRADE_PCT), 0, 1.5), 3),
    minScore,
    globalConfidence,
    reasons: [...new Set(reasons)].slice(0, 8),
    safeMode: riskMode === "SAFE_MODE",
    mlWeight: ml.weight
  };
}

function capitalAllocation(health: StrategyHealth[], allRows: MetaTradeRow[]): PortfolioBrain["capitalAllocation"] {
  const eligible = health.filter((h) => h.status === "ACTIVE" || h.status === "RECOVERING").slice(0, 6);
  const totalScore = eligible.reduce((sum, h) => sum + Math.max(1, h.healthScore), 0);
  return eligible.map((h) => {
    const related = allRows.filter((r) => setupOf(r) === h.setup);
    const byAtivo = new Map<string, number>();
    for (const row of related) byAtivo.set(row.ativo, (byAtivo.get(row.ativo) ?? 0) + Math.max(0, rowPnl(row)));
    const ativo = [...byAtivo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "GLOBAL";
    const allocationPct = totalScore > 0 ? (h.healthScore / totalScore) * 100 : 0;
    return {
      setup: h.setup,
      ativo,
      allocationPct: round(allocationPct, 2),
      riskBudgetPct: round(clamp(allocationPct / 100 * RISK_PER_TRADE_PCT, 0.05, RISK_PER_TRADE_PCT), 4),
      reason: `health ${h.healthScore}, DNA ${h.dnaScore}, regime ${h.regimeCompatibility}`
    };
  });
}

function explain(brain: Omit<PortfolioBrain, "explainer">): string[] {
  const lines: string[] = [];
  const degraded = brain.strategyRotation.find((s) => s.status === "DISABLED" || s.status === "DEGRADED");
  if (degraded) {
    lines.push(`setup ${degraded.setup} está ${degraded.status.toLowerCase()} em ${brain.marketStress.level} devido PF ${degraded.signature.profitFactor}, MAE ${degraded.signature.avgMae} e health ${degraded.healthScore}`);
  }
  if (brain.adaptiveRisk.safeMode) {
    lines.push(`SAFE MODE ativo: ${brain.adaptiveRisk.reasons.join("; ") || "degradação severa detectada"}`);
  }
  if (brain.marketStress.blocked) {
    lines.push(`operações perigosas bloqueadas por stress ${brain.marketStress.level}: ${brain.marketStress.reasons.join(", ")}`);
  }
  if (!lines.length) {
    lines.push(`sistema em ${brain.riskMode}: setup dominante ${brain.dominantSetup}, edge ${brain.currentEdge}, confiança global ${brain.globalConfidence}`);
  }
  return lines;
}

export function getAdaptivePortfolioBrain(context: BrainContext = {}): PortfolioBrain {
  const allRows = rows();
  const recent20 = performanceWindow(allRows.slice(-20));
  const recent100 = performanceWindow(allRows.slice(-100));
  const { winStreak, lossStreak } = streaks(allRows);
  const health = strategyHealth(allRows, context);
  const dominantSetup = health[0]?.setup ?? "indefinido";
  const adaptiveRisk = buildAdaptiveRiskDirective(context);
  const stress = detectMarketStress(context);
  const ml = mlHealth();
  const detections = detectDegradation(recent20, recent100, lossStreak);
  const partial: Omit<PortfolioBrain, "explainer"> = {
    generatedAt: nowIso(),
    riskMode: adaptiveRisk.riskMode,
    globalConfidence: adaptiveRisk.globalConfidence,
    currentEdge: round(finite(context.edgeScore, health[0]?.edgeScore ?? 50), 2),
    dominantSetup,
    mlHealth: ml.score,
    adaptiveRisk,
    marketStress: stress,
    recent20,
    recent100,
    drawdownRecent: recent20.drawdown,
    sharpeRecent: recent20.sharpe,
    winStreak,
    lossStreak,
    strategyVolatility: recent20.volatility,
    statisticalDegradation: detections.length > 0,
    detections,
    strategyRotation: health,
    capitalAllocation: capitalAllocation(health, allRows),
    adaptiveMlWeight: adaptiveRisk.mlWeight
  };
  const explainer = explain(partial);
  if (detections.length || adaptiveRisk.safeMode || stress.blocked) {
    logBrain(adaptiveRisk.safeMode || stress.blocked ? "warn" : "info", "adaptive", explainer[0], context, {
      detections,
      riskMode: adaptiveRisk.riskMode,
      stress: stress.level
    });
  }
  return { ...partial, explainer };
}

export function shouldBlockSetup(setup: string | undefined, context: BrainContext = {}): { blocked: boolean; reason?: string; health?: StrategyHealth } {
  if (!setup) return { blocked: false };
  const health = strategyHealth(rows(), context).find((h) => h.setup === setup);
  if (!health) return { blocked: false };
  if (health.status === "DISABLED" && health.healthScore < 38) return { blocked: true, reason: `setup ${setup} desativado pelo brain: health ${health.healthScore}`, health };
  return { blocked: false, health };
}

export function getAdaptiveMlWeight(context: BrainContext = {}): { weight: number; health: number; reasons: string[] } {
  const ml = mlHealth();
  const stress = detectMarketStress(context);
  const stressFactor = stress.level === "EXTREME" ? 0.35 : stress.level === "HIGH" ? 0.6 : stress.level === "MEDIUM" ? 0.85 : 1;
  return {
    weight: round(clamp(ml.weight * stressFactor, 0.15, 1.15), 3),
    health: ml.score,
    reasons: [...ml.reasons, ...stress.reasons]
  };
}

export function recentMetaBrainLogs(limit = 30): Array<Record<string, unknown>> {
  return stmtRecentLogs.all(Math.max(1, Math.min(200, Math.trunc(limit)))) as Array<Record<string, unknown>>;
}
