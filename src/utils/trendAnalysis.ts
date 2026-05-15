import { computeSMA } from "./sma.js";

const PERIOD_CURTO = 9;
const PERIOD_LONGO = 21;
const LATERAL_THRESHOLD_PCT = 0.15;

export type Tendencia = "alta" | "baixa" | "lateral";

export interface TrendAnalysis {
  tendencia: Tendencia;
  intensidade: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function analyzeTrend(closes: number[]): TrendAnalysis {
  const { sma: smaCurta } = computeSMA(closes, PERIOD_CURTO);
  const { sma: smaLonga } = computeSMA(closes, PERIOD_LONGO);

  if (smaLonga === 0) return { tendencia: "lateral", intensidade: 0 };

  const diffPct = ((smaCurta - smaLonga) / smaLonga) * 100;
  const intensidade = round(clamp(Math.abs(diffPct), 0, 100));

  let tendencia: Tendencia;
  if (intensidade < LATERAL_THRESHOLD_PCT) tendencia = "lateral";
  else if (diffPct > 0) tendencia = "alta";
  else tendencia = "baixa";

  return { tendencia, intensidade };
}
