import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const MIN_SAMPLES_TENDENCIA = 2;

interface DecisionRecord {
  decisao?: unknown;
  resultado?: unknown;
  tendencia?: unknown;
  forca?: unknown;
  analise?: unknown;
}

export interface PatternAnalysis {
  melhorTendencia: string;
  piorTendencia: string;
  forcaMediaAcertos: number;
  forcaMediaErros: number;
}

interface TendenciaStats {
  acertos: number;
  total: number;
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

function pickTendencia(d: DecisionRecord): string | null {
  if (typeof d.tendencia === "string") return d.tendencia;
  if (d.analise && typeof d.analise === "object") {
    const t = (d.analise as Record<string, unknown>).tendencia;
    if (typeof t === "string") return t;
  }
  return null;
}

function pickForca(d: DecisionRecord): number | null {
  if (typeof d.forca === "number" && Number.isFinite(d.forca)) return d.forca;
  if (d.analise && typeof d.analise === "object") {
    const f = (d.analise as Record<string, unknown>).forca;
    if (typeof f === "number" && Number.isFinite(f)) return f;
  }
  return null;
}

function media(values: number[]): number {
  if (values.length === 0) return 0;
  const soma = values.reduce((a, b) => a + b, 0);
  return Number((soma / values.length).toFixed(2));
}

export function analyzePatterns(): PatternAnalysis {
  const decisoes = readDecisions();
  const porTendencia = new Map<string, TendenciaStats>();
  const forcasAcertos: number[] = [];
  const forcasErros: number[] = [];

  for (const d of decisoes) {
    if (d.resultado !== "lucro" && d.resultado !== "prejuizo") continue;

    const tendencia = pickTendencia(d);
    const forca = pickForca(d);
    const acertou = d.resultado === "lucro";

    if (tendencia) {
      const stats = porTendencia.get(tendencia) ?? { acertos: 0, total: 0 };
      stats.total += 1;
      if (acertou) stats.acertos += 1;
      porTendencia.set(tendencia, stats);
    }

    if (forca !== null) {
      if (acertou) forcasAcertos.push(forca);
      else forcasErros.push(forca);
    }
  }

  let melhor = { nome: "indefinido", taxa: -Infinity };
  let pior = { nome: "indefinido", taxa: Infinity };

  for (const [nome, stats] of porTendencia.entries()) {
    if (stats.total < MIN_SAMPLES_TENDENCIA) continue;
    const taxa = stats.acertos / stats.total;
    if (taxa > melhor.taxa) melhor = { nome, taxa };
    if (taxa < pior.taxa) pior = { nome, taxa };
  }

  return {
    melhorTendencia: melhor.nome,
    piorTendencia: pior.nome,
    forcaMediaAcertos: media(forcasAcertos),
    forcaMediaErros: media(forcasErros)
  };
}
