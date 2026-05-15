import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { insertDecision, updateDecisionEvaluation } from "../state/decisionsRepo.js";
import { recordDecisionExecution } from "../execution/executionEngine.js";
import { buildAdaptiveRiskDirective } from "../meta/metaPerformance.js";
import {
  BREAKEVEN_ATR_MULTIPLIER,
  DAILY_LOSS_LIMIT_PCT,
  FEE_PCT,
  LOSS_COOLDOWN_CANDLES,
  PARTIAL_ATR_MULTIPLIER,
  PARTIAL_EXIT_FRACTION,
  RISK_PER_TRADE_PCT,
  SLIPPAGE_PCT,
  applyEntrySlippage,
  applyExitSlippage,
  calculateRiskPlan,
  feeForNotional,
  getInitialBalance,
  grossPnl,
  type TradeDirection
} from "./riskManager.js";

const DATA_DIR = resolve(process.cwd(), "data");
const DECISIONS_FILE = resolve(DATA_DIR, "decisions.json");
const TAXA_TOTAL_PCT = FEE_PCT * 2;

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
  atr?: number;
  atrPct?: number;
  volumeRelativo?: number;
  drawdownAtual?: number;
  setup?: string;
  timeframe?: string;
  edgeScore?: number;
  regime?: string;
  regimeConfidence?: number;
  marketQualityScore?: number;
  marketQualityLabel?: string;
}

export interface DecisionRecord {
  ativo: string;
  decisao: string;
  sinalGerado?: string;
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
  motivoOperacional?: string;
  takeProfit?: number;
  stopLoss?: number;
  atr?: number;
  atrPct?: number;
  stopDistance?: number;
  riskPct?: number;
  riskAmount?: number;
  positionSize?: number;
  remainingPositionSize?: number;
  notional?: number;
  rr?: number;
  feeEntry?: number;
  lucroPrejuizo?: number;
  partialTaken?: boolean;
  trailingStopActivated?: boolean;
  dailyLossLimitActive?: boolean;
  cooldownActive?: boolean;
  drawdownAtual?: number;
  setup?: string;
  timeframe?: string;
  direcao?: string;
  edgeScore?: number;
  regime?: string;
  regimeConfidence?: number;
  marketQualityScore?: number;
  marketQualityLabel?: string;
  taxaTotalPct?: number;
  slippagePct?: number;
  retornoLiquidoPct?: number;
  fechamentos?: Array<{
    timestampAbertura: string;
    precoEntrada: number;
    precoSaida: number;
    resultado: Resultado;
    motivo: "take_profit" | "stop_loss" | "take_partial" | "trailing_stop";
    taxaTotalPct: number;
    retornoLiquidoPct: number;
    quantidade?: number;
    lucroPrejuizo?: number;
  }>;
}

