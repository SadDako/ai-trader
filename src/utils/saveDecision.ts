import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const DECISIONS_FILE = resolve(DATA_DIR, "decisions.json");
const DELAY_CYCLES = 3;
const TAKE_PROFIT_PCT = 1.5;
const STOP_LOSS_PCT = 1.0;

export type Resultado = "lucro" | "prejuizo" | "neutro";

export interface DecisionInput {
  ativo: string;
  decisao: string;
  confianca: number;
  analise: object;
  precoEntrada: number;
  tendencia?: string;
  forca?: number;
  rsi?: number;
  momentum?: number;
  intensidade?: number;
}

export interface DecisionRecord {
  ativo: string;
  decisao: string;
  confianca: number;
  analise: object;
  tendencia: string;
  forca: number;
  precoEntrada: number;
  precoAtual: number;
  timestamp: string;
  resultado: Resultado;
  avaliada: boolean;
  rsi: number;
  momentum: number;
  intensidade: number;
  resolveuPrejuizo: boolean;
}

function ensureFile(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(filePath)) writeFileSync(filePath, "[]", "utf-8");
}

function readDecisions(filePath: string): DecisionRecord[] {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DecisionRecord[]) : [];
  } catch {
    return [];
  }
}

function extractContext(
  analise: object,
  fallbackTendencia?: string,
  fallbackForca?: number
): { tendencia: string; forca: number } {
  const obj = analise as Record<string, unknown>;
  const tendencia =
    typeof fallbackTendencia === "string"
      ? fallbackTendencia
      : typeof obj.tendencia === "string"
        ? obj.tendencia
        : "lateral";
  const forca =
    typeof fallbackForca === "number"
      ? fallbackForca
      : typeof obj.forca === "number"
        ? obj.forca
        : 0;
  return { tendencia, forca };
}

function computeResultado(decisao: string, precoEntrada: number, precoFuturo: number): Resultado {
  if (!Number.isFinite(precoEntrada) || !Number.isFinite(precoFuturo)) return "neutro";
  const diff = precoFuturo - precoEntrada;
  if (decisao === "compra") {
    if (diff > 0) return "lucro";
    if (diff < 0) return "prejuizo";
    return "neutro";
  }
  if (decisao === "venda") {
    if (diff < 0) return "lucro";
    if (diff > 0) return "prejuizo";
    return "neutro";
  }
  return "neutro";
}

function countSameAtivoAfter(decisoes: DecisionRecord[], ativo: string, fromIdx: number): number {
  let count = 0;
  for (let j = fromIdx + 1; j < decisoes.length; j++) {
    if (decisoes[j].ativo === ativo) count += 1;
  }
  return count;
}

interface ExitTrigger {
  trigger: "tp" | "sl";
  precoExit: number;
  resultado: Resultado;
}

function checkExitTrigger(decisao: string, precoEntrada: number, precoCheck: number): ExitTrigger | null {
  if (!Number.isFinite(precoEntrada) || !Number.isFinite(precoCheck) || precoEntrada <= 0) return null;

  if (decisao === "compra") {
    const tp = precoEntrada * (1 + TAKE_PROFIT_PCT / 100);
    const sl = precoEntrada * (1 - STOP_LOSS_PCT / 100);
    if (precoCheck >= tp) return { trigger: "tp", precoExit: tp, resultado: "lucro" };
    if (precoCheck <= sl) return { trigger: "sl", precoExit: sl, resultado: "prejuizo" };
  } else if (decisao === "venda") {
    const tp = precoEntrada * (1 - TAKE_PROFIT_PCT / 100);
    const sl = precoEntrada * (1 + STOP_LOSS_PCT / 100);
    if (precoCheck <= tp) return { trigger: "tp", precoExit: tp, resultado: "lucro" };
    if (precoCheck >= sl) return { trigger: "sl", precoExit: sl, resultado: "prejuizo" };
  }
  return null;
}

function avaliarPendentes(decisoes: DecisionRecord[], ativo: string, precoFuturo: number): { resolveuPrejuizo: boolean } {
  let resolveu = false;
  for (let i = 0; i < decisoes.length; i++) {
    const prev = decisoes[i];
    if (prev.ativo !== ativo) continue;
    if (prev.avaliada) continue;
    if (prev.decisao !== "compra" && prev.decisao !== "venda") continue;
    if (typeof prev.precoEntrada !== "number") continue;

    // 1. checa preços intermediários (cada record subsequente do mesmo ativo) por TP/SL
    let exit: ExitTrigger | null = null;
    for (let j = i + 1; j < decisoes.length; j++) {
      if (decisoes[j].ativo !== ativo) continue;
      const p = decisoes[j].precoEntrada;
      if (typeof p !== "number" || !Number.isFinite(p)) continue;
      const t = checkExitTrigger(prev.decisao, prev.precoEntrada, p);
      if (t) { exit = t; break; }
    }

    // 2. checa preço atual (precoFuturo) por TP/SL
    if (!exit) {
      const t = checkExitTrigger(prev.decisao, prev.precoEntrada, precoFuturo);
      if (t) exit = t;
    }

    if (exit) {
      prev.precoAtual = exit.precoExit;
      prev.resultado = exit.resultado;
      prev.avaliada = true;
      if (exit.resultado === "prejuizo") resolveu = true;
      continue;
    }

    // 3. fallback temporal: encerra por DELAY_CYCLES no preço atual
    const ciclosDecorridos = countSameAtivoAfter(decisoes, ativo, i) + 1;
    if (ciclosDecorridos >= DELAY_CYCLES) {
      prev.precoAtual = precoFuturo;
      prev.resultado = computeResultado(prev.decisao, prev.precoEntrada, precoFuturo);
      prev.avaliada = true;
      if (prev.resultado === "prejuizo") resolveu = true;
    }
  }
  return { resolveuPrejuizo: resolveu };
}

export function saveDecision(input: DecisionInput): DecisionRecord {
  ensureFile(DECISIONS_FILE);

  const decisoes = readDecisions(DECISIONS_FILE);
  const { tendencia, forca } = extractContext(input.analise, input.tendencia, input.forca);

  const { resolveuPrejuizo } = avaliarPendentes(decisoes, input.ativo, input.precoEntrada);

  const isOperacional = input.decisao === "compra" || input.decisao === "venda";
  const record: DecisionRecord = {
    ativo: input.ativo,
    decisao: input.decisao,
    confianca: input.confianca,
    analise: input.analise,
    tendencia,
    forca,
    precoEntrada: input.precoEntrada,
    precoAtual: input.precoEntrada,
    timestamp: new Date().toISOString(),
    resultado: "neutro",
    avaliada: !isOperacional,
    rsi: typeof input.rsi === "number" && Number.isFinite(input.rsi) ? input.rsi : 50,
    momentum: typeof input.momentum === "number" && Number.isFinite(input.momentum) ? input.momentum : 0,
    intensidade: typeof input.intensidade === "number" && Number.isFinite(input.intensidade) ? input.intensidade : 0,
    resolveuPrejuizo
  };

  decisoes.push(record);
  writeFileSync(DECISIONS_FILE, JSON.stringify(decisoes, null, 2), "utf-8");
  return record;
}
