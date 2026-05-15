import { db } from "../state/database.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeNumber, safeRound } from "./safeMath.js";
import { logger } from "./logger.js";

const DATASETS_DIR = resolve(process.cwd(), "data", "datasets");
if (!existsSync(DATASETS_DIR)) mkdirSync(DATASETS_DIR, { recursive: true });

const SIMBOLOS_PERMITIDOS = new Set<string>(["BTCUSDT", "ETHUSDT"]);
const TAXA_TOTAL_PCT = 0.2;
const SLIPPAGE_PCT = 0.05;

export interface DatasetSample {
  // identificação
  id: number;
  timestamp: string;
  ativo: string;
  timeframe: string | null;
  setup: string | null;
  direcao: string | null;
  decisao: string;

  // edge / score
  edge_score: number | null;
  confianca: number;

  // features de mercado
  rsi: number;
  atr: number | null;
  atr_pct: number | null;
  momentum: number;
  intensidade: number;
  sma_dist_pct: number;
  tendencia: string;

  // gestão de risco
  preco_entrada: number;
  preco_atual: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr: number | null;
  position_size: number | null;
  notional: number | null;
  risk_pct: number | null;
  risk_amount: number | null;

  // resultado
  resultado: string;
  avaliada: number;
  resolveu_prejuizo: number;
  pnl_pct: number | null;       // retorno líquido após taxa+slippage (null se não avaliada)
  lucro_prejuizo: number | null; // valor armazenado no DB
  motivo_operacional: string | null;
}

interface RawRow {
  id: number;
  ativo: string;
  decisao: string;
  confianca: number;
  tendencia: string;
  forca: number;
  rsi: number;
  momentum: number;
  intensidade: number;
  preco_entrada: number;
  preco_atual: number;
  timestamp: string;
  resultado: string;
  avaliada: number;
  resolveu_prejuizo: number;
  stop_loss: number | null;
  take_profit: number | null;
  atr: number | null;
  atr_pct: number | null;
  rr: number | null;
  risk_pct: number | null;
  risk_amount: number | null;
  position_size: number | null;
  notional: number | null;
  lucro_prejuizo: number | null;
  motivo_operacional: string | null;
  setup: string | null;
  timeframe: string | null;
  direcao: string | null;
  edge_score: number | null;
}

const stmtAll = db.prepare(`
  SELECT id, ativo, decisao, confianca, tendencia, forca, rsi, momentum, intensidade,
         preco_entrada, preco_atual, timestamp, resultado, avaliada, resolveu_prejuizo,
         stop_loss, take_profit, atr, atr_pct, rr, risk_pct, risk_amount,
         position_size, notional, lucro_prejuizo, motivo_operacional,
         setup, timeframe, direcao, edge_score
  FROM decisions
  WHERE (decisao = 'compra' OR decisao = 'venda')
  ORDER BY datetime(timestamp) ASC, id ASC
`);

function pnlPctNet(decisao: string, precoEntrada: number, precoAtual: number, avaliada: number): number | null {
  if (avaliada !== 1) return null;
  const pe = safeNumber(precoEntrada);
  const pa = safeNumber(precoAtual);
  if (pe <= 0 || pa <= 0) return null;
  const slip = SLIPPAGE_PCT / 100;
  let bruto = 0;
  if (decisao === "compra") {
    const entrada = pe * (1 + slip);
    const saida = pa * (1 - slip);
    bruto = ((saida - entrada) / entrada) * 100;
  } else if (decisao === "venda") {
    const entrada = pe * (1 - slip);
    const saida = pa * (1 + slip);
    bruto = ((entrada - saida) / entrada) * 100;
  } else {
    return null;
  }
  const liquido = bruto - TAXA_TOTAL_PCT;
  return Number.isFinite(liquido) ? safeRound(liquido, 4) : null;
}

function smaDistPctSinalizado(intensidade: unknown, tendencia: unknown): number {
  const i = safeNumber(intensidade, 0);
  if (tendencia === "alta") return safeRound(i, 4);
  if (tendencia === "baixa") return safeRound(-i, 4);
  return 0;
}