interface ExitTrigger {
  trigger: "tp" | "sl" | "trailing_stop";
  precoExit: number;
  resultado: Resultado;
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

function roundPrice(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function tradeReturnPct(decisao: string, precoEntrada: number, precoSaida: number): number {
  if (!Number.isFinite(precoEntrada) || !Number.isFinite(precoSaida) || precoEntrada <= 0) return 0;
  const bruto =
    decisao === "compra"
      ? ((precoSaida - precoEntrada) / precoEntrada) * 100
      : decisao === "venda"
        ? ((precoEntrada - precoSaida) / precoEntrada) * 100
        : 0;
  return Math.round((bruto - TAXA_TOTAL_PCT) * 10_000) / 10_000;
}

function tradeDirection(decisao: string): TradeDirection | null {
  return decisao === "compra" || decisao === "venda" ? decisao : null;
}

function remainingSize(record: DecisionRecord): number {
  const remaining = Number(record.remainingPositionSize);
  if (Number.isFinite(remaining) && remaining > 0) return remaining;
  const size = Number(record.positionSize);
  if (Number.isFinite(size) && size > 0) return size;
  const notional = Number(record.notional);
  return Number.isFinite(notional) && notional > 0 && record.precoEntrada > 0 ? notional / record.precoEntrada : 0;
}

function closeQuantity(record: DecisionRecord, precoSaidaRef: number, quantidade: number): {
  precoSaida: number;
  pnl: number;
  retornoPct: number;
} {
  const direction = tradeDirection(record.decisao);
  if (!direction || quantidade <= 0) return { precoSaida: precoSaidaRef, pnl: 0, retornoPct: 0 };
  const precoSaida = applyExitSlippage(direction, precoSaidaRef);
  const entryFeeTotal = Number(record.feeEntry) || feeForNotional((Number(record.notional) || 0));
  const originalQty = Number(record.positionSize) || quantidade;
  const feeEntrada = originalQty > 0 ? entryFeeTotal * (quantidade / originalQty) : 0;
  const taxaSaida = feeForNotional(precoSaida * quantidade);
  const pnl = grossPnl(direction, record.precoEntrada, precoSaida, quantidade) - feeEntrada - taxaSaida;
  const capital = record.precoEntrada * quantidade;
  const retornoPct = capital > 0 ? (pnl / capital) * 100 : 0;
  return {
    precoSaida,
    pnl: Math.round(pnl * 100) / 100,
    retornoPct: Math.round(retornoPct * 10_000) / 10_000
  };
}

function checkExitTrigger(record: DecisionRecord, precoAtual: number): ExitTrigger | null {
  if (!Number.isFinite(record.precoEntrada) || !Number.isFinite(precoAtual) || record.precoEntrada <= 0) {
    return null;
  }
  const direction = tradeDirection(record.decisao);
  if (!direction) return null;
  const tp = Number(record.takeProfit);
  const sl = Number(record.stopLoss);
  if (!Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) return null;
  if (direction === "compra") {
    if (precoAtual >= tp) return { trigger: "tp", precoExit: tp, resultado: "lucro" };
    if (precoAtual <= sl) return { trigger: sl >= record.precoEntrada ? "trailing_stop" : "sl", precoExit: sl, resultado: sl >= record.precoEntrada ? "lucro" : "prejuizo" };
  } else {
    if (precoAtual <= tp) return { trigger: "tp", precoExit: tp, resultado: "lucro" };
    if (precoAtual >= sl) return { trigger: sl <= record.precoEntrada ? "trailing_stop" : "sl", precoExit: sl, resultado: sl <= record.precoEntrada ? "lucro" : "prejuizo" };
  }
  return null;
}

function isOpenPosition(record: DecisionRecord, ativo: string): boolean {
  const hasRiskLevels = Number.isFinite(Number(record.stopLoss)) && Number.isFinite(Number(record.takeProfit));
  const remaining = remainingSize(record);
  return (
    record.ativo === ativo &&
    (record.decisao === "compra" || record.decisao === "venda") &&
    record.avaliada !== true &&
    hasRiskLevels &&
    remaining > 0 &&
    typeof record.precoEntrada === "number" &&
    Number.isFinite(record.precoEntrada) &&
    record.precoEntrada > 0
  );
}

function hasOpenPosition(decisoes: DecisionRecord[], ativo: string): boolean {
  return decisoes.some((d) => isOpenPosition(d, ativo));
}

function realizedPnl(record: DecisionRecord): number {
  if (Number.isFinite(record.lucroPrejuizo)) return Number(record.lucroPrejuizo);
  const fechamentos = Array.isArray(record.fechamentos) ? record.fechamentos : [];
  return fechamentos.reduce((sum, f) => sum + (Number(f.lucroPrejuizo) || 0), 0);
}

function estimateBalance(decisoes: DecisionRecord[]): number {
  const balance = getInitialBalance() + decisoes.reduce((sum, d) => sum + realizedPnl(d), 0);
  return Math.max(0, Number.isFinite(balance) ? balance : getInitialBalance());
}

function dailyPnl(decisoes: DecisionRecord[], now = new Date()): number {
  const ymd = now.toISOString().slice(0, 10);
  let total = 0;
  for (const d of decisoes) {
    const ts = typeof d.timestamp === "string" ? d.timestamp : "";
    if (!ts.startsWith(ymd)) continue;
    total += realizedPnl(d);
  }
  return total;
}

function checkJsonCooldown(decisoes: DecisionRecord[], ativo: string, limit = LOSS_COOLDOWN_CANDLES): { ativa: boolean; restantes: number } {
  const filtradas = decisoes.filter((d) => d.ativo === ativo);
  let lossIndex = -1;
  for (let i = filtradas.length - 1; i >= 0; i -= 1) {
    if (filtradas[i].resultado === "prejuizo" || filtradas[i].resolveuPrejuizo === true) {
      lossIndex = i;
      break;
    }
  }
  if (lossIndex < 0) return { ativa: false, restantes: 0 };
  const desde = filtradas.length - 1 - lossIndex;
  if (desde >= limit) return { ativa: false, restantes: 0 };
  return { ativa: true, restantes: limit - desde };
}

function avaliarPosicoesAbertas(
  decisoes: DecisionRecord[],
  ativo: string,
  precoAtual: number
): { resolveuPrejuizo: boolean; fechadas: DecisionRecord[] } {
  let resolveuPrejuizo = false;
  const fechadas: DecisionRecord[] = [];

  for (const prev of decisoes) {
    if (!isOpenPosition(prev, ativo)) continue;

    const direction = tradeDirection(prev.decisao);
    const atr = Number(prev.atr) || ((Number(prev.stopDistance) || 0) / 1.2);
    const originalQty = Number(prev.positionSize) || remainingSize(prev);
    const remainingBefore = remainingSize(prev);
    const favorableMove = direction === "compra"
      ? precoAtual - prev.precoEntrada
      : direction === "venda"
        ? prev.precoEntrada - precoAtual
        : 0;

    if (direction && atr > 0 && !prev.partialTaken && favorableMove >= atr * PARTIAL_ATR_MULTIPLIER && remainingBefore > 0) {
      const partialQty = Math.min(remainingBefore, originalQty * PARTIAL_EXIT_FRACTION);
      const partialRef = direction === "compra"
        ? prev.precoEntrada + atr * PARTIAL_ATR_MULTIPLIER
        : prev.precoEntrada - atr * PARTIAL_ATR_MULTIPLIER;
      const partial = closeQuantity(prev, partialRef, partialQty);
      prev.remainingPositionSize = Math.max(0, remainingBefore - partialQty);
      prev.partialTaken = true;
      prev.stopLoss = roundPrice(prev.precoEntrada);
      prev.trailingStopActivated = true;
      prev.lucroPrejuizo = (Number(prev.lucroPrejuizo) || 0) + partial.pnl;
      prev.fechamentos = prev.fechamentos || [];
      prev.fechamentos.push({
        timestampAbertura: prev.timestamp,
        precoEntrada: prev.precoEntrada,
        precoSaida: partial.precoSaida,
        resultado: partial.pnl >= 0 ? "lucro" : "prejuizo",
        motivo: "take_partial",
        taxaTotalPct: TAXA_TOTAL_PCT,
        retornoLiquidoPct: partial.retornoPct,
        quantidade: partialQty,
        lucroPrejuizo: partial.pnl
      });
      console.log(
        `[risk] ${ativo}: take parcial 50% em +1 ATR | stop movido para breakeven=${prev.stopLoss} | pnl=${partial.pnl}`
      );
    }

    const exit = checkExitTrigger(prev, precoAtual);
    if (!exit) continue;

    const qty = remainingSize(prev);
    const closed = closeQuantity(prev, exit.precoExit, qty);
    prev.precoAtual = closed.precoSaida;
    prev.lucroPrejuizo = (Number(prev.lucroPrejuizo) || 0) + closed.pnl;
    prev.resultado = (Number(prev.lucroPrejuizo) || 0) >= 0 ? "lucro" : "prejuizo";
    prev.avaliada = true;
    prev.remainingPositionSize = 0;
    prev.motivoOperacional = exit.trigger === "tp" ? "take_profit" : exit.trigger === "trailing_stop" ? "trailing_stop" : "stop_loss";
    prev.taxaTotalPct = TAXA_TOTAL_PCT;
    prev.retornoLiquidoPct = tradeReturnPct(prev.decisao, prev.precoEntrada, prev.precoAtual);
    prev.fechamentos = prev.fechamentos || [];
    prev.fechamentos.push({
      timestampAbertura: prev.timestamp,
      precoEntrada: prev.precoEntrada,
      precoSaida: closed.precoSaida,
      resultado: closed.pnl >= 0 ? "lucro" : "prejuizo",
      motivo: prev.motivoOperacional === "take_profit" || prev.motivoOperacional === "trailing_stop" || prev.motivoOperacional === "stop_loss"
        ? prev.motivoOperacional
        : "stop_loss",
      taxaTotalPct: TAXA_TOTAL_PCT,
      retornoLiquidoPct: closed.retornoPct,
      quantidade: qty,
      lucroPrejuizo: closed.pnl
    });
    if (prev.resultado === "prejuizo") resolveuPrejuizo = true;
    fechadas.push(prev);
  }

  return { resolveuPrejuizo, fechadas };
}

function syncClosedPosition(record: DecisionRecord): void {
  try {
    updateDecisionEvaluation({
      ativo: record.ativo,
      timestamp: record.timestamp,
      precoAtual: record.precoAtual,
      resultado: record.resultado,
      avaliada: record.avaliada,
      resolveuPrejuizo: record.resolveuPrejuizo,
      lucroPrejuizo: record.lucroPrejuizo,
      motivoOperacional: record.motivoOperacional
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[saveDecision] update SQL falhou (nao-fatal): ${msg}`);
  }
}

export function saveDecision(input: DecisionInput): DecisionRecord {
  ensureFile(DECISIONS_FILE);

  const ativo = input.ativo.trim().toUpperCase();
  const precoAtual = Number.isFinite(input.precoEntrada) ? input.precoEntrada : 0;
  const decisoes = readDecisions(DECISIONS_FILE);
  const { tendencia, forca } = extractContext(input.analise, input.tendencia, input.forca);

  const { resolveuPrejuizo, fechadas } = avaliarPosicoesAbertas(decisoes, ativo, precoAtual);
  for (const fechada of fechadas) {
    fechada.resolveuPrejuizo = fechada.resultado === "prejuizo";
  }

  const sinalGerado = input.decisao;
  const direcaoEntrada = tradeDirection(sinalGerado);
  const balance = estimateBalance(decisoes);
  const pnlHoje = dailyPnl(decisoes);
  const dailyLossLimitActive = pnlHoje < -(getInitialBalance() * DAILY_LOSS_LIMIT_PCT / 100);
  const rawAtr = typeof input.atr === "number" && Number.isFinite(input.atr) ? input.atr : 0;
  const atr = rawAtr > 0 ? rawAtr : Math.max(precoAtual * 0.001, 0);
  const adaptiveRisk = buildAdaptiveRiskDirective({
    ativo,
    setup: input.setup,
    regime: input.regime,
    regimeConfidence: input.regimeConfidence,
    confidence: input.confianca,
    edgeScore: input.edgeScore
  });
  const cooldown = checkJsonCooldown(decisoes, ativo, adaptiveRisk.cooldownCandles);
  const precoEntradaExecutado = direcaoEntrada ? applyEntrySlippage(direcaoEntrada, precoAtual) : precoAtual;
  const riskPlan = direcaoEntrada
    ? calculateRiskPlan({ balance, direction: direcaoEntrada, entryPrice: precoEntradaExecutado, atr, riskPct: adaptiveRisk.riskPerTradePct })
    : null;
  const podeAbrirOperacao =
    !!direcaoEntrada &&
    !!riskPlan &&
    precoEntradaExecutado > 0 &&
    !hasOpenPosition(decisoes, ativo) &&
    !dailyLossLimitActive &&
    !cooldown.ativa;
  const decisaoOperacional = podeAbrirOperacao && direcaoEntrada ? direcaoEntrada : "esperar";
  const precoEntradaRecord = podeAbrirOperacao ? precoEntradaExecutado : precoAtual;
  const tp = podeAbrirOperacao ? riskPlan?.takeProfit : undefined;
  const sl = podeAbrirOperacao ? riskPlan?.stopLoss : undefined;
  const fechamentos = fechadas.flatMap((fechada) => fechada.fechamentos || []);

  if (podeAbrirOperacao && riskPlan) {
    console.log(
      `[risk] ${ativo}: risco adaptativo=${riskPlan.riskPct}% modo=${adaptiveRisk.riskMode} ($${riskPlan.riskAmount}) | positionSize=${riskPlan.positionSize} | notional=$${riskPlan.notional} | SL=${riskPlan.stopLoss} | TP=${riskPlan.takeProfit} | RR=${riskPlan.rr} | drawdown atual=${input.drawdownAtual ?? 0}% | cooldown=${adaptiveRisk.cooldownCandles}`
    );
  } else if (direcaoEntrada) {
    const motivo = dailyLossLimitActive
      ? `limite diario ativo: pnlHoje=${pnlHoje.toFixed(2)} <= -${DAILY_LOSS_LIMIT_PCT}%`
      : cooldown.ativa
        ? `cooldown adaptativo ativo: ${cooldown.restantes}/${adaptiveRisk.cooldownCandles} candles`
        : adaptiveRisk.safeMode
          ? `safe mode ativo: ${adaptiveRisk.reasons.join(" + ")}`
        : !riskPlan
          ? "plano de risco invalido (ATR/preco/banca)"
          : hasOpenPosition(decisoes, ativo)
            ? "posicao ja aberta"
            : "sem abertura";
    console.log(
      `[risk] ${ativo}: entrada bloqueada | motivo=${motivo} | risco adaptativo=${adaptiveRisk.riskPerTradePct}% modo=${adaptiveRisk.riskMode} | ATR=${atr} | cooldown ativo=${cooldown.ativa}`
    );
  }

  const record: DecisionRecord = {
    ativo,
    decisao: decisaoOperacional,
    sinalGerado,
    confianca: input.confianca,
    analise: input.analise,
    tendencia,
    forca,
    precoEntrada: precoEntradaRecord,
    precoAtual: precoEntradaRecord,
    timestamp: new Date().toISOString(),
    resultado: "neutro",
    avaliada: !podeAbrirOperacao,
    rsi: typeof input.rsi === "number" && Number.isFinite(input.rsi) ? input.rsi : 50,
    momentum: typeof input.momentum === "number" && Number.isFinite(input.momentum) ? input.momentum : 0,
    intensidade: typeof input.intensidade === "number" && Number.isFinite(input.intensidade) ? input.intensidade : 0,
    resolveuPrejuizo,
    motivoOperacional: podeAbrirOperacao
      ? `abertura_${decisaoOperacional}`
      : fechamentos.length > 0
        ? "fechamento_posicao"
        : hasOpenPosition(decisoes, ativo)
        ? "posicao_aberta"
        : dailyLossLimitActive
        ? "limite_diario"
        : cooldown.ativa
        ? "cooldown_pos_loss"
        : "sem_abertura",
    takeProfit: tp,
    stopLoss: sl,
    atr: podeAbrirOperacao ? riskPlan?.atr : atr || undefined,
    atrPct: typeof input.atrPct === "number" && Number.isFinite(input.atrPct) ? input.atrPct : undefined,
    stopDistance: podeAbrirOperacao ? riskPlan?.stopDistance : undefined,
    riskPct: podeAbrirOperacao ? riskPlan?.riskPct : adaptiveRisk.riskPerTradePct,
    riskAmount: podeAbrirOperacao ? riskPlan?.riskAmount : undefined,
    positionSize: podeAbrirOperacao ? riskPlan?.positionSize : undefined,
    remainingPositionSize: podeAbrirOperacao ? riskPlan?.positionSize : undefined,
    notional: podeAbrirOperacao ? riskPlan?.notional : undefined,
    rr: podeAbrirOperacao ? riskPlan?.rr : undefined,
    feeEntry: podeAbrirOperacao && riskPlan ? feeForNotional(riskPlan.notional) : undefined,
    partialTaken: podeAbrirOperacao ? false : undefined,
    trailingStopActivated: podeAbrirOperacao ? false : undefined,
    dailyLossLimitActive,
    cooldownActive: cooldown.ativa,
    drawdownAtual: typeof input.drawdownAtual === "number" && Number.isFinite(input.drawdownAtual) ? input.drawdownAtual : 0,
    setup: input.setup,
    timeframe: input.timeframe ?? "1m",
    direcao: direcaoEntrada ?? undefined,
    edgeScore: typeof input.edgeScore === "number" && Number.isFinite(input.edgeScore) ? input.edgeScore : undefined,
    regime: input.regime,
    regimeConfidence: typeof input.regimeConfidence === "number" && Number.isFinite(input.regimeConfidence) ? input.regimeConfidence : undefined,
    marketQualityScore: typeof input.marketQualityScore === "number" && Number.isFinite(input.marketQualityScore) ? input.marketQualityScore : undefined,
    marketQualityLabel: input.marketQualityLabel,
    taxaTotalPct: podeAbrirOperacao ? TAXA_TOTAL_PCT : undefined,
    slippagePct: podeAbrirOperacao ? SLIPPAGE_PCT : undefined,
    fechamentos: fechamentos.length > 0 ? fechamentos : undefined
  };

  decisoes.push(record);
  writeFileSync(DECISIONS_FILE, JSON.stringify(decisoes, null, 2), "utf-8");

  for (const fechada of fechadas) {
    syncClosedPosition(fechada);
  }

  try {
    const just = (input.analise && typeof (input.analise as Record<string, unknown>).justificativa === "string")
      ? (input.analise as Record<string, unknown>).justificativa as string
      : null;
    insertDecision({
      ativo: record.ativo,
      decisao: record.decisao,
      confianca: record.confianca,
      tendencia: record.tendencia,
      forca: record.forca,
      rsi: record.rsi,
      momentum: record.momentum,
      intensidade: record.intensidade,
      precoEntrada: record.precoEntrada,
      precoAtual: record.precoAtual,
      timestamp: record.timestamp,
      resultado: record.resultado,
      avaliada: record.avaliada,
      resolveuPrejuizo: record.resolveuPrejuizo,
      justificativa: just,
      stopLoss: record.stopLoss,
      takeProfit: record.takeProfit,
      atr: record.atr,
      atrPct: record.atrPct,
      stopDistance: record.stopDistance,
      riskPct: record.riskPct,
      riskAmount: record.riskAmount,
      positionSize: record.positionSize,
      notional: record.notional,
      rr: record.rr,
      lucroPrejuizo: record.lucroPrejuizo,
      motivoOperacional: record.motivoOperacional,
      setup: record.setup,
      timeframe: record.timeframe,
      direcao: record.direcao,
      edgeScore: record.edgeScore
      ,
      regime: record.regime,
      regimeConfidence: record.regimeConfidence,
      marketQualityScore: record.marketQualityScore,
      marketQualityLabel: record.marketQualityLabel
    });
    recordDecisionExecution({
      ativo: record.ativo,
      decisao: record.decisao,
      timestamp: record.timestamp,
      precoEntrada: record.precoEntrada,
      positionSize: record.positionSize,
      stopLoss: record.stopLoss,
      takeProfit: record.takeProfit,
      atr: record.atr,
      atrPct: record.atrPct,
      volumeRelativo: input.volumeRelativo,
      momentum: record.momentum,
      setup: record.setup,
      regime: record.regime,
      regimeConfidence: record.regimeConfidence
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[saveDecision] mirror SQL falhou (nao-fatal): ${msg}`);
  }

  return record;
}
