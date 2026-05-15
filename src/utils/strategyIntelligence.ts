import { db } from "../state/database.js";
import { computeTradeMetrics } from "./riskManager.js";
import { safeRound } from "./safeMath.js";
import type { MarketQualityResult } from "./marketFilters.js";
import type { MarketRegime } from "./marketRegime.js";

export type SetupType = "trend_follow" | "breakout" | "pullback" | "reversal" | "scalp" | "lateral_range";
export type Direction = "compra" | "venda";

const MIN_TRADES_EDGE = 30;
const MIN_TRADES_BLOCK = 50;
const DEFAULT_LOOKBACK = Number(process.env.EDGE_LOOKBACK_TRADES ?? 200);
const HIGH_DRAWDOWN_PCT = Number(process.env.EDGE_HIGH_DRAWDOWN_PCT ?? 20);

interface StrategyRow {
  id: number;
  ativo: string;
  decisao: string;
  tendencia: string;
  rsi: number;
  momentum: number;
  intensidade: number;
  preco_entrada: number;
  preco_atual: number;
  timestamp: string;
  resultado: string;
  setup?: string | null;
  timeframe?: string | null;
  direcao?: string | null;
  lucro_prejuizo?: number | null;
  regime?: string | null;
  regime_confidence?: number | null;
}

export interface SetupContext {
  setup: SetupType;
  ativo: string;
  timeframe: string;
  direcao: Direction;
  regime?: MarketRegime;
  regimeConfidence?: number;
}

export interface EdgeResult {
  setup: SetupType;
  ativo: string;
  timeframe: string;
  direcao: Direction;
  totalTrades: number;
  sampleSize: number;
  trusted: boolean;
  blocked: boolean;
  edgeScore: number;
  scoreDelta: number;
  motivos: string[];
  regime?: MarketRegime;
  regimeUsed: boolean;
  metrics: {
    winRate: number;
    profitFactor: number;
    expectancy: number;
    sharpe: number;
    drawdown: number;
    pnlAcumulado: number;
  };
}

export interface SetupRankingItem {
  setup: SetupType;
  ativo: string;
  timeframe: string;
  direcao: Direction;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  sharpe: number;
  drawdown: number;
  pnlAcumulado: number;
  edgeScore: number;
  trusted: boolean;
  blocked: boolean;
}

export interface StrategyPerformanceResult {
  generatedAt: string;
  minTrades: number;
  lookbackTrades: number;
  ranking: SetupRankingItem[];
  setupsBloqueados: SetupRankingItem[];
  ativosMelhores: Array<{ ativo: string; edgeScore: number; pnlAcumulado: number; totalTrades: number }>;
}

const stmtTrades = db.prepare(`
  SELECT id, ativo, decisao, tendencia, rsi, momentum, intensidade,
         preco_entrada, preco_atual, timestamp, resultado,
         setup, timeframe, direcao, lucro_prejuizo, regime, regime_confidence
  FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
  ORDER BY datetime(timestamp) ASC, id ASC
`);

const stmtUpsertPerformance = db.prepare(`
  INSERT INTO strategy_performance (
    setup, ativo, timeframe, direcao, total_trades, win_rate, profit_factor,
    expectancy, sharpe, drawdown, pnl_acumulado, edge_score, trusted, blocked, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(setup, ativo, timeframe, direcao) DO UPDATE SET
    total_trades = excluded.total_trades,
    win_rate = excluded.win_rate,
    profit_factor = excluded.profit_factor,
    expectancy = excluded.expectancy,
    sharpe = excluded.sharpe,
    drawdown = excluded.drawdown,
    pnl_acumulado = excluded.pnl_acumulado,
    edge_score = excluded.edge_score,
    trusted = excluded.trusted,
    blocked = excluded.blocked,
    updated_at = excluded.updated_at
`);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeSetup(value: unknown): SetupType | null {
  return value === "trend_follow" ||
    value === "breakout" ||
    value === "pullback" ||
    value === "reversal" ||
    value === "scalp" ||
    value === "lateral_range"
    ? value
    : null;
}

