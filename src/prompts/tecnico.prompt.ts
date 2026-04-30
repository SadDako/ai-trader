import type { MarketData } from "../types/index.js";

interface CandleStats {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  ultimo: number;
  primeiro: number;
  maximo: number;
  minimo: number;
  mediaVolume: number;
  variacaoPct: string;
  amplitudePct: string;
  smaCurta: number;
  smaLonga: number;
  desvioPct: string;
}

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((acc, v) => acc + v, 0) / slice.length;
}

function computeStats(data: MarketData): CandleStats {
  const closes = data.map((k) => Number(k[4]));
  const highs = data.map((k) => Number(k[2]));
  const lows = data.map((k) => Number(k[3]));
  const volumes = data.map((k) => Number(k[5]));

  const ultimo = closes[closes.length - 1];
  const primeiro = closes[0];
  const maximo = Math.max(...highs);
  const minimo = Math.min(...lows);
  const mediaVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  const smaCurta = sma(closes, 9);
  const smaLonga = sma(closes, 21);

  const variacaoPct = (((ultimo - primeiro) / primeiro) * 100).toFixed(2);
  const amplitudePct = (((maximo - minimo) / minimo) * 100).toFixed(2);
  const desvioPct = (((ultimo - smaLonga) / smaLonga) * 100).toFixed(2);

  return {
    closes,
    highs,
    lows,
    volumes,
    ultimo,
    primeiro,
    maximo,
    minimo,
    mediaVolume,
    variacaoPct,
    amplitudePct,
    smaCurta,
    smaLonga,
    desvioPct
  };
}

export function buildTecnicoPrompt(data: MarketData): string {
  const s = computeStats(data);

  return `Você é um analista técnico sênior de criptomoedas, especializado em price action, momentum e reversão de tendência em timeframes curtos (1m).

# Dados de mercado
- Total de candles: ${data.length} (1m)
- Preço inicial: ${s.primeiro}
- Preço atual: ${s.ultimo}
- Máxima do período: ${s.maximo}
- Mínima do período: ${s.minimo}
- Variação no período: ${s.variacaoPct}%
- Amplitude (high-low): ${s.amplitudePct}%
- Volume médio: ${s.mediaVolume.toFixed(2)}
- SMA(9): ${s.smaCurta.toFixed(2)}
- SMA(21): ${s.smaLonga.toFixed(2)}
- Desvio do preço atual vs SMA(21): ${s.desvioPct}%

# Série de fechamento (últimos ${s.closes.length} candles)
${JSON.stringify(s.closes)}

# Série de máximas
${JSON.stringify(s.highs)}

# Série de mínimas
${JSON.stringify(s.lows)}

# Tarefa
Analise os dados acima considerando, nesta ordem:
1. **Tendência** — direção predominante (alta, baixa ou lateral) com base no relacionamento entre SMA(9), SMA(21) e ação do preço.
2. **Força da tendência** — intensidade do movimento numa escala 0-100, onde 0 = mercado totalmente lateralizado/sem direção, 50 = direção clara mas com volume médio, 100 = movimento explosivo com momentum forte e volume crescente.
3. **Possível reversão** — identifique sinais de exaustão: divergências preço/volume, candles de rejeição (pavios longos), distância excessiva da SMA(21), padrões de topo/fundo. Considere isso ao definir o sinal.
4. **Sinal operacional** — "compra" se a confluência sugere entrada long, "venda" se sugere short, "esperar" se há indefinição, sinal misto ou risco/retorno ruim.
5. **Entrada ideal** — preço sugerido para entrada (number). Use null se o sinal for "esperar" ou se não houver zona clara de entrada (ex.: pullback à SMA(9), retest de suporte/resistência, breakout confirmado). NUNCA invente: se não há gatilho técnico claro, retorne null.

# Regras de saída
- Responda **EXCLUSIVAMENTE** com um JSON válido. Nenhum texto antes ou depois. Sem blocos \`\`\`markdown\`\`\`.
- Todos os campos são obrigatórios.
- "forca" deve ser inteiro entre 0 e 100.
- "entrada_ideal" deve ser number (com até 2 casas decimais) ou null.
- "justificativa" deve ter no máximo 280 caracteres, citando objetivamente o que sustenta a decisão (ex.: "SMA9 cruzou SMA21 pra cima, volume crescente, sem divergência").

# Formato exato da resposta
{
  "tendencia": "alta" | "baixa" | "lateral",
  "forca": 0-100,
  "sinal": "compra" | "venda" | "esperar",
  "entrada_ideal": number | null,
  "justificativa": "texto curto e objetivo"
}`;
}
