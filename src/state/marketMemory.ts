export type BreakoutDirecao = "alta" | "baixa";

export interface MarketSnapshot {
  tendencia: string;
  breakout: string;
  ultimaOportunidadeTimestamp: string | null;
  ultimoBreakoutDirecao: BreakoutDirecao | null;
  ciclosDesdeBreakout: number;
}

export interface MarketUpdate {
  tendencia: string;
  breakout: string;
}

export interface BreakoutWindow {
  direcao: BreakoutDirecao;
  ciclosDesdeBreakout: number;
}

const memoria = new Map<string, MarketSnapshot>();
const JANELA_DEFAULT = 3;

function snapshotInicial(): MarketSnapshot {
  return {
    tendencia: "lateral",
    breakout: "nenhum",
    ultimaOportunidadeTimestamp: null,
    ultimoBreakoutDirecao: null,
    ciclosDesdeBreakout: Number.POSITIVE_INFINITY
  };
}

export function updateMarketMemory(ativo: string, update: MarketUpdate): MarketSnapshot {
  const prev = memoria.get(ativo) ?? snapshotInicial();
  const houveBreakout = update.breakout === "alta" || update.breakout === "baixa";

  const ultimoBreakoutDirecao = houveBreakout
    ? (update.breakout as BreakoutDirecao)
    : prev.ultimoBreakoutDirecao;
  const ciclosDesdeBreakout = houveBreakout ? 0 : prev.ciclosDesdeBreakout + 1;

  const next: MarketSnapshot = {
    tendencia: update.tendencia,
    breakout: update.breakout,
    ultimaOportunidadeTimestamp: houveBreakout
      ? new Date().toISOString()
      : prev.ultimaOportunidadeTimestamp,
    ultimoBreakoutDirecao,
    ciclosDesdeBreakout
  };
  memoria.set(ativo, next);
  return next;
}

export function breakoutAtivo(ativo: string, janela: number = JANELA_DEFAULT): BreakoutWindow | null {
  const snap = memoria.get(ativo);
  if (!snap || !snap.ultimoBreakoutDirecao) return null;
  if (snap.ciclosDesdeBreakout <= 0) return null;
  if (snap.ciclosDesdeBreakout > janela) return null;
  return { direcao: snap.ultimoBreakoutDirecao, ciclosDesdeBreakout: snap.ciclosDesdeBreakout };
}

export function getMarketMemory(ativo: string): MarketSnapshot | null {
  return memoria.get(ativo) ?? null;
}

export function getAllMarketMemory(): Record<string, MarketSnapshot> {
  return Object.fromEntries(memoria);
}

export function clearMarketMemory(): void {
  memoria.clear();
}
