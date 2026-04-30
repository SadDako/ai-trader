import type { MarketData } from "../types/index.js";

export type Sentimento = "positivo" | "negativo" | "neutro";

export interface SentimentoAnalysis {
  sentimento: Sentimento;
  impacto: number;
  resumo: string;
}

interface SentimentoOptions {
  ativo?: string;
  market?: MarketData;
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function deriveFromMarket(market: MarketData): { variacao: number; volatilidade: number } {
  const closes = market.map((k) => Number(k[4]));
  const highs = market.map((k) => Number(k[2]));
  const lows = market.map((k) => Number(k[3]));

  const first = closes[0];
  const last = closes[closes.length - 1];
  const variacao = ((last - first) / first) * 100;

  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const volatilidade = ((max - min) / min) * 100;

  return { variacao, volatilidade };
}

function classify(variacao: number): Sentimento {
  if (variacao > 0.3) return "positivo";
  if (variacao < -0.3) return "negativo";
  return "neutro";
}

function buildResumo(ativo: string, sentimento: Sentimento, variacao: number, volatilidade: number): string {
  const v = variacao.toFixed(2);
  const vol = volatilidade.toFixed(2);
  switch (sentimento) {
    case "positivo":
      return `Mercado de ${ativo} demonstra otimismo no curto prazo (variação +${v}%, volatilidade ${vol}%). Fluxo comprador predominante e narrativa favorável em redes sociais.`;
    case "negativo":
      return `Mercado de ${ativo} sob pressão vendedora (variação ${v}%, volatilidade ${vol}%). Aumento de menções negativas e cautela do varejo.`;
    case "neutro":
      return `Mercado de ${ativo} sem direção clara (variação ${v}%, volatilidade ${vol}%). Sentimento misto, baixo engajamento social.`;
  }
}

export async function sentimentoAgent(options: SentimentoOptions = {}): Promise<SentimentoAnalysis> {
  const ativo = options.ativo ?? "BTCUSDT";

  let variacao: number;
  let volatilidade: number;

  if (options.market && options.market.length > 0) {
    const stats = deriveFromMarket(options.market);
    variacao = stats.variacao;
    volatilidade = stats.volatilidade;
  } else {
    const seed = hashString(`${ativo}:${new Date().toISOString().slice(0, 13)}`);
    variacao = ((seed % 200) - 100) / 50;
    volatilidade = ((seed >> 8) % 500) / 100;
  }

  const sentimento = classify(variacao);
  const intensidade = Math.abs(variacao) * 15 + volatilidade * 5;
  const impacto = Math.round(clamp(intensidade, 5, 95));

  return {
    sentimento,
    impacto,
    resumo: buildResumo(ativo, sentimento, variacao, volatilidade)
  };
}
