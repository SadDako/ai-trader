import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");

interface DecisionRecord {
  decisao?: unknown;
  resultado?: unknown;
  avaliada?: unknown;
  precoEntrada?: unknown;
  precoAtual?: unknown;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  lucro: number;
  prejuizo: number;
  saldo: number;
}

function readDecisions(): DecisionRecord[] {
  if (!existsSync(DECISIONS_FILE)) return [];
  try {
    const raw = readFileSync(DECISIONS_FILE, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DecisionRecord[]) : [];
  } catch {
    return [];
  }
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function tradeReturnPct(decisao: string, precoEntrada: number, precoAtual: number): number {
  if (precoEntrada === 0) return 0;
  if (decisao === "compra") return ((precoAtual - precoEntrada) / precoEntrada) * 100;
  if (decisao === "venda") return ((precoEntrada - precoAtual) / precoEntrada) * 100;
  return 0;
}

export function computePerformance(): PerformanceMetrics {
  const decisoes = readDecisions();
  const empty: PerformanceMetrics = { totalTrades: 0, winRate: 0, lucro: 0, prejuizo: 0, saldo: 0 };
  if (decisoes.length === 0) return empty;

  let totalTrades = 0;
  let wins = 0;
  let lucro = 0;
  let prejuizo = 0;

  for (const d of decisoes) {
    const decisao = typeof d.decisao === "string" ? d.decisao : "";
    if (decisao !== "compra" && decisao !== "venda") continue;
    if (d.avaliada !== true) continue;
    if (typeof d.precoEntrada !== "number" || !Number.isFinite(d.precoEntrada)) continue;
    if (typeof d.precoAtual !== "number" || !Number.isFinite(d.precoAtual)) continue;
    if (d.resultado !== "lucro" && d.resultado !== "prejuizo" && d.resultado !== "neutro") continue;

    totalTrades += 1;
    if (d.resultado === "lucro") wins += 1;

    const ret = tradeReturnPct(decisao, d.precoEntrada, d.precoAtual);
    if (ret > 0) lucro += ret;
    else if (ret < 0) prejuizo += -ret;
  }

  if (totalTrades === 0) return empty;

  return {
    totalTrades,
    winRate: round((wins / totalTrades) * 100),
    lucro: round(lucro),
    prejuizo: round(prejuizo),
    saldo: round(lucro - prejuizo)
  };
}
