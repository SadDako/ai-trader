import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const FORCE_EVERY_N_CYCLES = 6;
const RECENT_LOOKBACK = 4;

interface DecisionRecord {
  ativo?: unknown;
  decisao?: unknown;
}

export type ForcedDirection = "compra" | "venda" | null;

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

export function shouldForceExploration(ativo: string, momentum: number): ForcedDirection {
  const decisoesAtivo = readDecisions().filter((d) => d.ativo === ativo);
  const proximoCiclo = decisoesAtivo.length + 1;

  if (proximoCiclo % FORCE_EVERY_N_CYCLES !== 0) return null;

  const recentes = decisoesAtivo.slice(-RECENT_LOOKBACK);
  const temOperacao = recentes.some((d) => d.decisao === "compra" || d.decisao === "venda");
  if (temOperacao) return null;

  if (momentum > 0) return "compra";
  if (momentum < 0) return "venda";
  return Math.random() < 0.5 ? "compra" : "venda";
}
