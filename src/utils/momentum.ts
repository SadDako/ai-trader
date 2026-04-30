const DEFAULT_LOOKBACK = 10;

export interface MomentumResult {
  momentum: number;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeMomentum(closes: number[], lookback: number = DEFAULT_LOOKBACK): MomentumResult {
  if (!Array.isArray(closes) || lookback <= 0) return { momentum: 0 };

  const series = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (series.length < 2) return { momentum: 0 };

  const window = series.slice(-(lookback + 1));
  if (window.length < 2) return { momentum: 0 };

  let soma = 0;
  let count = 0;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    if (prev === 0) continue;
    soma += ((curr - prev) / prev) * 100;
    count += 1;
  }

  if (count === 0) return { momentum: 0 };
  return { momentum: round(soma / count) };
}
