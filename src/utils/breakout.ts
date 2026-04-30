const DEFAULT_LOOKBACK = 10;

export type Breakout = "alta" | "baixa" | "nenhum";

export interface BreakoutResult {
  breakout: Breakout;
}

export function detectBreakout(closes: number[], lookback: number = DEFAULT_LOOKBACK): BreakoutResult {
  if (!Array.isArray(closes) || lookback <= 0) return { breakout: "nenhum" };

  const series = closes.filter((c) => Number.isFinite(c));
  if (series.length < lookback + 1) return { breakout: "nenhum" };

  const atual = series[series.length - 1];
  const janela = series.slice(-(lookback + 1), -1);

  const maxRecente = Math.max(...janela);
  const minRecente = Math.min(...janela);

  if (atual > maxRecente) return { breakout: "alta" };
  if (atual < minRecente) return { breakout: "baixa" };
  return { breakout: "nenhum" };
}