function normalizeDirection(value: unknown): Direction | null {
  return value === "compra" || value === "venda" ? value : null;
}

function tradeReturnPct(row: StrategyRow): number {
  const pe = Number(row.preco_entrada);
  const pa = Number(row.preco_atual);
  if (!Number.isFinite(pe) || !Number.isFinite(pa) || pe <= 0 || pa <= 0) return 0;
  if (row.decisao === "compra") return ((pa - pe) / pe) * 100;
  if (row.decisao === "venda") return ((pe - pa) / pe) * 100;
  return 0;
}

function rowPnl(row: StrategyRow): number {
  const stored = Number(row.lucro_prejuizo);
  if (row.lucro_prejuizo !== null && row.lucro_prejuizo !== undefined && Number.isFinite(stored)) return stored;
  return tradeReturnPct(row);
}

function fallbackClassify(row: StrategyRow): SetupType {
  const direcao = normalizeDirection(row.direcao) ?? normalizeDirection(row.decisao);
  const rsi = Number(row.rsi);
  const momentum = Number(row.momentum);
  const intensidade = Math.abs(Number(row.intensidade) || 0);
  if (row.tendencia === "lateral") return "lateral_range";
  if (Number.isFinite(rsi) && (rsi <= 30 || rsi >= 70)) return "reversal";
  if (intensidade >= 0.4 && Math.abs(momentum) >= 0.05) return "trend_follow";
  if (direcao === "compra" && row.tendencia === "alta" && rsi >= 40 && rsi <= 55) return "pullback";
  if (direcao === "venda" && row.tendencia === "baixa" && rsi >= 45 && rsi <= 60) return "pullback";
  return "scalp";
}

function rows(): StrategyRow[] {
  return stmtTrades.all() as unknown as StrategyRow[];
}

function edgeScoreFromMetrics(input: {
  totalTrades: number;
  profitFactor: number;
  expectancy: number;
  sharpe: number;
  drawdown: number;
}): number {
  if (input.totalTrades < MIN_TRADES_EDGE) return 50;
  const pfScore = clamp((input.profitFactor / 2) * 100, 0, 100);
  const expScore = clamp(50 + input.expectancy * 8, 0, 100);
  const ddScore = clamp(100 - input.drawdown * 3, 0, 100);
  const consistencyScore = clamp(50 + input.sharpe * 25, 0, 100);
  return safeRound(pfScore * 0.35 + expScore * 0.3 + ddScore * 0.2 + consistencyScore * 0.15, 2);
}

function metricsFor(rowsInput: StrategyRow[]): Omit<SetupRankingItem, "setup" | "ativo" | "timeframe" | "direcao" | "edgeScore" | "trusted" | "blocked"> {
  const pnls = rowsInput.map(rowPnl);
  const wins = pnls.filter((p) => p > 0).length;
  const pnlAcumulado = pnls.reduce((sum, p) => sum + p, 0);
  const equityCurve = pnls.reduce<Array<{ equity: number }>>((acc, pnl) => {
    const prev = acc.length ? acc[acc.length - 1].equity : 1000;
    acc.push({ equity: prev + pnl });
    return acc;
  }, []);
  const computed = computeTradeMetrics(pnls, equityCurve);
  return {
    totalTrades: rowsInput.length,
    winRate: rowsInput.length > 0 ? safeRound((wins / rowsInput.length) * 100, 2) : 0,
    profitFactor: Number.isFinite(computed.profitFactor) ? computed.profitFactor : 999,
    expectancy: computed.expectancy,
    sharpe: computed.sharpeSimplificado,
    drawdown: computed.maxDrawdown,
    pnlAcumulado: safeRound(pnlAcumulado, 4)
  };
}

function blockedByMetrics(metrics: { totalTrades: number; profitFactor: number; expectancy: number; drawdown: number }): boolean {
  return metrics.totalTrades >= MIN_TRADES_BLOCK &&
    metrics.profitFactor < 1 &&
    metrics.expectancy < 0 &&
    metrics.drawdown >= HIGH_DRAWDOWN_PCT;
}

