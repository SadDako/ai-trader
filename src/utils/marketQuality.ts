import { db } from "../state/database.js";
import type { MarketData } from "../types/index.js";
import { computeTradeMetrics } from "./riskManager.js";
import { safeRound } from "./safeMath.js";

export type MarketQualityLabel = "EXCELENTE" | "BOA" | "NEUTRA" | "RUIM" | "PÉSSIMA";

export interface MarketQualityAssessment {
  score: number;
  label: MarketQualityLabel;
  operavel: boolean;
  premiumOnly: boolean;
  scoreDelta: number;
  motivoPrincipal: string;
  metrics: {
    atrPct: number;
    rangeExpansion: number;
    compression: number;
    cleanMomentum: number;
    noise: number;
    volumeRelativo: number;
    trendCleanliness: number;
    lateralization: number;
    wickNoise: number;
    directionalConsistency: number;
  };
}

export interface MarketQualityStatsItem {
  label: MarketQualityLabel;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  drawdown: number;
}

export interface MarketQualityStatsResult {
  generatedAt: string;
  minTrades: number;
  ranking: MarketQualityStatsItem[];
}

const MIN_STATS_TRADES = 10;

interface QualityRow {
  resultado: string;
  decisao: string;
  preco_entrada: number;
  preco_atual: number;
  lucro_prejuizo?: number | null;
  market_quality_label?: string | null;
}

const stmtQualityRows = db.prepare(`
  SELECT resultado, decisao, preco_entrada, preco_atual, lucro_prejuizo, market_quality_label
  FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
`);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finite(values: unknown[]): number[] {
  return values.map(Number).filter((n) => Number.isFinite(n));
}

function fallback(): MarketQualityAssessment {
  return {
    score: 50,
    label: "NEUTRA",
    operavel: true,
    premiumOnly: true,
    scoreDelta: 0,
    motivoPrincipal: "fallback neutro: dados insuficientes",
    metrics: {
      atrPct: 0,
      rangeExpansion: 1,
      compression: 0,
      cleanMomentum: 0,
      noise: 0,
      volumeRelativo: 1,
      trendCleanliness: 0,
      lateralization: 0,
      wickNoise: 0,
      directionalConsistency: 0
    }
  };
}

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (slice.length < period) return 0;
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