function projectRow(r: RawRow): DatasetSample | null {
  const ativo = (r.ativo || "").toUpperCase();
  if (!SIMBOLOS_PERMITIDOS.has(ativo)) return null;
  if (r.decisao !== "compra" && r.decisao !== "venda") return null;

  // Sanity das features numéricas — descarta amostras corrompidas
  const numericChecks = [r.rsi, r.momentum, r.intensidade, r.preco_entrada, r.preco_atual, r.confianca];
  for (const v of numericChecks) {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
  }
  if (!Number.isFinite(r.preco_entrada) || r.preco_entrada <= 0) return null;

  return {
    id: r.id,
    timestamp: r.timestamp,
    ativo,
    timeframe: r.timeframe ?? null,
    setup: r.setup ?? null,
    direcao: r.direcao ?? r.decisao,
    decisao: r.decisao,
    edge_score: Number.isFinite(r.edge_score) ? safeRound(r.edge_score as number, 4) : null,
    confianca: safeRound(r.confianca, 2),
    rsi: safeRound(r.rsi, 2),
    atr: Number.isFinite(r.atr) ? safeRound(r.atr as number, 6) : null,
    atr_pct: Number.isFinite(r.atr_pct) ? safeRound(r.atr_pct as number, 4) : null,
    momentum: safeRound(r.momentum, 4),
    intensidade: safeRound(r.intensidade, 4),
    sma_dist_pct: smaDistPctSinalizado(r.intensidade, r.tendencia),
    tendencia: r.tendencia ?? "lateral",
    preco_entrada: safeRound(r.preco_entrada, 4),
    preco_atual: safeRound(r.preco_atual, 4),
    stop_loss: Number.isFinite(r.stop_loss) ? safeRound(r.stop_loss as number, 4) : null,
    take_profit: Number.isFinite(r.take_profit) ? safeRound(r.take_profit as number, 4) : null,
    rr: Number.isFinite(r.rr) ? safeRound(r.rr as number, 4) : null,
    position_size: Number.isFinite(r.position_size) ? safeRound(r.position_size as number, 6) : null,
    notional: Number.isFinite(r.notional) ? safeRound(r.notional as number, 4) : null,
    risk_pct: Number.isFinite(r.risk_pct) ? safeRound(r.risk_pct as number, 4) : null,
    risk_amount: Number.isFinite(r.risk_amount) ? safeRound(r.risk_amount as number, 4) : null,
    resultado: r.resultado ?? "neutro",
    avaliada: r.avaliada ?? 0,
    resolveu_prejuizo: r.resolveu_prejuizo ?? 0,
    pnl_pct: pnlPctNet(r.decisao, r.preco_entrada, r.preco_atual, r.avaliada),
    lucro_prejuizo: Number.isFinite(r.lucro_prejuizo) ? safeRound(r.lucro_prejuizo as number, 4) : null,
    motivo_operacional: r.motivo_operacional ?? null
  };
}

export function buildDataset(): DatasetSample[] {
  const rows = stmtAll.all() as unknown as RawRow[];
  const samples: DatasetSample[] = [];
  for (const r of rows) {
    const s = projectRow(r);
    if (s) samples.push(s);
  }
  return samples;
}

export interface DatasetStats {
  totalSamples: number;
  totalAvaliadas: number;
  totalPendentes: number;
  ativos: Record<string, number>;
  setups: Record<string, number>;
  setupsTopWinRate: Array<{ setup: string; total: number; wins: number; losses: number; winRate: number; pnlMedio: number }>;
  porAtivo: Array<{ ativo: string; total: number; wins: number; losses: number; winRate: number; pnlMedio: number }>;
  distribuicaoFeatures: {
    rsi: { min: number; max: number; mediana: number };
    momentum: { min: number; max: number; mediana: number };
    intensidade: { min: number; max: number; mediana: number };
    confianca: { min: number; max: number; mediana: number };
    edge_score: { min: number; max: number; mediana: number; nulls: number };
  };
  geradoEm: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? safeRound((sorted[mid - 1] + sorted[mid]) / 2, 4)
    : safeRound(sorted[mid], 4);
}

function describeNumeric(values: number[]): { min: number; max: number; mediana: number } {
  if (values.length === 0) return { min: 0, max: 0, mediana: 0 };
  return {
    min: safeRound(Math.min(...values), 4),
    max: safeRound(Math.max(...values), 4),
    mediana: median(values)
  };
}

