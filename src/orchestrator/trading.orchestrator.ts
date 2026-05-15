import { getMarketData } from "../services/market.service";
import { tecnicoAgent } from "../agents/tecnico.agent";
import { analyzePatterns } from "../utils/patternAnalysis";
import { computeRSI } from "../utils/rsi";
import { computeScore } from "../utils/score";
import { analyzeTrend } from "../utils/trendAnalysis";
import { computeMomentum } from "../utils/momentum";
import { detectBreakout } from "../utils/breakout";
import { shouldForceExploration } from "../utils/forceExploration";
import { checkBootstrap } from "../utils/bootstrap";
import { checkInactivity, checkLowFrequency } from "../utils/inactivityCheck";
import { checkLossCooldown } from "../utils/lossCooldown";
import { updateMarketMemory, breakoutAtivo } from "../state/marketMemory";
import { computeConfidenceAdjustment, analyzePerformance } from "../utils/learningContext";
import { recordCycle, recordError, heartbeat } from "../utils/healthMonitor";
import { logger } from "../utils/logger";
import { safeScore, safeConfidence } from "../utils/safeMath";
import { predictTradeProbability } from "../ml/predictSignal";
import { analyzeMarketQuality, type MarketQualityResult } from "../utils/marketFilters";
import { classifySetup, computeHistoricalEdge, type EdgeResult, type SetupType } from "../utils/strategyIntelligence";
import { detectMarketRegime, isSetupPenalizedByRegime, setupRegimeScoreDelta, type MarketRegime } from "../utils/marketRegime";
import { assessMarketQuality, type MarketQualityAssessment } from "../utils/marketQuality";
import { getAdaptivePortfolioBrain, shouldBlockSetup } from "../meta/metaPerformance";
import type { MarketData, TecnicoAnalysis } from "../types/index";

export interface TradingCycleResult {
  ativo: string;
  decisao: string;
  confianca: number;
  analise: TecnicoAnalysis;
  precoEntrada: number;
  rsi: number;
  momentum: number;
  intensidade: number;
  atr?: number;
  atrPct?: number;
  volumeRelativo?: number;
  drawdownAtual?: number;
  setup?: SetupType;
  timeframe?: string;
  edgeScore?: number;
  regime?: MarketRegime;
  regimeConfidence?: number;
  marketQualityScore?: number;
  marketQualityLabel?: string;
  adaptiveRiskMode?: string;
  adaptiveRiskPct?: number;
  adaptiveMinScore?: number;
  systemStress?: string;
  globalConfidence?: number;
}

const DEFAULT_SYMBOL = "BTCUSDT";

const SCORE_LIBERA = 60;
const SCORE_MEDIO = 40;

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const RSI_LATERAL_LOW = 40;
const RSI_LATERAL_HIGH = 60;

function tendenciaProibida(tendenciaAtual: string, pior: string): boolean {
  return pior !== "indefinido" && tendenciaAtual === pior;
}

function resumirMotivos(detalhes: string[]): string {
  const curtos = detalhes.map((r) => {
    if (r.startsWith("tendência")) return "tendência adversa";
    return r;
  });
  return [...new Set(curtos)].join(" + ");
}

function motivosEsperarIA(rsi: number, tendencia: string): string[] {
  const motivos: string[] = ["sinal IA = esperar"];
  if (rsi >= RSI_LATERAL_LOW && rsi <= RSI_LATERAL_HIGH) motivos.push("RSI neutro");
  else if (rsi < RSI_OVERSOLD) motivos.push("RSI sobrevendido");
  else if (rsi > RSI_OVERBOUGHT) motivos.push("RSI sobrecomprado");
  if (tendencia === "lateral") motivos.push("tendência lateral");
  return motivos;
}

function descreverTendencia(tendencia: string, intensidade: number): string {
  if (tendencia === "alta") return `tendência alta (${intensidade}%)`;
  if (tendencia === "baixa") return `tendência baixa (${intensidade}%)`;
  return "tendência lateral";
}

