import type { DatasetSample } from "../utils/datasetBuilder.js";
import { safeNumber } from "../utils/safeMath.js";

// Vocabulários fixos para encoding categórico determinístico
export const SETUP_VOCAB = [
  "indefinido",
  "breakout_alta",
  "breakout_baixa",
  "rsi_oversold_compra",
  "rsi_overbought_venda",
  "trend_continuation",
  "mean_reversion",
  "scalp",
  "swing"
] as const;

export const REGIME_VOCAB = ["alta", "baixa", "lateral"] as const;

export const FEATURE_NAMES = [
  "rsi",
  "atr",
  "atr_pct",
  "momentum",
  "intensidade",
  "sma_dist_pct",
  "confianca",
  "edge_score",
  "tendencia_enc",
  "direcao_enc",
  "setup_enc",
  "rsi_dist_50",
  "abs_momentum",
  "tem_atr",
  "tem_edge"
] as const;

export const FEATURE_COUNT = FEATURE_NAMES.length;

function encodeTendencia(value: unknown): number {
  if (value === "alta") return 1;
  if (value === "baixa") return -1;
  return 0;
}

function encodeDirecao(value: unknown): number {
  if (value === "compra") return 1;
  if (value === "venda") return -1;
  return 0;
}

function encodeSetup(value: unknown): number {
  if (typeof value !== "string") return 0;
  const idx = SETUP_VOCAB.indexOf(value as (typeof SETUP_VOCAB)[number]);
  return idx >= 0 ? idx : 0;
}

export interface PredictionContext {
  rsi?: number;
  atr?: number;
  atrPct?: number;
  momentum?: number;
  intensidade?: number;
  smaDistPct?: number;
  confianca?: number;
  edgeScore?: number;
  tendencia?: string;
  direcao?: string;
  setup?: string;
}

function buildVector(input: {
  rsi: number;
  atr: number | null;
  atrPct: number | null;
  momentum: number;
  intensidade: number;
  smaDistPct: number;
  confianca: number;
  edgeScore: number | null;
  tendencia: string;
  direcao: string;
  setup: string | null;
}): number[] {
  const rsi = safeNumber(input.rsi, 50);
  const atr = safeNumber(input.atr, 0);
  const atrPct = safeNumber(input.atrPct, 0);
  const momentum = safeNumber(input.momentum, 0);
  const intensidade = safeNumber(input.intensidade, 0);
  const smaDistPct = safeNumber(input.smaDistPct, 0);
  const confianca = safeNumber(input.confianca, 0);
  const edgeScore = input.edgeScore !== null ? safeNumber(input.edgeScore, 50) : 50;

  return [
    rsi,
    atr,
    atrPct,
    momentum,
    intensidade,
    smaDistPct,
    confianca,
    edgeScore,
    encodeTendencia(input.tendencia),
    encodeDirecao(input.direcao),
    encodeSetup(input.setup),
    rsi - 50, // distância do RSI ao neutro
    Math.abs(momentum), // intensidade absoluta do momentum
    input.atr === null || !Number.isFinite(input.atr) ? 0 : 1,
    input.edgeScore === null ? 0 : 1
  ];
}

/**
 * Codifica uma amostra do dataset para vetor numérico.
 * Retorna null se a amostra contiver NaN/Infinity em features críticas.
 */
export function encodeFeatures(sample: DatasetSample): number[] | null {
  if (!Number.isFinite(sample.rsi)) return null;
  if (!Number.isFinite(sample.momentum)) return null;
  if (!Number.isFinite(sample.confianca)) return null;
  const vec = buildVector({
    rsi: sample.rsi,
    atr: sample.atr,
    atrPct: sample.atr_pct,
    momentum: sample.momentum,
    intensidade: sample.intensidade,
    smaDistPct: sample.sma_dist_pct,
    confianca: sample.confianca,
    edgeScore: sample.edge_score,
    tendencia: sample.tendencia ?? "lateral",
    direcao: sample.direcao ?? sample.decisao,
    setup: sample.setup ?? null
  });
  for (const v of vec) {
    if (!Number.isFinite(v)) return null;
  }
  return vec;
}

/**
 * Codifica um contexto runtime (orchestrator) para vetor numérico.
 */
export function encodeFeaturesFromContext(ctx: PredictionContext): number[] {
  return buildVector({
    rsi: safeNumber(ctx.rsi, 50),
    atr: ctx.atr !== undefined ? safeNumber(ctx.atr, 0) : null,
    atrPct: ctx.atrPct !== undefined ? safeNumber(ctx.atrPct, 0) : null,
    momentum: safeNumber(ctx.momentum, 0),
    intensidade: safeNumber(ctx.intensidade, 0),
    smaDistPct: safeNumber(ctx.smaDistPct, 0),
    confianca: safeNumber(ctx.confianca, 0),
    edgeScore: ctx.edgeScore !== undefined ? safeNumber(ctx.edgeScore, 50) : null,
    tendencia: ctx.tendencia ?? "lateral",
    direcao: ctx.direcao ?? "esperar",
    setup: ctx.setup ?? null
  });
}

/**
 * Target binário: 1 se o trade fechou positivo (líquido), 0 se negativo.
 * Retorna null se não há rótulo válido.
 */
export function encodeTarget(sample: DatasetSample): number | null {
  if (sample.avaliada !== 1) return null;
  if (sample.pnl_pct === null || !Number.isFinite(sample.pnl_pct)) return null;
  return sample.pnl_pct > 0 ? 1 : 0;
}