export function computeDatasetStats(samples?: DatasetSample[]): DatasetStats {
  const data = samples ?? buildDataset();
  const ativos: Record<string, number> = {};
  const setups: Record<string, number> = {};
  let avaliadas = 0;
  let pendentes = 0;

  // por setup
  const porSetup = new Map<string, { total: number; wins: number; losses: number; pnls: number[] }>();
  const porAtivoMap = new Map<string, { total: number; wins: number; losses: number; pnls: number[] }>();

  const rsiVals: number[] = [];
  const momVals: number[] = [];
  const intensVals: number[] = [];
  const confVals: number[] = [];
  const edgeVals: number[] = [];
  let edgeNulls = 0;

  for (const s of data) {
    ativos[s.ativo] = (ativos[s.ativo] ?? 0) + 1;
    const setupKey = s.setup ?? "indefinido";
    setups[setupKey] = (setups[setupKey] ?? 0) + 1;
    if (s.avaliada === 1) avaliadas += 1;
    else pendentes += 1;

    if (Number.isFinite(s.rsi)) rsiVals.push(s.rsi);
    if (Number.isFinite(s.momentum)) momVals.push(s.momentum);
    if (Number.isFinite(s.intensidade)) intensVals.push(s.intensidade);
    if (Number.isFinite(s.confianca)) confVals.push(s.confianca);
    if (s.edge_score === null) edgeNulls += 1;
    else if (Number.isFinite(s.edge_score)) edgeVals.push(s.edge_score);

    const setupBucket = porSetup.get(setupKey) ?? { total: 0, wins: 0, losses: 0, pnls: [] };
    setupBucket.total += 1;
    if (s.resultado === "lucro") setupBucket.wins += 1;
    else if (s.resultado === "prejuizo") setupBucket.losses += 1;
    if (s.pnl_pct !== null && Number.isFinite(s.pnl_pct)) setupBucket.pnls.push(s.pnl_pct);
    porSetup.set(setupKey, setupBucket);

    const ativoBucket = porAtivoMap.get(s.ativo) ?? { total: 0, wins: 0, losses: 0, pnls: [] };
    ativoBucket.total += 1;
    if (s.resultado === "lucro") ativoBucket.wins += 1;
    else if (s.resultado === "prejuizo") ativoBucket.losses += 1;
    if (s.pnl_pct !== null && Number.isFinite(s.pnl_pct)) ativoBucket.pnls.push(s.pnl_pct);
    porAtivoMap.set(s.ativo, ativoBucket);
  }

  const setupsTopWinRate = [...porSetup.entries()]
    .map(([setup, b]) => {
      const closed = b.wins + b.losses;
      const wr = closed > 0 ? safeRound((b.wins / closed) * 100) : 0;
      const pnlMedio = b.pnls.length > 0 ? safeRound(b.pnls.reduce((a, c) => a + c, 0) / b.pnls.length, 4) : 0;
      return { setup, total: b.total, wins: b.wins, losses: b.losses, winRate: wr, pnlMedio };
    })
    .sort((a, b) => b.winRate - a.winRate);

  const porAtivo = [...porAtivoMap.entries()]
    .map(([ativo, b]) => {
      const closed = b.wins + b.losses;
      const wr = closed > 0 ? safeRound((b.wins / closed) * 100) : 0;
      const pnlMedio = b.pnls.length > 0 ? safeRound(b.pnls.reduce((a, c) => a + c, 0) / b.pnls.length, 4) : 0;
      return { ativo, total: b.total, wins: b.wins, losses: b.losses, winRate: wr, pnlMedio };
    })
    .sort((a, b) => a.ativo.localeCompare(b.ativo));

  return {
    totalSamples: data.length,
    totalAvaliadas: avaliadas,
    totalPendentes: pendentes,
    ativos,
    setups,
    setupsTopWinRate,
    porAtivo,
    distribuicaoFeatures: {
      rsi: describeNumeric(rsiVals),
      momentum: describeNumeric(momVals),
      intensidade: describeNumeric(intensVals),
      confianca: describeNumeric(confVals),
      edge_score: { ...describeNumeric(edgeVals), nulls: edgeNulls }
    },
    geradoEm: new Date().toISOString()
  };
}

const CSV_COLUMNS: Array<keyof DatasetSample> = [
  "id", "timestamp", "ativo", "timeframe", "setup", "direcao", "decisao",
  "edge_score", "confianca",
  "rsi", "atr", "atr_pct", "momentum", "intensidade", "sma_dist_pct", "tendencia",
  "preco_entrada", "preco_atual", "stop_loss", "take_profit", "rr",
  "position_size", "notional", "risk_pct", "risk_amount",
  "resultado", "avaliada", "resolveu_prejuizo",
  "pnl_pct", "lucro_prejuizo", "motivo_operacional"
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportDatasetCsv(samples?: DatasetSample[]): { path: string; bytes: number; rows: number } {
  const data = samples ?? buildDataset();
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const s of data) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape((s as unknown as Record<string, unknown>)[c as string])).join(","));
  }
  const filename = `dataset-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  const filePath = resolve(DATASETS_DIR, filename);
  const content = lines.join("\n") + "\n";
  writeFileSync(filePath, content, "utf-8");
  logger.info("dataset", `CSV exportado: ${filename} (${data.length} linhas)`);
  return { path: filePath, bytes: Buffer.byteLength(content, "utf-8"), rows: data.length };
}

export function exportDatasetJsonl(samples?: DatasetSample[]): { path: string; bytes: number; rows: number } {
  const data = samples ?? buildDataset();
  const filename = `dataset-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  const filePath = resolve(DATASETS_DIR, filename);
  const content = data.map((s) => JSON.stringify(s)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf-8");
  logger.info("dataset", `JSONL exportado: ${filename} (${data.length} linhas)`);
  return { path: filePath, bytes: Buffer.byteLength(content, "utf-8"), rows: data.length };
}

export const DATASETS_DIR_PATH = DATASETS_DIR;
