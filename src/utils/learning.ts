import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");

const MIN_SAMPLES = 3;
const AJUSTE_MIN = 0.5;
const AJUSTE_MAX = 1.5;
const AJUSTE_NEUTRO = 1.0;

interface DecisionRecord {
  decisao?: unknown;
  resultado?: unknown;
}

export interface LearningAdjustment {
  ajusteCompra: number;
  ajusteVenda: number;
}

interface DirectionStats {
  acertos: number;
  erros: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function computeAjuste(stats: DirectionStats): number {
  const total = stats.acertos + stats.erros;
  if (total < MIN_SAMPLES) return AJUSTE_NEUTRO;
  const taxaAcerto = stats.acertos / total;
  return clamp(0.5 + taxaAcerto, AJUSTE_MIN, AJUSTE_MAX);
}

export function computeLearningAdjustment(): LearningAdjustment {
  const decisoes = readDecisions();
  const compra: DirectionStats = { acertos: 0, erros: 0 };
  const venda: DirectionStats = { acertos: 0, erros: 0 };

  for (const d of decisoes) {
    if (d.resultado !== "lucro" && d.resultado !== "prejuizo") continue;

    const bucket = d.decisao === "compra" ? compra : d.decisao === "venda" ? venda : null;
    if (!bucket) continue;

    if (d.resultado === "lucro") bucket.acertos += 1;
    else bucket.erros += 1;
  }

  return {
    ajusteCompra: Number(computeAjuste(compra).toFixed(3)),
    ajusteVenda: Number(computeAjuste(venda).toFixed(3))
  };
}