function descreverRSI(rsi: number): string {
  if (rsi < RSI_OVERSOLD) return `RSI sobrevendido (${rsi})`;
  if (rsi < RSI_LATERAL_LOW) return `RSI baixo (${rsi})`;
  if (rsi > RSI_OVERBOUGHT) return `RSI sobrecomprado (${rsi})`;
  if (rsi > RSI_LATERAL_HIGH) return `RSI alto (${rsi})`;
  return `RSI neutro (${rsi})`;
}

function descreverMomentum(momentum: number): string {
  const v = momentum.toFixed(3);
  if (momentum > 0.05) return `momentum positivo (${v}%/c)`;
  if (momentum < -0.05) return `momentum negativo (${v}%/c)`;
  return `momentum estável (${v}%/c)`;
}

function descreverFatores(
  analise: TecnicoAnalysis,
  rsi: number,
  intensidade: number,
  momentum: number,
  score: number
): string {
  return [
    descreverTendencia(analise.tendencia, intensidade),
    descreverRSI(rsi),
    descreverMomentum(momentum),
    `score ${score}`
  ].join(" + ");
}

function rotuloConfianca(score: number): string {
  if (score >= SCORE_LIBERA) return "[CONFIANÇA ALTA] ";
  if (score >= SCORE_MEDIO) return "";
  return "[CONFIANÇA BAIXA] ";
}

function descreverFiltrosMercado(quality: MarketQualityResult): string {
  return [
    `SMA9/SMA21 ${quality.smaDistancePct}%`,
    `ATR ${quality.atr} (${quality.atrPct}%)`,
    `volume relativo ${quality.volumeRelativo}x`,
    `MTF ${quality.logContext.alinhamentoMultiTimeframe}`
  ].join(" + ");
}

function logBloqueioMercado(ativo: string, sinal: string, motivos: string[], quality: MarketQualityResult): void {
  console.log(
    `[orchestrator] ${ativo}: ESPERAR (sinal: ${sinal}) | motivo do bloqueio: ${motivos.join("; ")} | ATR=${quality.atr} (${quality.atrPct}%) | volume relativo=${quality.volumeRelativo}x | alinhamento multi-timeframe=${quality.logContext.alinhamentoMultiTimeframe}.`
  );
  logger.info("marketFilters", `${ativo} bloqueado`, {
    sinal,
    motivos,
    atr: quality.atr,
    atrPct: quality.atrPct,
    volumeRelativo: quality.volumeRelativo,
    alinhamentoMultiTimeframe: quality.logContext.alinhamentoMultiTimeframe
  });
}

function logEdge(ativo: string, edge: EdgeResult): void {
  console.log(
    `[strategy] ${ativo}: setup=${edge.setup} ${edge.direcao} ${edge.timeframe} | edge=${edge.edgeScore} | trades=${edge.totalTrades} | PF=${edge.metrics.profitFactor} | expectancy=${edge.metrics.expectancy} | DD=${edge.metrics.drawdown}% | ${edge.motivos.join(" + ") || "neutro"}`
  );
  logger.info("strategy", `${ativo} ${edge.setup} edge`, {
    setup: edge.setup,
    direcao: edge.direcao,
    timeframe: edge.timeframe,
    edgeScore: edge.edgeScore,
    totalTrades: edge.totalTrades,
    blocked: edge.blocked,
    metrics: edge.metrics
  });
}

function scoreMinimoOperacional(base: number, lowFreq: { ativa: boolean }, inativo: { ativa: boolean }): number {
  if (lowFreq.ativa || inativo.ativa) return Math.max(48, base - 10);
  return base;
}

function isPremiumSetup(setup: SetupType, edge: EdgeResult | null, regimeInfo: { setupsFavorecidos: SetupType[]; confidence: number }): boolean {
  if (edge?.trusted && edge.edgeScore >= 70 && !edge.blocked) return true;
  return regimeInfo.confidence >= 60 && regimeInfo.setupsFavorecidos.includes(setup);
}

