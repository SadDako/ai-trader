const DEFAULT_PERIOD = 14;

export interface RSIResult {
  rsi: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeRSI(closes: number[], period: number = DEFAULT_PERIOD): RSIResult {
  if (!Array.isArray(closes) || period <= 0 || closes.length < period + 1) {
    return { rsi: 50 };
  }

  const series = closes.filter((c) => Number.isFinite(c));
  if (series.length < period + 1) return { rsi: 50 };

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const diff = series[i] - series[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < series.length; i++) {
    const diff = series[i] - series[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return { rsi: avgGain === 0 ? 50 : 100 };

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return { rsi: round(clamp(rsi, 0, 100)) };
}
