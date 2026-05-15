import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeNumber, safeRound, safeBalance, clampNonNegative } from "./safeMath.js";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const TAXA_OPERACAO_PCT = 0.1;
const TAXA_TOTAL_PCT = TAXA_OPERACAO_PCT * 2;
const SALDO_FLOOR = -100; // -100% = perda total simulada
const SALDO_CEILING = 1_000_000;

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

function tradeReturnPct(decisao: string, precoEntrada: number, precoAtual: number): number {
  const pe = safeNumber(precoEntrada);
  const pa = safeNumber(precoAtual);
  if (pe === 0) return 0;
  let bruto = 0;
  if (decisao === "compra") {
    bruto = ((pa - pe) / pe) * 100;
  } else if (decisao === "venda") {
    bruto = ((pe - pa) / pe) * 100;
  } else {
    return 0;
  }
  const liquido = bruto - TAXA_TOTAL_PCT;
  return Number.isFinite(liquido) ? liquido : 0;
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
    if (!Number.isFinite(ret)) continue;
    if (ret > 0) lucro += ret;
    else if (ret < 0) prejuizo += -ret;
  }

  if (totalTrades === 0) return empty;

  // Sanitização final — sem NaN, sem Infinity, sem saldo absurdo
  const lucroSafe = clampNonNegative(lucro);
  const prejuizoSafe = clampNonNegative(prejuizo);
  const saldoSafe = safeBalance(lucroSafe - prejuizoSafe, SALDO_FLOOR, SALDO_CEILING);
  const wrSafe = totalTrades > 0 ? clampNonNegative((wins / totalTrades) * 100) : 0;

  return {
    totalTrades,
    winRate: safeRound(wrSafe),
    lucro: safeRound(lucroSafe),
    prejuizo: safeRound(prejuizoSafe),
    saldo: safeRound(saldoSafe)
  };
}