function logQuality(ativo: string, quality: MarketQualityAssessment): void {
  console.log(
    `[quality] ${ativo}: score=${quality.score} label=${quality.label} operavel=${quality.operavel} premiumOnly=${quality.premiumOnly} motivo=${quality.motivoPrincipal}`
  );
  logger.info("marketQuality", `${ativo} ${quality.label}`, {
    score: quality.score,
    operavel: quality.operavel,
    premiumOnly: quality.premiumOnly,
    motivo: quality.motivoPrincipal,
    metrics: quality.metrics
  });
}

export async function runTradingCycle(symbol: string = DEFAULT_SYMBOL): Promise<TradingCycleResult> {
  const ativo = symbol.toUpperCase();

  console.log(`[orchestrator] Coletando dados de ${ativo}...`);
  const market = await getMarketData(ativo, "1m");
  let marketMaior: MarketData = [];
  try {
    marketMaior = await getMarketData(ativo, "15m");
  } catch (errMtf) {
    recordError("market.service.15m", errMtf);
    logger.warn("marketFilters", `${ativo}: falha ao coletar timeframe 15m; filtros MTF vao bloquear entradas`, errMtf);
  }

  console.log(`[orchestrator] ${market.length} candles recebidos. Executando análise técnica...`);
  const analise = await tecnicoAgent(market);

  const closes = market.map((k) => Number(k[4]));
  const ultimoClose = closes[closes.length - 1];
  const precoEntrada = Number.isFinite(ultimoClose) ? ultimoClose : 0;

  const { rsi } = computeRSI(closes);
  const { intensidade } = analyzeTrend(closes);
  const { momentum } = computeMomentum(closes);
  const { breakout } = detectBreakout(closes);
  const qualityGate = assessMarketQuality(market);
  logQuality(ativo, qualityGate);

  updateMarketMemory(ativo, { tendencia: analise.tendencia, breakout });

  let sinalEfetivo: string = analise.sinal;
  if (breakout === "alta" && sinalEfetivo === "esperar") sinalEfetivo = "compra";
  else if (breakout === "baixa" && sinalEfetivo === "esperar") sinalEfetivo = "venda";

  let marketQuality = analyzeMarketQuality({
    lowerMarket: market,
    higherMarket: marketMaior,
    sinal: sinalEfetivo,
    breakout,
    rsi
  });

  const direcao = sinalEfetivo === "compra" ? "compra" : sinalEfetivo === "venda" ? "venda" : null;
  const regimeInfo = detectMarketRegime(market);
  const setup = classifySetup({ sinal: sinalEfetivo, breakout, rsi, momentum, marketQuality });
  const timeframe = "1m";
  const edge = direcao
    ? computeHistoricalEdge({ setup, ativo, timeframe, direcao, regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence })
    : null;
  const { score: scoreBaseRaw } = computeScore({ closes, direcao });
  const scoreBase = safeScore(scoreBaseRaw); // garante 0-100, sem NaN/Infinity

  // Aprendizado contextual: ajusta score com base em padrões históricos avaliados
  let adjustment;
  try {
    const perfHistorico = analyzePerformance();
    adjustment = computeConfidenceAdjustment(
      { decisao: sinalEfetivo, tendencia: analise.tendencia, rsi, momentum },
      perfHistorico
    );
  } catch (errLearning) {
    recordError("learningContext", errLearning);
    adjustment = { fator: 1, motivos: ["learning offline"], amostras: 0 };
  }
  const fatorSafe = Number.isFinite(adjustment.fator) ? adjustment.fator : 1;
  let score = safeScore(scoreBase * fatorSafe);
  if (marketQuality.penalidadeScore > 0) {
    const scoreAntesFiltros = score;
    score = safeScore(score - marketQuality.penalidadeScore);
    console.log(
      `[marketFilters] ${ativo}: score ${scoreAntesFiltros} - penalidade ${marketQuality.penalidadeScore} = ${score} | ATR=${marketQuality.atr} (${marketQuality.atrPct}%) | volume relativo=${marketQuality.volumeRelativo}x | alinhamento multi-timeframe=${marketQuality.logContext.alinhamentoMultiTimeframe}`
    );
  }
  if (adjustment.fator !== 1) {
    console.log(
      `[learning] ${ativo}: score ${scoreBase} × ${adjustment.fator} = ${score} | ${adjustment.motivos.join(" · ")}`
    );
  }
  if (edge) {
    logEdge(ativo, edge);
    if (edge.scoreDelta !== 0) {
      const scoreAntesEdge = score;
      score = safeScore(score + edge.scoreDelta);
      console.log(
        `[strategy] ${ativo}: score ${scoreAntesEdge} ${edge.scoreDelta > 0 ? "+" : ""}${edge.scoreDelta} = ${score} por edge historico (${edge.setup})`
      );
    }
  }
  if (qualityGate.scoreDelta !== 0) {
    const scoreAntesQuality = score;
    score = safeScore(score + qualityGate.scoreDelta);
    console.log(
      `[quality] ${ativo}: score ${scoreAntesQuality} ${qualityGate.scoreDelta > 0 ? "+" : ""}${qualityGate.scoreDelta} = ${score} (${qualityGate.label})`
    );
  }
  const regimeDelta = setupRegimeScoreDelta(setup, regimeInfo.regime, regimeInfo.confidence);
  if (regimeDelta !== 0) {
    const scoreAntesRegime = score;
    score = safeScore(score + regimeDelta);
    console.log(
      `[regime] ${ativo}: regime=${regimeInfo.regime} conf=${regimeInfo.confidence}% setup=${setup} score ${scoreAntesRegime} ${regimeDelta > 0 ? "+" : ""}${regimeDelta} = ${score}`
    );
  } else {
    console.log(
      `[regime] ${ativo}: regime=${regimeInfo.regime} conf=${regimeInfo.confidence}% setup=${setup} neutro`
    );
  }

  const portfolioBrain = getAdaptivePortfolioBrain({
    ativo,
    setup,
    regime: regimeInfo.regime,
    regimeConfidence: regimeInfo.confidence,
    confidence: score,
    edgeScore: edge?.edgeScore,
    market
  });
  const adaptiveRisk = portfolioBrain.adaptiveRisk;
  const setupBrain = shouldBlockSetup(setup, {
    ativo,
    setup,
    regime: regimeInfo.regime,
    regimeConfidence: regimeInfo.confidence,
    confidence: score,
    edgeScore: edge?.edgeScore,
    market
  });
  console.log(
    `[meta] ${ativo}: mode=${adaptiveRisk.riskMode} risk=${adaptiveRisk.riskPerTradePct}% minScore=${adaptiveRisk.minScore} stress=${portfolioBrain.marketStress.level} globalConf=${portfolioBrain.globalConfidence} dominant=${portfolioBrain.dominantSetup}`
  );
  logger.info("meta.brain", `${ativo} adaptive`, {
    riskMode: adaptiveRisk.riskMode,
    riskPerTradePct: adaptiveRisk.riskPerTradePct,
    minScore: adaptiveRisk.minScore,
    stress: portfolioBrain.marketStress,
    globalConfidence: portfolioBrain.globalConfidence,
    setupHealth: setupBrain.health
  });

  // ===== ML Signal Engine =====
  // prob > 0.65 → bônus, prob < 0.45 → penalidade, prob < 0.35 → bloqueio
  let mlBlock = false;
  let mlPrediction: ReturnType<typeof predictTradeProbability> | null = null;
  if (direcao) {
    try {
      mlPrediction = predictTradeProbability({
        rsi,
        atr: marketQuality.atr,
        atrPct: marketQuality.atrPct,
        momentum,
        intensidade,
        smaDistPct: analise.tendencia === "alta" ? intensidade : analise.tendencia === "baixa" ? -intensidade : 0,
        confianca: score,
        edgeScore: edge ? edge.edgeScore : 50,
        tendencia: analise.tendencia,
        direcao,
        setup
      });
      const p = mlPrediction.probability_profit;
      const scoreAntesML = score;
      let mlDelta = 0;
      if (mlPrediction.source === "model") {
        const mlWeight = portfolioBrain.adaptiveMlWeight;
        if (p > 0.65) mlDelta = Math.round(8 * mlWeight);
        else if (p < 0.25 && mlPrediction.confidence > 0.65 && portfolioBrain.mlHealth >= 70) mlBlock = true;
        else if (p < 0.35) mlDelta = Math.round(-10 * mlWeight);
        else if (p < 0.45) mlDelta = Math.round(-6 * mlWeight);
      }
      if (mlDelta !== 0) {
        score = safeScore(score + mlDelta);
        console.log(
          `[ml] ${ativo}: prob_profit=${p} confidence=${mlPrediction.confidence} (${mlPrediction.source}) weight=${portfolioBrain.adaptiveMlWeight} | score ${scoreAntesML} ${mlDelta > 0 ? "+" : ""}${mlDelta} = ${score}`
        );
      } else {
        console.log(
          `[ml] ${ativo}: prob_profit=${p} confidence=${mlPrediction.confidence} (${mlPrediction.source})${mlBlock ? " — BLOQUEIO" : ""}`
        );
      }
      logger.info("ml.predict", `${ativo}`, {
        probability: p,
        confidence: mlPrediction.confidence,
        source: mlPrediction.source,
        weight: portfolioBrain.adaptiveMlWeight,
        mlDelta,
        mlBlock
      });
    } catch (errML) {
      recordError("ml.predict", errML);
    }
  }

  const padroes = analyzePatterns();
  const fatoresBase = descreverFatores(analise, rsi, intensidade, momentum, score);
  const fatoresComBreakout = breakout !== "nenhum" ? `${fatoresBase} + breakout=${breakout}` : fatoresBase;
  const fatoresComML = mlPrediction ? `${fatoresComBreakout} + mlProb=${mlPrediction.probability_profit}` : fatoresComBreakout;
  const fatores = `${fatoresComML} + qualidade=${qualityGate.label}(${qualityGate.score}) + setup=${setup} + regime=${regimeInfo.regime}(${regimeInfo.confidence}%) + edge=${edge ? edge.edgeScore : "n/a"} + ${descreverFiltrosMercado(marketQuality)}`;

  let decisaoFinal = sinalEfetivo;
  const operacional = decisaoFinal === "compra" || decisaoFinal === "venda";
  let bloqueadoPorFiltrosMercado = false;

  const boot = checkBootstrap();
  const inativo = checkInactivity(ativo);
  const lowFreq = checkLowFrequency(ativo);

  if (operacional) {
    const motivosBloqueio: string[] = [];
    const premium = isPremiumSetup(setup, edge, regimeInfo);
    const minScoreOperacional = scoreMinimoOperacional(adaptiveRisk.minScore, lowFreq, inativo);
    if (!qualityGate.operavel && qualityGate.score < 18) {
      motivosBloqueio.push(`market quality bloqueou: ${qualityGate.label} score ${qualityGate.score} (${qualityGate.motivoPrincipal})`);
    }
    motivosBloqueio.push(...marketQuality.motivosBloqueio);
    if (edge?.blocked) {
      motivosBloqueio.push(`setup ${setup} auto-desativado por edge historico: ${edge.motivos.join(" + ")}`);
    }
    if (setupBrain.blocked) {
      motivosBloqueio.push(setupBrain.reason || `setup ${setup} bloqueado pelo adaptive brain`);
    }
    if (portfolioBrain.marketStress.blocked) {
      motivosBloqueio.push(`market stress ${portfolioBrain.marketStress.level}: ${portfolioBrain.marketStress.reasons.join(" + ") || portfolioBrain.marketStress.score}`);
    }
    if (score < minScoreOperacional) {
      motivosBloqueio.push(`score ${score} abaixo do mínimo adaptativo ${minScoreOperacional} (${adaptiveRisk.riskMode})`);
    }
    if (isSetupPenalizedByRegime(setup, regimeInfo.regime, regimeInfo.confidence) && score < 70 && !lowFreq.ativa) {
      motivosBloqueio.push(`setup ${setup} penalizado no regime ${regimeInfo.regime}`);
    }
    if (mlBlock && mlPrediction) {
      motivosBloqueio.push(`ML prob_profit=${mlPrediction.probability_profit} < 0.35 (modelo ${mlPrediction.model_version || "n/a"})`);
    }

    if ((lowFreq.ativa || inativo.ativa) && qualityGate.operavel && !portfolioBrain.marketStress.blocked && score >= 48) {
      const antes = motivosBloqueio.length;
      for (let i = motivosBloqueio.length - 1; i >= 0; i -= 1) {
        if (
          motivosBloqueio[i].includes("score ") ||
          motivosBloqueio[i].includes("setup ") ||
          motivosBloqueio[i].includes("market quality")
        ) {
          motivosBloqueio.splice(i, 1);
        }
      }
      if (antes !== motivosBloqueio.length) {
        console.log(`[decision-approved] ${ativo}: force minimum activity liberou fluxo operacional | score=${score} quality=${qualityGate.score} risk=${adaptiveRisk.riskPerTradePct}%`);
      }
    }

    if (!boot.ativo && !inativo.ativa && !lowFreq.ativa && tendenciaProibida(analise.tendencia, padroes.piorTendencia)) {
      motivosBloqueio.push(`tendência "${analise.tendencia}" historicamente ruim`);
    }

    const tagBoot = boot.ativo
      ? `[BOOTSTRAP ${boot.total}/${boot.limite}] `
      : inativo.ativa
        ? `[INATIVIDADE ${inativo.ciclosEsperar} ciclos] `
        : lowFreq.ativa
          ? `[BAIXA FREQUÊNCIA ${lowFreq.ciclosSemOperacao} ciclos sem op] `
          : "";

    if (motivosBloqueio.length > 0) {
      bloqueadoPorFiltrosMercado = marketQuality.motivosBloqueio.length > 0;
      logBloqueioMercado(ativo, decisaoFinal, motivosBloqueio, marketQuality);
      console.log(
        `[orchestrator] ${ativo}: ${tagBoot}ESPERAR (sinal IA: ${decisaoFinal}) → ${fatores}. Bloqueado por: ${resumirMotivos(motivosBloqueio)} | detalhes: ${motivosBloqueio.join("; ")}.`
      );
      decisaoFinal = "esperar";
    } else {
      console.log(
        `[orchestrator] ${ativo}: ${tagBoot}${rotuloConfianca(score)}${decisaoFinal.toUpperCase()}: ${fatores}.`
      );
    }
  } else {
    const motivos = motivosEsperarIA(rsi, analise.tendencia);
    console.log(
      `[orchestrator] ${ativo}: ESPERAR: ${fatores}. Motivo: ${motivos.join(" + ")}.`
    );
  }

  if (decisaoFinal === "esperar" && !bloqueadoPorFiltrosMercado) {
    const janela = breakoutAtivo(ativo);
    if (janela) {
      const direcaoJanela = janela.direcao === "alta" ? "compra" : "venda";
      const qualidadeJanela = analyzeMarketQuality({
        lowerMarket: market,
        higherMarket: marketMaior,
        sinal: direcaoJanela,
        breakout: janela.direcao,
        rsi
      });
      if (qualidadeJanela.motivosBloqueio.length > 0) {
        marketQuality = qualidadeJanela;
        bloqueadoPorFiltrosMercado = true;
        logBloqueioMercado(ativo, direcaoJanela, qualidadeJanela.motivosBloqueio, qualidadeJanela);
      } else {
        marketQuality = qualidadeJanela;
      console.log(
        `[orchestrator] ${ativo}: ${direcaoJanela.toUpperCase()} [JANELA-BREAKOUT]: ${fatores}. Breakout ${janela.direcao} há ${janela.ciclosDesdeBreakout} ciclo(s), dentro da janela de oportunidade.`
      );
      decisaoFinal = direcaoJanela;
      }
    }
  }

  if (decisaoFinal === "esperar" && !bloqueadoPorFiltrosMercado) {
    const forcado = shouldForceExploration(ativo, momentum);
    if (forcado) {
      const qualidadeForcada = analyzeMarketQuality({
        lowerMarket: market,
        higherMarket: marketMaior,
        sinal: forcado,
        breakout,
        rsi
      });
      if (qualidadeForcada.motivosBloqueio.length > 0) {
        marketQuality = qualidadeForcada;
        bloqueadoPorFiltrosMercado = true;
        logBloqueioMercado(ativo, forcado, qualidadeForcada.motivosBloqueio, qualidadeForcada);
      } else {
        marketQuality = qualidadeForcada;
      console.log(
        `[orchestrator] ${ativo}: FORÇA EXPLORAÇÃO → ${forcado.toUpperCase()} (a cada 10 ciclos sem operações recentes, geração de dados).`
      );
      decisaoFinal = forcado;
      }
    }
  }

  const cooldown = checkLossCooldown(ativo);
  if (cooldown.ativa && (decisaoFinal === "compra" || decisaoFinal === "venda")) {
    console.log(
      `[orchestrator] ${ativo}: COOLDOWN PÓS-PERDA → esperar (${cooldown.ciclosRestantes}/${cooldown.limite} ciclos restantes).`
    );
    decisaoFinal = "esperar";
  }

  // Heartbeat + log do ciclo
  recordCycle(ativo, decisaoFinal);
  logger.info("orchestrator", `${ativo} → ${decisaoFinal}`, {
    score,
    rsi,
    momentum,
    tendencia: analise.tendencia,
    atr: marketQuality.atr,
    atrPct: marketQuality.atrPct,
    volumeRelativo: marketQuality.volumeRelativo,
    alinhamentoMultiTimeframe: marketQuality.logContext.alinhamentoMultiTimeframe
    ,
    setup,
    edgeScore: edge?.edgeScore,
    regime: regimeInfo.regime,
    regimeConfidence: regimeInfo.confidence,
    marketQualityScore: qualityGate.score,
    marketQualityLabel: qualityGate.label,
    adaptiveRiskMode: adaptiveRisk.riskMode,
    adaptiveRiskPct: adaptiveRisk.riskPerTradePct,
    adaptiveMinScore: adaptiveRisk.minScore,
    systemStress: portfolioBrain.marketStress.level,
    globalConfidence: portfolioBrain.globalConfidence
  });

  return {
    ativo,
    decisao: decisaoFinal,
    confianca: safeConfidence(score),
    analise,
    precoEntrada,
    rsi,
    momentum,
    intensidade,
    atr: marketQuality.atr,
    atrPct: marketQuality.atrPct,
    volumeRelativo: marketQuality.volumeRelativo,
    drawdownAtual: 0,
    setup,
    timeframe,
    edgeScore: edge?.edgeScore,
    regime: regimeInfo.regime,
    regimeConfidence: regimeInfo.confidence,
    marketQualityScore: qualityGate.score,
    marketQualityLabel: qualityGate.label
  };
}

// Re-exporta heartbeat para o loop principal poder pulsar entre ciclos
export { heartbeat as orchestratorHeartbeat };
