import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const LIMITE_INATIVIDADE = 15;
const LIMITE_BAIXA_FREQUENCIA = 10;

interface DecisionRecord {
  ativo?: unknown;
  decisao?: unknown;
}

export interface InactivityStatus {
  ativa: boolean;
  ciclosEsperar: number;
  limite: number;
}

export interface LowFrequencyStatus {
  ativa: boolean;
  ciclosSemOperacao: number;
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

export function checkInactivity(ativo: string): InactivityStatus {
  const decisoes = readDecisions().filter((d) => d.ativo === ativo);
  let count = 0;
  for (let i = decisoes.length - 1; i >= 0; i--) {
    if (decisoes[i].decisao === "esperar") count += 1;
    else break;
  }
  return { ativa: count >= LIMITE_INATIVIDADE, ciclosEsperar: count, limite: LIMITE_INATIVIDADE };
}

export function checkLowFrequency(ativo: string): LowFrequencyStatus {
  const decisoes = readDecisions().filter((d) => d.ativo === ativo);
  let count = 0;
  for (let i = decisoes.length - 1; i >= 0; i--) {
    if (decisoes[i].decisao === "compra" || decisoes[i].decisao === "venda") break;
    count += 1;
  }
  return {
    ativa: count >= LIMITE_BAIXA_FREQUENCIA,
    ciclosSemOperacao: count,
    limite: LIMITE_BAIXA_FREQUENCIA
  };
}
