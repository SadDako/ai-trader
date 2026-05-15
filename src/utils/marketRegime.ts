import { getMarketData } from "../services/market.service.js";
import type { MarketData } from "../types/index.js";
import type { SetupType } from "./strategyIntelligence.js";

export type MarketRegime =
  | "TRENDING_BULL"
  | "TRENDING_BEAR"
  | "SIDEWAYS"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "BREAKOUT_EXPANSION"
  | "MEAN_REVERSION"
  | "NEUTRAL";

export interface MarketRegimeMetrics {
  atr: number;
  atrPct: number;
  smaDistancePct: number;
  volumeRelativo: number;
  momentum: number;
  momentumAcceleration: number;
  rangeWidthPct: number;
  volatilityExpansion: number;
}

export interface MarketRegimeResult {
  regime: MarketRegime;
  confidence: number;
  metrics: MarketRegimeMetrics;
  setupsFavorecidos: SetupType[];
  setupsPenalizados: SetupType[];
}

const CONFIDENCE_MIN = 60;

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nums(values: unknown[]): number[] {
  return values.map(Number).filter((n) => Number.isFinite(n));
}

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (slice.length < period) return 0;
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

function atr(market: MarketData, period = 14): number {
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
  return last.length ? last.reduce((sum, v) => sum + v, 0) / last.length : 0;
}

function momentum(values: number[], lookback: number): number {
  if (values.length < lookback + 1) return 0;
  const prev = values[values.length - 1 - lookback];
  const curr = values[values.length - 1];
  return prev > 0 ? ((curr - prev) / prev) * 100 : 0;
}

function rangeWidthPct(market: MarketData, lookback = 20): number {
  const slice = market.slice(-lookback);
  const highs = nums(slice.map((k) => k[2]));
  const lows = nums(slice.map((k) => k[3]));
  const closes = nums(slice.map((k) => k[4]));
  const last = closes[closes.length - 1] ?? 0;
  if (!highs.length || !lows.length || last <= 0) return 0;
  return ((Math.max(...highs) - Math.min(...lows)) / last) * 100;
}

function volumeRelativo(market: MarketData, period = 20): number {
  const volumes = nums(market.map((k) => k[5]));
  const current = volumes[volumes.length - 1] ?? 0;
  const base = volumes.slice(-(period + 1), -1);
  const avg = base.length ? base.reduce((sum, v) => sum + v, 0) / base.length : 0;
  return avg > 0 ? current / avg : 0;
}

function volatilityExpansion(market: MarketData): number {
  const current = atr(market.slice(-15), 14);
  const previous = atr(market.slice(-30, -14), 14);
  return previous > 0 ? current / previous : 0;
}

function regimeSetups(regime: MarketRegime): { favored: SetupType[]; penalized: SetupType[] } {
  switch (regime) {
    case "TRENDING_BULL":
      return { favored: ["trend_follow", "breakout"], penalized: ["lateral_range", "reversal"] };
    case "TRENDING_BEAR":
      return { favored: ["trend_follow", "reversal"], penalized: ["lateral_range"] };
    case "SIDEWAYS":
      return { favored: ["scalp", "lateral_range"], penalized: ["breakout", "trend_follow"] };
    case "HIGH_VOLATILITY":
      return { favored: ["breakout"], penalized: ["reversal", "scalp"] };
    case "LOW_VOLATILITY":
      return { favored: ["scalp"], penalized: ["breakout", "trend_follow"] };
    case "BREAKOUT_EXPANSION":
      return { favored: ["breakout", "trend_follow"], penalized: ["lateral_range"] };
    case "MEAN_REVERSION":
      return { favored: ["reversal", "lateral_range"], penalized: ["breakout"] };
    default:
      return { favored: [], penalized: [] };
  }
}

export function setupRegimeScoreDelta(setup: SetupType, regime: MarketRegime, confidence: number): number {
  if (confidence < CONFIDENCE_MIN || regime === "NEUTRAL") return 0;
  const { favored, penalized } = regimeSetups(regime);
  if (favored.includes(setup)) return 8;
  if (penalized.includes(setup)) return -12;
  return 0;
}