function persistPerformance(ranking: SetupRankingItem[]): void {
  const updatedAt = new Date().toISOString();
  for (const item of ranking) {
    stmtUpsertPerformance.run(
      item.setup,
      item.ativo,
      item.timeframe,
      item.direcao,
      item.totalTrades,
      item.winRate,
      item.profitFactor,
      item.expectancy,
      item.sharpe,
      item.drawdown,
      item.pnlAcumulado,
      item.edgeScore,
      item.trusted ? 1 : 0,
      item.blocked ? 1 : 0,
      updatedAt
    );
  }
}

export function classifySetup(input: {
  sinal: string;
  breakout: string;
  rsi: number;
  momentum: number;
  marketQuality: MarketQualityResult;
}): SetupType {
  const direction = normalizeDirection(input.sinal);
  const tendenciaEntrada = input.marketQuality.tendenciaEntrada;
  const tendenciaMaior = input.marketQuality.tendenciaMaior;
  const rsi = input.rsi;
  const momentumAbs = Math.abs(input.momentum);

  if (input.marketQuality.lateral || tendenciaEntrada === "lateral") return "lateral_range";
  if (input.breakout !== "nenhum" && input.marketQuality.volumeForte) return "breakout";
  if (
    (direction === "compra" && tendenciaMaior === "alta" && tendenciaEntrada === "alta" && rsi >= 40 && rsi <= 55) ||
    (direction === "venda" && tendenciaMaior === "baixa" && tendenciaEntrada === "baixa" && rsi >= 45 && rsi <= 60)
  ) return "pullback";
  if (
    (direction === "compra" && tendenciaMaior === "baixa") ||
    (direction === "venda" && tendenciaMaior === "alta") ||
    rsi <= 30 ||
    rsi >= 70
  ) return "reversal";
  if (
    (direction === "compra" && tendenciaMaior === "alta" && tendenciaEntrada === "alta") ||
    (direction === "venda" && tendenciaMaior === "baixa" && tendenciaEntrada === "baixa")
  ) return "trend_follow";
  if (momentumAbs <= 0.08) return "scalp";
  return "scalp";
}

export function computeHistoricalEdge(context: SetupContext, lookback = DEFAULT_LOOKBACK): EdgeResult {
  const baseSimilar = rows()
    .filter((row) => {
      const setup = normalizeSetup(row.setup) ?? fallbackClassify(row);
      const direcao = normalizeDirection(row.direcao) ?? normalizeDirection(row.decisao);
      const timeframe = typeof row.timeframe === "string" && row.timeframe ? row.timeframe : "1m";
      return setup === context.setup &&
        row.ativo === context.ativo &&
        timeframe === context.timeframe &&
        direcao === context.direcao;
    })
    .slice(-lookback);
  const regimeCandidate = context.regime && context.regime !== "NEUTRAL" && (context.regimeConfidence ?? 0) >= 60
    ? baseSimilar.filter((row) => row.regime === context.regime).slice(-lookback)
    : [];
  const regimeUsed = regimeCandidate.length >= MIN_TRADES_EDGE;
  const similar = regimeUsed ? regimeCandidate : baseSimilar;
  const metrics = metricsFor(similar);
  const edgeScore = edgeScoreFromMetrics({
    totalTrades: metrics.totalTrades,
    profitFactor: metrics.profitFactor,
    expectancy: metrics.expectancy,
    sharpe: metrics.sharpe,
    drawdown: metrics.drawdown
  });
  const trusted = metrics.totalTrades >= MIN_TRADES_EDGE;
  const blocked = blockedByMetrics(metrics);
  const scoreDelta = !trusted
    ? 0
    : blocked
      ? -35
      : edgeScore >= 75
        ? 12
        : edgeScore >= 60
          ? 6
          : edgeScore < 40
            ? -15
            : 0;
  const motivos: string[] = [];
  if (!trusted) motivos.push(`amostra insuficiente (${metrics.totalTrades}/${MIN_TRADES_EDGE})`);
  if (context.regime && context.regime !== "NEUTRAL" && (context.regimeConfidence ?? 0) >= 60) {
    motivos.push(regimeUsed ? `edge adaptativo regime=${context.regime}` : `fallback edge geral: regime ${context.regime} com ${regimeCandidate.length}/${MIN_TRADES_EDGE}`);
  }
  if (blocked) motivos.push(`setup bloqueado: PF ${metrics.profitFactor} < 1, expectancy ${metrics.expectancy}, DD ${metrics.drawdown}%`);
  else if (scoreDelta > 0) motivos.push(`auto-promocao edge=${edgeScore}`);
  else if (scoreDelta < 0) motivos.push(`penalizacao edge=${edgeScore}`);

  return {
    setup: context.setup,
    ativo: context.ativo,
    timeframe: context.timeframe,
    direcao: context.direcao,
    totalTrades: metrics.totalTrades,
    sampleSize: similar.length,
    trusted,
    blocked,
    edgeScore,
    scoreDelta,
    motivos,
    regime: context.regime,
    regimeUsed,
    metrics: {
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      expectancy: metrics.expectancy,
      sharpe: metrics.sharpe,
      drawdown: metrics.drawdown,
      pnlAcumulado: metrics.pnlAcumulado
    }
  };
}

