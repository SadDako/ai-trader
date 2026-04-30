import { computeRSI } from "./rsi.js";
import { analyzeTrend } from "./trendAnalysis.js";
import { computeMomentum } from "./momentum.js";
import { computeLearningAdjustment } from "./learning.js";

const PESO_RSI = 0.3;
const PESO_TENDENCIA = 0.3;
const PESO_MOMENTUM = 0.2;
const PESO_HISTORICO = 0.2;

export type Direcao = "compra" | "venda" | null;

export interface ScoreInput {
  closes: number[];
  direcao?: Direcao;
}

export interface ScoreResult {
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function scoreRSI(rsi: number): number {
  return clamp(Math.abs(rsi - 50) * 2, 0, 100);
}

function scoreTendencia(intensidade: number): number {
  return clamp(intensidade * 30, 0, 100);
}

function scoreMomentum(momentum: number): number {
  const FLOOR = 30;
  return clamp(FLOOR + Math.abs(momentum) * 70, FLOOR, 100);
}

function scoreHistorico(direcao: Direcao, ajusteCompra: number, ajusteVenda: number): number {
  const ajuste =
    direcao === "compra" ? ajusteCompra :
    direcao === "venda"  ? ajusteVenda  :
    (ajusteCompra + ajusteVenda) / 2;
  return clamp((ajuste - 0.5) * 100, 0, 100);
}

export function computeScore(input: ScoreInput): ScoreResult {
  const closes = Array.isArray(input.closes) ? input.closes : [];
  if (closes.length === 0) return { score: 0 };

  const { rsi } = computeRSI(closes);
  const { intensidade } = analyzeTrend(closes);
  const { momentum } = computeMomentum(closes);
  const { ajusteCompra, ajusteVenda } = computeLearningAdjustment();

  const sR = scoreRSI(rsi);
  const sT = scoreTendencia(intensidade);
  const sM = scoreMomentum(momentum);
  const sH = scoreHistorico(input.direcao ?? null, ajusteCompra, ajusteVenda);

  const total = sR * PESO_RSI + sT * PESO_TENDENCIA + sM * PESO_MOMENTUM + sH * PESO_HISTORICO;
  return { score: round(clamp(total, 0, 100)) };
}