export function isSetupPenalizedByRegime(setup: SetupType, regime: MarketRegime, confidence: number): boolean {
  if (confidence < CONFIDENCE_MIN || regime === "NEUTRAL") return false;
  return regimeSetups(regime).penalized.includes(setup);
}

export function detectMarketRegime(market: MarketData): MarketRegimeResult {
  const closes = nums(market.map((k) => k[4]));
  const lastClose = closes[closes.length - 1] ?? 0;
  const atrValue = atr(market, 14);
  const atrPct = lastClose > 0 ? (atrValue / lastClose) * 100 : 0;
  const sma9 = sma(closes, 9);
  const sma21 = sma(closes, 21);
  const smaDistancePct = sma21 > 0 ? ((sma9 - sma21) / sma21) * 100 : 0;
  const volRel = volumeRelativo(market, 20);
  const momFast = momentum(closes, 5);
  const momSlow = momentum(closes, 12);
  const momAcceleration = momFast - momSlow;
  const rangePct = rangeWidthPct(market, 20);
  const volExpansion = volatilityExpansion(market);

  const metrics: MarketRegimeMetrics = {
    atr: round(atrValue, 8),
    atrPct: round(atrPct, 4),
    smaDistancePct: round(smaDistancePct, 4),
    volumeRelativo: round(volRel, 4),
    momentum: round(momFast, 4),
    momentumAcceleration: round(momAcceleration, 4),
    rangeWidthPct: round(rangePct, 4),
    volatilityExpansion: round(volExpansion, 4)
  };

  const candidates: Array<{ regime: MarketRegime; score: number }> = [
    { regime: "BREAKOUT_EXPANSION", score: (volRel - 1.1) * 30 + (volExpansion - 1) * 45 + Math.abs(smaDistancePct) * 20 + Math.abs(momAcceleration) * 6 },
    { regime: "TRENDING_BULL", score: smaDistancePct * 80 + momFast * 10 + atrPct * 15 },
    { regime: "TRENDING_BEAR", score: -smaDistancePct * 80 + -momFast * 10 + atrPct * 15 },
    { regime: "SIDEWAYS", score: (0.18 - Math.abs(smaDistancePct)) * 170 + (1.2 - rangePct) * 18 + (1.15 - volExpansion) * 20 },
    { regime: "HIGH_VOLATILITY", score: atrPct * 160 + (volExpansion - 1) * 35 + rangePct * 10 },
    { regime: "LOW_VOLATILITY", score: (0.08 - atrPct) * 420 + (1 - volExpansion) * 35 + (1 - volRel) * 15 },
    { regime: "MEAN_REVERSION", score: (rangePct > 0 ? 22 : 0) + (Math.abs(momFast) > 0.12 && Math.sign(momFast) !== Math.sign(momAcceleration) ? 35 : 0) + (0.25 - Math.abs(smaDistancePct)) * 80 }
  ];

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? { regime: "NEUTRAL" as const, score: 0 };
  const second = candidates[1]?.score ?? 0;
  const confidence = clamp(50 + best.score * 0.7 + Math.max(0, best.score - second) * 0.35, 0, 100);
  const finalRegime = confidence >= CONFIDENCE_MIN ? best.regime : "NEUTRAL";
  const { favored, penalized } = regimeSetups(finalRegime);

  return {
    regime: finalRegime,
    confidence: round(confidence, 2),
    metrics,
    setupsFavorecidos: favored,
    setupsPenalizados: penalized
  };
}

export async function getCurrentMarketRegime(symbol = "BTCUSDT", interval = "1m"): Promise<MarketRegimeResult & { ativo: string; timeframe: string }> {
  const ativo = symbol.trim().toUpperCase() || "BTCUSDT";
  const market = await getMarketData(ativo, interval, 120);
  return {
    ativo,
    timeframe: interval,
    ...detectMarketRegime(market)
  };
}
