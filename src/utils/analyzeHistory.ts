import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");

interface DecisionRecord {
  ativo?: unknown;
  decisao?: unknown;
  confianca?: unknown;
  analise?: unknown;
  timestamp?: unknown;
}

export interface HistoryStats {
  total: number;
  compras: number;
  vendas: number;
  esperar: number;
  confiancaMedia: number;
}

function emptyStats(): HistoryStats {
  return { total: 0, compras: 0, vendas: 0, esperar: 0, confiancaMedia: 0 };
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

export function analyzeHistory(): HistoryStats {
  const decisoes = readDecisions();
  if (decisoes.length === 0) return emptyStats();

  const stats = emptyStats();
  let somaConfianca = 0;
  let countConfianca = 0;

  for (const d of decisoes) {
    stats.total += 1;

    if (d.decisao === "compra") stats.compras += 1;
    else if (d.decisao === "venda") stats.vendas += 1;
    else if (d.decisao === "esperar") stats.esperar += 1;

    if (typeof d.confianca === "number" && Number.isFinite(d.confianca)) {
      somaConfianca += d.confianca;
      countConfianca += 1;
    }
  }

  stats.confiancaMedia = countConfianca > 0 ? Number((somaConfianca / countConfianca).toFixed(2)) : 0;
  return stats;
}
