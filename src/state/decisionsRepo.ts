import { db } from "./database.js";

export interface DecisionRow {
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
  justificativa: string | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  atr?: number | null;
  atr_pct?: number | null;
  stop_distance?: number | null;
  risk_pct?: number | null;
  risk_amount?: number | null;
  position_size?: number | null;
  notional?: number | null;
  rr?: number | null;
  lucro_prejuizo?: number | null;
  motivo_operacional?: string | null;
  setup?: string | null;
  timeframe?: string | null;
  direcao?: string | null;
  edge_score?: number | null;
  regime?: string | null;
  regime_confidence?: number | null;
  market_quality_score?: number | null;
  market_quality_label?: string | null;
}

export interface InsertDecisionInput {
  ativo: string;
  decisao: string;
  confianca: number;
  tendencia: string;
  forca: number;
  rsi: number;
  momentum: number;
  intensidade: number;
  precoEntrada: number;
  precoAtual: number;
  timestamp: string;
  resultado: string;
  avaliada: boolean;
  resolveuPrejuizo: boolean;
  justificativa: string | null;
  stopLoss?: number;
  takeProfit?: number;
  atr?: number;
  atrPct?: number;
  stopDistance?: number;
  riskPct?: number;
  riskAmount?: number;
  positionSize?: number;
  notional?: number;
  rr?: number;
  lucroPrejuizo?: number;
  motivoOperacional?: string;
  setup?: string;
  timeframe?: string;
  direcao?: string;
  edgeScore?: number;
  regime?: string;
  regimeConfidence?: number;
  marketQualityScore?: number;
  marketQualityLabel?: string;
}

const stmtInsert = db.prepare(`
  INSERT INTO decisions (
    ativo, decisao, confianca, tendencia, forca, rsi, momentum, intensidade,
    preco_entrada, preco_atual, timestamp, resultado, avaliada, resolveu_prejuizo, justificativa,
    stop_loss, take_profit, atr, atr_pct, stop_distance, risk_pct, risk_amount,
    position_size, notional, rr, lucro_prejuizo, motivo_operacional,
    setup, timeframe, direcao, edge_score, regime, regime_confidence,
    market_quality_score, market_quality_label
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtAll = db.prepare("SELECT * FROM decisions ORDER BY id ASC");
const stmtByAtivo = db.prepare("SELECT * FROM decisions WHERE ativo = ? ORDER BY id ASC");
const stmtRecentByAtivo = db.prepare("SELECT * FROM decisions WHERE ativo = ? ORDER BY id DESC LIMIT ?");
const stmtCountByAtivo = db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE ativo = ?");
const stmtCountTotal = db.prepare("SELECT COUNT(*) AS n FROM decisions");
const stmtUniqueSymbols = db.prepare("SELECT DISTINCT ativo FROM decisions ORDER BY ativo ASC");
const stmtEvaluatedOps = db.prepare(`
  SELECT * FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
  ORDER BY id ASC
`);
const stmtUpdateEvaluation = db.prepare(`
  UPDATE decisions
  SET preco_atual = ?, resultado = ?, avaliada = ?, resolveu_prejuizo = ?, lucro_prejuizo = ?, motivo_operacional = ?
  WHERE ativo = ? AND timestamp = ?
`);

export function insertDecision(d: InsertDecisionInput): void {
  stmtInsert.run(
    d.ativo,
    d.decisao,
    d.confianca,
    d.tendencia,
    d.forca,
    d.rsi,
    d.momentum,
    d.intensidade,
    d.precoEntrada,
    d.precoAtual,
    d.timestamp,
    d.resultado,
    d.avaliada ? 1 : 0,
    d.resolveuPrejuizo ? 1 : 0,
    d.justificativa,
    d.stopLoss ?? null,
    d.takeProfit ?? null,
    d.atr ?? null,
    d.atrPct ?? null,
    d.stopDistance ?? null,
    d.riskPct ?? null,
    d.riskAmount ?? null,
    d.positionSize ?? null,
    d.notional ?? null,
    d.rr ?? null,
    d.lucroPrejuizo ?? null,
    d.motivoOperacional ?? null,
    d.setup ?? null,
    d.timeframe ?? null,
    d.direcao ?? null,
    d.edgeScore ?? null,
    d.regime ?? null,
    d.regimeConfidence ?? null,
    d.marketQualityScore ?? null,
    d.marketQualityLabel ?? null
  );
}

export function getAllDecisions(): DecisionRow[] {
  return stmtAll.all() as unknown as DecisionRow[];
}

export function getDecisionsByAtivo(ativo: string): DecisionRow[] {
  return stmtByAtivo.all(ativo) as unknown as DecisionRow[];
}

export function getRecentDecisions(ativo: string, limit: number): DecisionRow[] {
  return stmtRecentByAtivo.all(ativo, limit) as unknown as DecisionRow[];
}

export function countByAtivo(ativo: string): number {
  const row = stmtCountByAtivo.get(ativo) as { n: number } | undefined;
  return row ? row.n : 0;
}

export function countTotal(): number {
  const row = stmtCountTotal.get() as { n: number } | undefined;
  return row ? row.n : 0;
}

export function getUniqueSymbols(): string[] {
  const rows = stmtUniqueSymbols.all() as { ativo: string }[];
  return rows.map((r) => r.ativo);
}

export function getEvaluatedOps(): DecisionRow[] {
  return stmtEvaluatedOps.all() as unknown as DecisionRow[];
}

export function updateDecisionEvaluation(input: {
  ativo: string;
  timestamp: string;
  precoAtual: number;
  resultado: string;
  avaliada: boolean;
  resolveuPrejuizo: boolean;
  lucroPrejuizo?: number;
  motivoOperacional?: string;
}): void {
  stmtUpdateEvaluation.run(
    input.precoAtual,
    input.resultado,
    input.avaliada ? 1 : 0,
    input.resolveuPrejuizo ? 1 : 0,
    input.lucroPrejuizo ?? null,
    input.motivoOperacional ?? null,
    input.ativo,
    input.timestamp
  );
}
