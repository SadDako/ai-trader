import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const TRADES_BOOTSTRAP_LIMITE = 5;

interface DecisionRecord {
  decisao?: unknown;
}

export interface BootstrapStatus {
  ativo: boolean;
  total: number;
  limite: number;
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

export function checkBootstrap(): BootstrapStatus {
  const total = readDecisions().filter(
    (d) => d.decisao === "compra" || d.decisao === "venda"
  ).length;
  return { ativo: total < TRADES_BOOTSTRAP_LIMITE, total, limite: TRADES_BOOTSTRAP_LIMITE };
}
