import { computeSMA } from "./sma.js";
import { analyzeTrend, type Tendencia } from "./trendAnalysis.js";
import type { MarketData } from "../types/index.js";

const SMA_FAST = 9;
const SMA_SLOW = 21;
const LATERAL_DISTANCE_THRESHOLD_PCT = 0.15;
const ATR_PERIOD = 14;
const ATR_MIN_PCT = 0.05;
const VOLUME_PERIOD = 20;
const VOLUME_BREAKOUT_MULTIPLIER = 0.85;

export interface MarketQualityInput {
  lowerMarket: MarketData;
  higherMarket: MarketData;
  sinal: string;
  breakout: string;
  rsi: number;
}

export interface MarketQualityResult {
  tendenciaEntrada: Tendencia;
  tendenciaMaior: Tendencia;
  smaDistancePct: number;
  lateral: boolean;
  atr: number;
  atrPct: number;
  atrSaudavel: boolean;
  volumeAtual: number;
  volumeMedia20: number;
  volumeRelativo: number;
  volumeForte: boolean;
  multiTimeframeAlinhado: boolean;
  rsiOperacional: boolean;
  motivosBloqueio: string[];
  penalidadeScore: number;
  logContext: {
    atr: number;
    atrPct: number;
    volumeRelativo: number;
    alinhamentoMultiTimeframe: string;
  };
}

function finiteNumbers(values: unknown[]): number[] {
  return values.map(Number).filter((n) => Number.isFinite(n));
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function closesFromMarket(market: MarketData): number[] {
  return finiteNumbers(market.map((k) => k[4]));
}

function smaDistancePct(closes: number[]): number {
  const { sma: smaFast } = computeSMA(closes, SMA_FAST);
  const { sma: smaSlow } = computeSMA(closes, SMA_SLOW);
  if (!Number.isFinite(smaFast) || !Number.isFinite(smaSlow) || smaSlow === 0) return 0;
  return round(Math.abs(((smaFast - smaSlow) / smaSlow) * 100));
}

function computeAtr(market: MarketData, period = ATR_PERIOD): { atr: number; atrPct: number } {
  if (!Array.isArray(market) || market.length < period + 1) return { atr: 0, atrPct: 0 };

  const ranges: number[] = [];
  for (let i = 1; i < market.length; i += 1) {
    const high = Number(market[i][2]);
    const low = Number(market[i][3]);
    const prevClose = Number(market[i - 1][4]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const lastRanges = ranges.slice(-period);
  if (lastRanges.length < period) return { atr: 0, atrPct: 0 };

  const atr = lastRanges.reduce((sum, tr) => sum + tr, 0) / lastRanges.length;
  const lastClose = Number(market[market.length - 1][4]);
  const atrPct = Number.isFinite(lastClose) && lastClose > 0 ? (atr / lastClose) * 100 : 0;
  return { atr: round(atr, 6), atrPct: round(atrPct, 4) };
}

function computeVolume(market: MarketData, period = VOLUME_PERIOD): {
  volumeAtual: number;
  volumeMedia20: number;
  volumeRelativo: number;
} {
  const volumes = finiteNumbers(market.map((k) => k[5]));
  const volumeAtual = volumes[volumes.length - 1] ?? 0;
  const base = volumes.slice(-(period + 1), -1);
  const volumeMedia20 = base.length > 0 ? base.reduce((sum, v) => sum + v, 0) / base.length : 0;
  const volumeRelativo = volumeMedia20 > 0 ? volumeAtual / volumeMedia20 : 0;
  return {
    volumeAtual: round(volumeAtual, 6),
    volumeMedia20: round(volumeMedia20, 6),
    volumeRelativo: round(volumeRelativo, 4)
  };
}

function isRsiOperacional(sinal: string, rsi: number): boolean {
  if (sinal === "compra") return rsi >= 35 && rsi <= 78;
  if (sinal === "venda") return rsi >= 22 && rsi <= 65;
  return true;
}

function isMultiTimeframeAligned(sinal: string, tendenciaMaior: Tendencia): boolean {
  if (sinal === "compra") return tendenciaMaior === "alta";
  if (sinal === "venda") return tendenciaMaior === "baixa";
  return true;
}

export function analyzeMarketQuality(input: MarketQualityInput): MarketQualityResult {
  const lowerCloses = closesFromMarket(input.lowerMarket);
  const higherCloses = closesFromMarket(input.higherMarket);
  const tendenciaEntrada = analyzeTrend(lowerCloses).tendencia;
  const tendenciaMaior = analyzeTrend(higherCloses).tendencia;
  const distancia = smaDistancePct(lowerCloses);
  const lateral = distancia < LATERAL_DISTANCE_THRESHOLD_PCT;
  const { atr, atrPct } = computeAtr(input.lowerMarket);
  const atrSaudavel = atrPct >= ATR_MIN_PCT;
  const { volumeAtual, volumeMedia20, volumeRelativo } = computeVolume(input.lowerMarket);
  const volumeForte = volumeRelativo > VOLUME_BREAKOUT_MULTIPLIER;
  const multiTimeframeAlinhado = isMultiTimeframeAligned(input.sinal, tendenciaMaior);
  const rsiOperacional = isRsiOperacional(input.sinal, input.rsi);

  const motivosBloqueio: string[] = [];
  const hardAtrBlock = atrPct > 0 && atrPct < 0.015;
  const hardVolumeBlock = volumeMedia20 > 0 && volumeRelativo < 0.18;
  const rsiExtremoContra = (input.sinal === "compra" && input.rsi > 86) || (input.sinal === "venda" && input.rsi < 14);
  if (hardAtrBlock) motivosBloqueio.push(`ATR inviável: ${atrPct}%`);
  if (hardVolumeBlock) motivosBloqueio.push(`liquidez inviável: volume relativo ${volumeRelativo}x`);
  if (rsiExtremoContra) motivosBloqueio.push(`${input.sinal} bloqueada: RSI extremo contra ${input.rsi}`);

  const penalidadeScore =
    (lateral ? 10 : 0) +
    (!atrSaudavel ? 8 : 0) +
    (!volumeForte ? 7 : 0) +
    (!multiTimeframeAlinhado ? 6 : 0) +
    (!rsiOperacional ? 5 : 0) +
    ((input.sinal === "compra" && tendenciaEntrada !== "alta") || (input.sinal === "venda" && tendenciaEntrada !== "baixa") ? 6 : 0);

  return {
    tendenciaEntrada,
    tendenciaMaior,
    smaDistancePct: distancia,
    lateral,
    atr,
    atrPct,
    atrSaudavel,
    volumeAtual,
    volumeMedia20,
    volumeRelativo,
    volumeForte,
    multiTimeframeAlinhado,
    rsiOperacional,
    motivosBloqueio,
    penalidadeScore: clamp(penalidadeScore, 0, 32),
    logContext: {
      atr,
      atrPct,
      volumeRelativo,
      alinhamentoMultiTimeframe: multiTimeframeAlinhado
        ? `alinhado 15m=${tendenciaMaior}`
        : `desalinhado 15m=${tendenciaMaior}, entrada=${tendenciaEntrada}`
    }
  };
}
