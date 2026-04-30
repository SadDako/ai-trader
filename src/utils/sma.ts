const DEFAULT_PERIOD = 9;

export interface SMAResult {
  sma: number;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeSMA(closes: number[], period: number = DEFAULT_PERIOD): SMAResult {
  if (!Array.isArray(closes) || period <= 0) return { sma: 0 };

  const series = closes.filter((c) => Number.isFinite(c));
  if (series.length < period) return { sma: 0 };

  const slice = series.slice(-period);
  const soma = slice.reduce((acc, v) => acc + v, 0);

  return { sma: round(soma / period) };
}
