import type { MarketData } from "../types/index.js";

export type EvaluationResult = "acerto" | "erro" | "neutro";

export interface EvaluationOutput {
  resultado: EvaluationResult;
  variacao: number;
}

export interface EvaluationInput {
  decisao: string;
  precoEntrada: number;
  precoAtual?: number;
  market?: MarketData;
}

const NEUTRO_THRESHOLD_PCT = 0.0;

function lastClose(market: MarketData): number {
  const close = Number(market[market.length - 1]?.[4]);
  return Number.isFinite(close) ? close : NaN;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function evaluateDecision(input: EvaluationInput): EvaluationOutput {
  const precoAtual =
    typeof input.precoAtual === "number"
      ? input.precoAtual
      : input.market && input.market.length > 0
        ? lastClose(input.market)
        : NaN;

  if (
    !Number.isFinite(input.precoEntrada) ||
    !Number.isFinite(precoAtual) ||
    input.precoEntrada === 0
  ) {
    return { resultado: "neutro", variacao: 0 };
  }

  const variacao = round(((precoAtual - input.precoEntrada) / input.precoEntrada) * 100);

  if (input.decisao === "compra") {
    if (variacao > NEUTRO_THRESHOLD_PCT) return { resultado: "acerto", variacao };
    if (variacao < -NEUTRO_THRESHOLD_PCT) return { resultado: "erro", variacao };
    return { resultado: "neutro", variacao };
  }

  if (input.decisao === "venda") {
    if (variacao < -NEUTRO_THRESHOLD_PCT) return { resultado: "acerto", variacao };
    if (variacao > NEUTRO_THRESHOLD_PCT) return { resultado: "erro", variacao };
    return { resultado: "neutro", variacao };
  }

  return { resultado: "neutro", variacao };
}