function atrPct(market: MarketData, period = 14): number {
  if (market.length < period + 1) return 0;
  const ranges: number[] = [];
  for (let i = 1; i < market.length; i += 1) {
    const high = Number(market[i][2]);
    const low = Number(market[i][3]);
    const prevClose = Number(market[i - 1][4]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const last = ranges.slice(-period);
  const close = Number(market[market.length - 1]?.[4]);
  if (last.length < period || !Number.isFinite(close) || close <= 0) return 0;
  return (last.reduce((sum, tr) => sum + tr, 0) / last.length / close) * 100;
}

function rangePct(market: MarketData, lookback: number): number {
  const slice = market.slice(-lookback);
  const highs = finite(slice.map((k) => k[2]));
  const lows = finite(slice.map((k) => k[3]));
  const close = Number(slice[slice.length - 1]?.[4]);
  if (!highs.length || !lows.length || !Number.isFinite(close) || close <= 0) return 0;
  return ((Math.max(...highs) - Math.min(...lows)) / close) * 100;
}

function volumeRelativo(market: MarketData, period = 20): number {
  const volumes = finite(market.map((k) => k[5]));
  const atual = volumes[volumes.length - 1] ?? 0;
  const base = volumes.slice(-(period + 1), -1);
  const media = base.length ? base.reduce((sum, v) => sum + v, 0) / base.length : 0;
  return media > 0 ? atual / media : 1;
}

function directionalConsistency(closes: number[], lookback = 12): number {
  const slice = closes.slice(-(lookback + 1));
  if (slice.length < 2) return 0;
  let up = 0;
  let down = 0;
  for (let i = 1; i < slice.length; i += 1) {
    if (slice[i] > slice[i - 1]) up += 1;
    else if (slice[i] < slice[i - 1]) down += 1;
  }
  return Math.max(up, down) / Math.max(1, slice.length - 1);
}

function wickNoise(market: MarketData, lookback = 20): number {
  const slice = market.slice(-lookback);
  const values = slice.map((k) => {
    const open = Number(k[1]);
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    const range = high - low;
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || range <= 0) return 0;
    const body = Math.abs(close - open);
    return clamp((range - body) / range, 0, 1);
  });
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function labelFor(score: number): MarketQualityLabel {
  if (score >= 80) return "EXCELENTE";
  if (score >= 60) return "BOA";
  if (score >= 40) return "NEUTRA";
  if (score >= 25) return "RUIM";
  return "PÉSSIMA";
}

function principalReason(metrics: MarketQualityAssessment["metrics"], score: number): string {
  if (score < 40) {
    if (metrics.noise > 0.62) return "ruído e wick noise elevados";
    if (metrics.lateralization > 0.7) return "lateralização dominante";
    if (metrics.atrPct < 0.06) return "volatilidade útil insuficiente";
    if (metrics.volumeRelativo < 0.8) return "volume relativo fraco";
    return "qualidade agregada baixa";
  }
  if (score > 80) return "mercado limpo com volatilidade útil";
  if (score > 60) return "condições operáveis";
  return "operável apenas para setups premium";
}

export function assessMarketQuality(market: MarketData): MarketQualityAssessment {
  try {
    if (!Array.isArray(market) || market.length < 30) return fallback();
    const closes = finite(market.map((k) => k[4]));
    if (closes.length < 30) return fallback();

    const currentAtrPct = atrPct(market);
    const shortRange = rangePct(market, 12);
    const longRange = rangePct(market, 36);
    const rangeExpansion = longRange > 0 ? shortRange / longRange : 1;
    const compression = clamp(1 - rangeExpansion, 0, 1);
    const mom3 = closes.length > 3 ? ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100 : 0;
    const mom8 = closes.length > 8 ? ((closes[closes.length - 1] - closes[closes.length - 9]) / closes[closes.length - 9]) * 100 : 0;
    const cleanMomentum = Math.abs(mom8) > 0 ? clamp(Math.abs(mom3 / mom8), 0, 2) / 2 : 0;
    const volRel = volumeRelativo(market);
    const sma9 = sma(closes, 9);
    const sma21 = sma(closes, 21);
    const smaDist = sma21 > 0 ? Math.abs(((sma9 - sma21) / sma21) * 100) : 0;
    const lateralization = clamp((0.18 - smaDist) / 0.18, 0, 1);
    const consistency = directionalConsistency(closes);
    const wick = wickNoise(market);
    const trendCleanliness = clamp((smaDist / 0.5) * 0.55 + consistency * 0.45, 0, 1);
    const noise = clamp(wick * 0.65 + (1 - consistency) * 0.35, 0, 1);

    const usefulVolScore = clamp((currentAtrPct - 0.05) / 0.25, 0, 1) * 100;
    const rangeScore = clamp(rangeExpansion, 0, 1.8) / 1.8 * 100;
    const momentumScore = cleanMomentum * 100;
    const volumeScore = clamp(volRel / 1.3, 0, 1) * 100;
    const trendScore = trendCleanliness * 100;
    const noiseScore = (1 - noise) * 100;
    const lateralPenalty = lateralization * 22;
    const wickPenalty = wick * 18;
    const compressionPenalty = compression * 14;

    const score = clamp(
      usefulVolScore * 0.2 +
      rangeScore * 0.12 +
      momentumScore * 0.16 +
      volumeScore * 0.16 +
      trendScore * 0.18 +
      noiseScore * 0.18 -
      lateralPenalty -
      wickPenalty -
      compressionPenalty,
      0,
      100
    );
    const roundedScore = safeRound(score, 2);
    const label = labelFor(roundedScore);

    return {
      score: roundedScore,
      label,
      operavel: roundedScore >= 22,
      premiumOnly: roundedScore >= 22 && roundedScore < 45,
      scoreDelta: roundedScore > 80 ? 8 : roundedScore > 60 ? 2 : roundedScore >= 40 ? -5 : roundedScore >= 22 ? -12 : -24,
      motivoPrincipal: principalReason({
        atrPct: currentAtrPct,
        rangeExpansion,
        compression,
        cleanMomentum,
        noise,
        volumeRelativo: volRel,
        trendCleanliness,
        lateralization,
        wickNoise: wick,
        directionalConsistency: consistency
      }, roundedScore),
      metrics: {
        atrPct: round(currentAtrPct),
        rangeExpansion: round(rangeExpansion),
        compression: round(compression),
        cleanMomentum: round(cleanMomentum),
        noise: round(noise),
        volumeRelativo: round(volRel),
        trendCleanliness: round(trendCleanliness),
        lateralization: round(lateralization),
        wickNoise: round(wick),
        directionalConsistency: round(consistency)
      }
    };
  } catch {
    return fallback();
  }
}

function normalizeLabel(value: unknown): MarketQualityLabel {
  return value === "EXCELENTE" || value === "BOA" || value === "NEUTRA" || value === "RUIM" || value === "PÉSSIMA"
    ? value
    : "NEUTRA";
}

function rowPnl(row: QualityRow): number {
  const stored = Number(row.lucro_prejuizo);
  if (row.lucro_prejuizo !== null && row.lucro_prejuizo !== undefined && Number.isFinite(stored)) return stored;
  const pe = Number(row.preco_entrada);
  const pa = Number(row.preco_atual);
  if (!Number.isFinite(pe) || !Number.isFinite(pa) || pe <= 0 || pa <= 0) return 0;
  if (row.decisao === "compra") return ((pa - pe) / pe) * 100;
  if (row.decisao === "venda") return ((pe - pa) / pe) * 100;
  return 0;
}

export function getMarketQualityStats(): MarketQualityStatsResult {
  const rows = stmtQualityRows.all() as unknown as QualityRow[];
  const grouped = new Map<MarketQualityLabel, QualityRow[]>();
  for (const row of rows) {
    const label = normalizeLabel(row.market_quality_label);
    const bucket = grouped.get(label) ?? [];
    bucket.push(row);
    grouped.set(label, bucket);
  }

  const ranking: MarketQualityStatsItem[] = [];
  for (const [label, groupRows] of grouped.entries()) {
    const pnls = groupRows.map(rowPnl);
    const wins = pnls.filter((p) => p > 0).length;
    const equityCurve = pnls.reduce<Array<{ equity: number }>>((acc, pnl) => {
      const prev = acc.length ? acc[acc.length - 1].equity : 1000;
      acc.push({ equity: prev + pnl });
      return acc;
    }, []);
    const metrics = computeTradeMetrics(pnls, equityCurve);
    ranking.push({
      label,
      totalTrades: groupRows.length,
      winRate: groupRows.length ? safeRound((wins / groupRows.length) * 100, 2) : 0,
      profitFactor: Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 999,
      expectancy: metrics.expectancy,
      drawdown: metrics.maxDrawdown
    });
  }

  ranking.sort((a, b) => b.expectancy - a.expectancy);
  return {
    generatedAt: new Date().toISOString(),
    minTrades: MIN_STATS_TRADES,
    ranking
  };
}