export function getStrategyPerformance(): StrategyPerformanceResult {
  const groups = new Map<string, StrategyRow[]>();
  for (const row of rows()) {
    const setup = normalizeSetup(row.setup) ?? fallbackClassify(row);
    const direcao = normalizeDirection(row.direcao) ?? normalizeDirection(row.decisao);
    if (!direcao) continue;
    const timeframe = typeof row.timeframe === "string" && row.timeframe ? row.timeframe : "1m";
    const key = `${setup}|${row.ativo}|${timeframe}|${direcao}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const ranking: SetupRankingItem[] = [];
  for (const [key, groupRows] of groups.entries()) {
    const [setup, ativo, timeframe, direcao] = key.split("|") as [SetupType, string, string, Direction];
    const recentRows = groupRows.slice(-DEFAULT_LOOKBACK);
    const metrics = metricsFor(recentRows);
    const edgeScore = edgeScoreFromMetrics({
      totalTrades: metrics.totalTrades,
      profitFactor: metrics.profitFactor,
      expectancy: metrics.expectancy,
      sharpe: metrics.sharpe,
      drawdown: metrics.drawdown
    });
    const trusted = metrics.totalTrades >= MIN_TRADES_EDGE;
    ranking.push({
      setup,
      ativo,
      timeframe,
      direcao,
      ...metrics,
      edgeScore,
      trusted,
      blocked: blockedByMetrics(metrics)
    });
  }

  ranking.sort((a, b) => b.edgeScore - a.edgeScore || b.pnlAcumulado - a.pnlAcumulado);
  persistPerformance(ranking);
  const ativosMap = new Map<string, { scores: number[]; pnlAcumulado: number; totalTrades: number }>();
  for (const item of ranking.filter((r) => r.trusted)) {
    const cur = ativosMap.get(item.ativo) ?? { scores: [], pnlAcumulado: 0, totalTrades: 0 };
    cur.scores.push(item.edgeScore);
    cur.pnlAcumulado += item.pnlAcumulado;
    cur.totalTrades += item.totalTrades;
    ativosMap.set(item.ativo, cur);
  }

  return {
    generatedAt: new Date().toISOString(),
    minTrades: MIN_TRADES_EDGE,
    lookbackTrades: DEFAULT_LOOKBACK,
    ranking,
    setupsBloqueados: ranking.filter((r) => r.blocked),
    ativosMelhores: Array.from(ativosMap.entries())
      .map(([ativo, value]) => ({
        ativo,
        edgeScore: safeRound(value.scores.reduce((sum, s) => sum + s, 0) / Math.max(1, value.scores.length), 2),
        pnlAcumulado: safeRound(value.pnlAcumulado, 4),
        totalTrades: value.totalTrades
      }))
      .sort((a, b) => b.edgeScore - a.edgeScore)
  };
}
