// ===== constantes =====
const REFRESH_INTERVAL_MS = 5_000;
const KLINES_TTL_MS = 25_000;
const KLINES_LIMIT = 150;
const MIN_KLINES_INDICATORS = 30;
const RSI_PERIOD = 14;
const SMA_FAST_PERIOD = 9;
const SMA_SLOW_PERIOD = 21;
const STALE_MS = 90_000;
const OFFLINE_MS = 240_000;
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const FETCH_TIMEOUT_MS = 12_000;

// ===== debug logger =====
// desliga setando window.__IA_TRADER_DEBUG__ = false no console
function dbg(...args) {
  if (typeof window !== "undefined" && window.__IA_TRADER_DEBUG__ === false) return;
  console.log("[chart]", ...args);
}

// ===== estado encapsulado =====
const state = {
  ativoSelecionado: null,
  symbols: [],                                     // lista canônica vinda de /symbols
  cachedRepairBacktest: null,                      // GET /repair-backtest (fonte dos cards)
  cachedStrategyPerformance: null,                 // GET /strategy-performance
  cachedMarketRegime: null,                        // GET /market-regime
  cachedMarketQuality: null,                       // GET /market-quality
  cachedExecutionLive: null,
  cachedTradeTimeline: null,
  cachedExecutionAnalytics: null,
  cachedExecutionHealth: null,
  cachedExchangeConditions: null,
  cachedPortfolioAnalytics: null,
  cachedMonteCarlo: null,
  cachedMetaBrain: null,
  cachedDecisionsBySymbol: Object.create(null),    // decisões filtradas por ativo
  cachedKlinesBySymbol: Object.create(null),       // klines Binance por ativo
  chartStateBySymbol: Object.create(null),         // signatures de render por ativo
  tabSwitchToken: 0,                               // race protection para tab switch
  chartLoadingBySymbol: Object.create(null),
  refreshInFlight: false,
  refreshIntervalId: null,
  repairGeneration: 0,
  mlStatus: null,
  lastMlPrediction: null,
  datasetStats: null,
  health: null
};

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function getAssetState(symbol) {
  const symU = normalizeSymbol(symbol);
  if (!symU) return null;
  if (!state.chartStateBySymbol[symU]) {
    state.chartStateBySymbol[symU] = {
      lastChartSignature: null,
      chartMounted: false,
      chart: null,
      candleSeries: null,
      volumeSeries: null,
      resizeObserver: null
    };
  }
  return state.chartStateBySymbol[symU];
}

function invalidateChartState(symbol) {
  const assetState = getAssetState(symbol);
  if (!assetState) return;
  assetState.lastChartSignature = null;
  assetState.chartMounted = false;
}

function destroyTradingViewChart(symbol) {
  const symU = normalizeSymbol(symbol);
  if (!symU) return;
  const assetState = getAssetState(symU);
  const els = getChartElements(symU);

  if (assetState.resizeObserver) {
    assetState.resizeObserver.disconnect();
    assetState.resizeObserver = null;
  }

  if (assetState.chart && typeof assetState.chart.remove === "function") {
    assetState.chart.remove();
  }

  assetState.chart = null;
  assetState.candleSeries = null;
  assetState.volumeSeries = null;
  assetState.lastChartSignature = null;
  assetState.chartMounted = false;

  if (els.chart) els.chart.innerHTML = "";
  if (els.hover) els.hover.textContent = "mova o mouse sobre o grafico";
}

function symbolDomKey(symbol) {
  return normalizeSymbol(symbol).replace(/[^A-Z0-9_-]/g, "");
}

function chartId(symbol) {
  return "chart-" + symbolDomKey(symbol);
}

function assetThemeClass(symbol) {
  const symU = normalizeSymbol(symbol);
  if (symU.startsWith("BTC")) return "asset-btc";
  if (symU.startsWith("ETH")) return "asset-eth";
  return "asset-default";
}

function getChartElements(symbol) {
  const symU = normalizeSymbol(symbol);
  return {
    panel: document.getElementById("chart-panel-" + symbolDomKey(symU)),
    chart: document.getElementById(chartId(symU)),
    hover: document.getElementById("chart-hover-" + symbolDomKey(symU))
  };
}

function ensureChartPanels(ativos) {
  const wrap = document.getElementById("chartPanels");
  if (!wrap) return;
  const wanted = new Set(ativos.map(normalizeSymbol).filter(Boolean));
  wrap.querySelectorAll(".chart-panel").forEach((panel) => {
    if (!wanted.has(normalizeSymbol(panel.dataset.ativo))) panel.remove();
  });
  wanted.forEach((symU) => {
    const panelId = "chart-panel-" + symbolDomKey(symU);
    if (!document.getElementById(panelId)) {
      const panel = document.createElement("div");
      panel.className = "chart-panel " + assetThemeClass(symU);
      panel.id = panelId;
      panel.dataset.ativo = symU;
      panel.innerHTML =
        '<div class="tv-chart-wrap">' +
          '<div class="tv-chart-toolbar">' +
            '<span class="tv-chart-title">' + symU + ' · Binance Spot · 1m</span>' +
            '<span class="tv-chart-hover" id="chart-hover-' + symbolDomKey(symU) + '">mova o mouse sobre o gráfico</span>' +
          '</div>' +
          '<div class="tv-chart" id="' + chartId(symU) + '"></div>' +
        '</div>';
      wrap.appendChild(panel);
      invalidateChartState(symU);
    }
  });
  setActiveChartPanel(state.ativoSelecionado);
}

function setActiveChartPanel(symbol) {
  const symU = normalizeSymbol(symbol);
  document.querySelectorAll(".chart-panel").forEach((panel) => {
    const active = normalizeSymbol(panel.dataset.ativo) === symU;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
    if (active) {
      const assetState = getAssetState(symU);
      if (assetState && assetState.chart) {
        const el = getChartElements(symU).chart;
        if (el && typeof assetState.chart.resize === "function") {
          assetState.chart.resize(Math.max(320, el.clientWidth), 410, true);
        }
        assetState.chart.timeScale().fitContent();
      }
    }
  });
}

// ===== helpers =====
function fmtNum(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: d });
}
function fmtPriceDelta(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  const pct = ((curr - prev) / prev) * 100;
  return { pct, sign: pct > 0 ? "+" : pct < 0 ? "" : "" };
}
function pill(v) { return '<span class="pill b-' + v + '">' + v + "</span>"; }
function clsSign(v) { return v > 0 ? "pos" : v < 0 ? "neg" : "mid"; }
function fmtTs(iso) {
  try { return new Date(iso).toLocaleString("pt-BR"); } catch { return String(iso); }
}
function fmtTime(ts) {
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return Math.round(ms / 1000) + "s atrás";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "min atrás";
  return Math.round(ms / 3_600_000) + "h atrás";
}
function rsiClassify(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return { tag: "—", cls: "rsi-neutro" };
  if (v > 70) return { tag: "sobrecomprado", cls: "rsi-sobrecomprado" };
  if (v < 30) return { tag: "sobrevendido", cls: "rsi-sobrevendido" };
  return { tag: "neutro", cls: "rsi-neutro" };
}
function ativosUnicos(decisions) {
  return [...new Set(decisions.map((d) => d && d.ativo).filter(Boolean))];
}

// ===== network =====
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function safeFetchJson(url, opts) {
  const res = await fetchWithTimeout(url, Object.assign({ cache: "no-store" }, opts || {}));
  if (!res.ok) throw new Error(url + " → HTTP " + res.status);
  return res.json();
}

function noCacheUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "_ts=" + Date.now();
}

const DASHBOARD_METRICS_SOURCE = "repair-backtest";
const DASHBOARD_FORBIDDEN_METRICS_ENDPOINTS = new Set(["/performance", "/performance-sql"]);

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function dashboardEndpointPath(url) {
  try {
    return new URL(String(url), window.location.origin).pathname;
  } catch {
    return String(url).split("?")[0];
  }
}

function assertDashboardMetricsSource(url) {
  const path = dashboardEndpointPath(url);
  if (DASHBOARD_FORBIDDEN_METRICS_ENDPOINTS.has(path)) {
    throw new Error("[dashboard] fonte legada bloqueada: " + path);
  }
}

function logDashboardMetricsSource() {
  console.log("[dashboard] metrics source: repair-backtest");
}

function clampRetornoPct(value, context) {
  const n = finiteNumber(value, 0);
  if (n < -100) {
    console.warn("[sanity-check] retorno inválido detectado", {
      source: DASHBOARD_METRICS_SOURCE,
      context: context || "dashboard",
      retornoPct: n
    });
    return -100;
  }
  return n;
}

function normalizeRepairDashboardMetrics(data) {
  const repair = data && typeof data === "object" ? data : {};
  const saldoInicial = Math.max(0, finiteNumber(repair.saldoInicial, 1000)) || 1000;
  const saldoFinalRaw = finiteNumber(repair.saldoFinal, NaN);
  const endpointRetornoPct = finiteNumber(repair.retornoPct ?? repair.retornoTotalPct, NaN);
  if (Number.isFinite(endpointRetornoPct)) {
    clampRetornoPct(endpointRetornoPct, "repair.retornoPct");
  }
  const compoundRetornoPct = Number.isFinite(saldoFinalRaw) && saldoInicial > 0
    ? ((saldoFinalRaw - saldoInicial) / saldoInicial) * 100
    : NaN;
  const retornoRaw = Number.isFinite(compoundRetornoPct)
    ? compoundRetornoPct
    : 0;
  const retornoTotalPct = clampRetornoPct(retornoRaw, "retornoTotalPct");
  const saldoFinal = Number.isFinite(saldoFinalRaw)
    ? Math.max(0, saldoFinalRaw)
    : Math.max(0, saldoInicial * (1 + retornoTotalPct / 100));
  const drawdownMaxPct = Math.min(100, Math.max(0, finiteNumber(repair.drawdown ?? repair.drawdownMaxPct ?? repair.maxDrawdown, 0)));
  const winRate = Math.min(100, Math.max(0, finiteNumber(repair.winRate, 0)));
  const totalTrades = Math.max(0, Math.trunc(finiteNumber(repair.totalTrades ?? repair.tradesValidos, 0)));
  const profitFactor = finiteNumber(repair.profitFactor, 0);
  const expectancy = finiteNumber(repair.expectancy, 0);

  return {
    totalTrades,
    winRate,
    lucro: Math.max(0, retornoTotalPct),
    prejuizo: Math.max(0, -retornoTotalPct),
    retornoPct: retornoTotalPct,
    retornoTotalPct,
    saldoFinal,
    saldoInicial,
    drawdown: drawdownMaxPct,
    drawdownMaxPct,
    profitFactor,
    expectancy,
    _source: DASHBOARD_METRICS_SOURCE,
    _scope: DASHBOARD_METRICS_SOURCE
  };
}

async function fetchRepairBacktest() {
  const url = noCacheUrl("/repair-backtest");
  assertDashboardMetricsSource(url);
  const data = await safeFetchJson(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  console.log("[repair]", data);
  logDashboardMetricsSource();
  state.cachedRepairBacktest = data && typeof data === "object" ? data : null;
  return state.cachedRepairBacktest;
}

async function fetchStrategyPerformance() {
  const data = await safeFetchJson(noCacheUrl("/strategy-performance"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedStrategyPerformance = data && typeof data === "object" ? data : null;
  return state.cachedStrategyPerformance;
}

async function fetchMarketRegime() {
  const symbol = normalizeSymbol(state.ativoSelecionado) || "BTCUSDT";
  const data = await safeFetchJson(noCacheUrl("/market-regime?symbol=" + encodeURIComponent(symbol) + "&timeframe=1m"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedMarketRegime = data && typeof data === "object" ? data : null;
  return state.cachedMarketRegime;
}

async function fetchMarketQuality() {
  const symbol = normalizeSymbol(state.ativoSelecionado) || "BTCUSDT";
  const data = await safeFetchJson(noCacheUrl("/market-quality?symbol=" + encodeURIComponent(symbol) + "&timeframe=1m"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedMarketQuality = data && typeof data === "object" ? data : null;
  return state.cachedMarketQuality;
}

async function fetchExecutionLive(symbol) {
  const symU = normalizeSymbol(symbol) || normalizeSymbol(state.ativoSelecionado) || "BTCUSDT";
  const data = await safeFetchJson(noCacheUrl("/execution/live?symbol=" + encodeURIComponent(symU)), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedExecutionLive = data && typeof data === "object" ? data : null;
  return state.cachedExecutionLive;
}

async function fetchTradeTimeline(positionId) {
  const qs = positionId ? "?positionId=" + encodeURIComponent(positionId) : "";
  const data = await safeFetchJson(noCacheUrl("/execution/timeline" + qs), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedTradeTimeline = data && typeof data === "object" ? data : null;
  return state.cachedTradeTimeline;
}

async function fetchExecutionAnalytics() {
  const data = await safeFetchJson(noCacheUrl("/execution/analytics"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedExecutionAnalytics = data && typeof data === "object" ? data : null;
  return state.cachedExecutionAnalytics;
}

async function fetchExecutionHealth() {
  const data = await safeFetchJson(noCacheUrl("/execution/health"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedExecutionHealth = data && typeof data === "object" ? data : null;
  return state.cachedExecutionHealth;
}

async function fetchExchangeConditions() {
  const data = await safeFetchJson(noCacheUrl("/exchange/conditions"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedExchangeConditions = data && typeof data === "object" ? data : null;
  return state.cachedExchangeConditions;
}

async function fetchPortfolioAnalytics() {
  const data = await safeFetchJson(noCacheUrl("/portfolio/analytics"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedPortfolioAnalytics = data && typeof data === "object" ? data : null;
  return state.cachedPortfolioAnalytics;
}

async function fetchMonteCarlo() {
  const data = await safeFetchJson(noCacheUrl("/quant/monte-carlo?iterations=750&horizonTrades=120"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedMonteCarlo = data && typeof data === "object" ? data : null;
  return state.cachedMonteCarlo;
}

async function fetchMetaBrain(symbol) {
  const symU = normalizeSymbol(symbol) || normalizeSymbol(state.ativoSelecionado) || "BTCUSDT";
  const data = await safeFetchJson(noCacheUrl("/meta/brain?symbol=" + encodeURIComponent(symU)), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  state.cachedMetaBrain = data && typeof data === "object" ? data : null;
  return state.cachedMetaBrain;
}

async function fetchSymbolList() {
  try {
    const list = await safeFetchJson("/symbols");
    if (Array.isArray(list)) return list.map(normalizeSymbol).filter(Boolean);
  } catch (err) {
    console.warn("[fetchSymbolList]", err.message);
  }
  return ["BTCUSDT", "ETHUSDT"];
}

async function fetchBotDecisions(symbol) {
  const symU = normalizeSymbol(symbol);
  if (!symU) return [];
  try {
    const data = await safeFetchJson("/decisions?symbol=" + encodeURIComponent(symU));
    const arr = Array.isArray(data) ? data : [];
    const filtered = arr.filter((d) =>
      d && typeof d.ativo === "string" && d.ativo.toUpperCase() === symU
    );
    state.cachedDecisionsBySymbol[symU] = filtered;
    return filtered;
  } catch (err) {
    console.error("[fetchBotDecisions]", symU, err);
    state.cachedDecisionsBySymbol[symU] = state.cachedDecisionsBySymbol[symU] || [];
    return state.cachedDecisionsBySymbol[symU];
  }
}

async function fetchBinanceKlines(symbol) {
  const symU = normalizeSymbol(symbol);
  if (!symU) return [];
  const cached = state.cachedKlinesBySymbol[symU];
  if (cached && (Date.now() - cached.ts) < KLINES_TTL_MS && Array.isArray(cached.data) && cached.data.length > 0) {
    dbg("klines cache hit", symU, "n=" + cached.data.length);
    return cached.data;
  }
  const url = BINANCE_KLINES_URL + "?symbol=" + encodeURIComponent(symU) + "&interval=1m&limit=" + KLINES_LIMIT;
  try {
    dbg("klines fetching", symU);
    const res = await fetchWithTimeout(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Binance HTTP " + res.status);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error("resposta inválida da Binance");
    const data = raw
      .map((k) => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[6])
      }))
      .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.openTime));
    state.cachedKlinesBySymbol[symU] = { ts: Date.now(), data };
    dbg("klines OK", symU, "n=" + data.length, "primeiro=" + (data[0] && data[0].close), "último=" + (data[data.length - 1] && data[data.length - 1].close));
    return data;
  } catch (err) {
    console.error("[fetchBinanceKlines]", symU, err);
    return cached && Array.isArray(cached.data) ? cached.data : [];
  }
}

// ===== bot status =====
function updateBotStatus(lastTs) {
  const dot = document.getElementById("botDot");
  const txt = document.getElementById("botStatus");
  // Se /health respondeu, ele dita o status (precedência sobre last decision timestamp)
  const h = state.health;
  if (h && typeof h === "object") {
    if (h.online === false) {
      dot.className = "dot offline";
      txt.textContent = h.lastHeartbeat ? "offline (sem heartbeat " + Math.round((h.lastHeartbeatAgeMs || 0) / 1000) + "s)" : "offline";
      return;
    }
    if (h.watchdog && h.watchdog.stale) {
      dot.className = "dot stale";
      txt.textContent = "stale (watchdog disparou)";
      return;
    }
    dot.className = "dot";
    txt.textContent = "online";
    return;
  }
  // Fallback: se /health não respondeu (server caído), usa último ciclo via decisões
  if (!lastTs) {
    dot.className = "dot offline";
    txt.textContent = "offline";
    return;
  }
  const age = Date.now() - new Date(lastTs).getTime();
  if (age < STALE_MS) {
    dot.className = "dot";
    txt.textContent = "online";
  } else if (age < OFFLINE_MS) {
    dot.className = "dot stale";
    txt.textContent = "stale (" + ago(lastTs) + ")";
  } else {
    dot.className = "dot offline";
    txt.textContent = "offline (" + ago(lastTs) + ")";
  }
}

function fmtUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

function updateHealthIndicators() {
  const h = state.health;
  const intervaloEl = document.getElementById("cicloIntervalo");
  if (!intervaloEl) return;
  if (!h || typeof h !== "object") return;
  const partes = [];
  if (Number.isFinite(h.uptime)) partes.push("up " + fmtUptime(h.uptime));
  if (h.memoryUsage && Number.isFinite(h.memoryUsage.rssMB)) partes.push("mem " + h.memoryUsage.rssMB + "MB");
  if (h.lastCycle && h.lastCycle.ageMs !== undefined) {
    partes.push("ciclo " + Math.round(h.lastCycle.ageMs / 1000) + "s");
  }
  if (h.lastBinanceFetch && h.lastBinanceFetch.ageMs !== undefined) {
    partes.push("binance " + Math.round(h.lastBinanceFetch.ageMs / 1000) + "s");
  }
  intervaloEl.textContent = partes.join(" · ") || "—";
}

async function fetchDatasetStats() {
  try {
    const res = await fetch("/dataset/stats", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.datasetStats = data;
  } catch (err) {
    state.datasetStats = null;
    if (window.__IA_TRADER_DEBUG__ !== false) console.warn("[dataset]", err.message);
  }
}

async function fetchMlStatus() {
  try {
    const res = await fetch("/ml/status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.mlStatus = await res.json();
  } catch (err) {
    state.mlStatus = null;
    if (window.__IA_TRADER_DEBUG__ !== false) console.warn("[ml]", err.message);
  }
}

async function fetchMlPredictionForCurrent() {
  const symU = normalizeSymbol(state.ativoSelecionado);
  if (!symU) return;
  const decisoes = state.cachedDecisionsBySymbol[symU] || [];
  const last = decisoes.length ? decisoes[decisoes.length - 1] : null;
  if (!last) return;
  const params = new URLSearchParams();
  if (typeof last.rsi === "number") params.set("rsi", String(last.rsi));
  if (typeof last.momentum === "number") params.set("momentum", String(last.momentum));
  if (typeof last.intensidade === "number") params.set("intensidade", String(last.intensidade));
  if (typeof last.confianca === "number") params.set("confianca", String(last.confianca));
  if (last.tendencia) params.set("tendencia", last.tendencia);
  if (last.decisao && (last.decisao === "compra" || last.decisao === "venda")) params.set("direcao", last.decisao);
  try {
    const res = await fetch("/ml/predict?" + params.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.lastMlPrediction = await res.json();
  } catch {
    state.lastMlPrediction = null;
  }
}

function renderMlCard() {
  const meta = state.mlStatus && state.mlStatus.model;
  const verEl = document.getElementById("mlVersion");
  const algoEl = document.getElementById("mlAlgo");
  const accEl = document.getElementById("mlAccuracy");
  const samplesEl = document.getElementById("mlSamples");
  const probEl = document.getElementById("mlProb");
  const sourceEl = document.getElementById("mlSource");
  const confEl = document.getElementById("mlConf");
  if (!verEl) return;
  if (!meta) {
    verEl.textContent = "—";
    if (algoEl) algoEl.textContent = "modelo não treinado";
    if (accEl) accEl.textContent = "—";
    if (samplesEl) samplesEl.textContent = "aguardando ≥500 amostras válidas";
  } else {
    try { verEl.textContent = new Date(meta.version).toLocaleString("pt-BR"); }
    catch { verEl.textContent = meta.version; }
    if (algoEl) algoEl.textContent = meta.algorithm + " · base " + meta.baseRate + "%";
    if (accEl) accEl.textContent = meta.accuracy + "%";
    if (samplesEl) samplesEl.textContent = meta.sampleCount + " samples · train " + meta.trainSize + " · test " + meta.testSize;
  }
  const last = state.lastMlPrediction;
  if (last && Number.isFinite(last.probability_profit)) {
    if (probEl) probEl.textContent = (last.probability_profit * 100).toFixed(1) + "%";
    if (sourceEl) sourceEl.textContent = last.source + (last.notes ? " · " + last.notes : "");
    if (confEl) confEl.textContent = (last.confidence * 100).toFixed(0) + "%";
  } else {
    if (probEl) probEl.textContent = "—";
    if (sourceEl) sourceEl.textContent = "aguardando ciclo…";
    if (confEl) confEl.textContent = "—";
  }
}

async function triggerMlRetrain() {
  const btn = document.getElementById("btnRetrain");
  const statusEl = document.getElementById("mlRetrainStatus");
  if (!btn || !statusEl) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "treinando…";
  statusEl.className = "";
  statusEl.textContent = "iniciando treino…";
  try {
    const res = await fetch("/ml/retrain", { method: "POST", cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && data.ok && data.meta) {
      statusEl.className = "ok";
      statusEl.textContent = "✓ acc " + data.meta.accuracy + "% · " + data.meta.sampleCount + " samples";
      await fetchMlStatus();
      renderMlCard();
    } else {
      statusEl.className = "bad";
      statusEl.textContent = "✗ " + (data && data.error ? data.error : "falhou");
    }
  } catch (err) {
    statusEl.className = "bad";
    statusEl.textContent = "✗ " + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    setTimeout(() => {
      if (statusEl.classList.contains("ok")) {
        statusEl.textContent = "";
        statusEl.className = "";
      }
    }, 12_000);
  }
}

function renderDatasetCard() {
  const ds = state.datasetStats;
  const totalEl = document.getElementById("dsTotal");
  const avaliadasEl = document.getElementById("dsAvaliadas");
  const setupsEl = document.getElementById("dsSetups");
  const setupsTopEl = document.getElementById("dsSetupsTop");
  const ativosEl = document.getElementById("dsAtivos");
  const ativosListEl = document.getElementById("dsAtivosList");
  const geradoEl = document.getElementById("dsGeradoEm");
  if (!totalEl || !setupsEl || !ativosEl) return;
  if (!ds || typeof ds !== "object") {
    totalEl.textContent = "—";
    setupsEl.textContent = "—";
    ativosEl.textContent = "—";
    if (avaliadasEl) avaliadasEl.textContent = "indisponível";
    if (setupsTopEl) setupsTopEl.textContent = "";
    if (ativosListEl) ativosListEl.textContent = "";
    if (geradoEl) geradoEl.textContent = "";
    return;
  }
  totalEl.textContent = fmtNum(ds.totalSamples ?? 0, 0);
  if (avaliadasEl) {
    avaliadasEl.textContent =
      (ds.totalAvaliadas ?? 0) + " avaliadas · " + (ds.totalPendentes ?? 0) + " pendentes";
  }

  const setupsKeys = Object.keys(ds.setups || {});
  setupsEl.textContent = String(setupsKeys.length);
  if (setupsTopEl) {
    const top = Array.isArray(ds.setupsTopWinRate) ? ds.setupsTopWinRate.slice(0, 3) : [];
    setupsTopEl.textContent = top.length
      ? top.map((s) => s.setup + " (" + s.winRate + "% wr · " + s.total + ")").join(" · ")
      : "sem dados";
  }

  const ativosKeys = Object.keys(ds.ativos || {});
  ativosEl.textContent = String(ativosKeys.length);
  if (ativosListEl) {
    ativosListEl.textContent = ativosKeys
      .map((a) => a + " (" + ds.ativos[a] + ")")
      .join(" · ") || "—";
  }
  if (geradoEl && ds.geradoEm) {
    try { geradoEl.textContent = "atualizado " + new Date(ds.geradoEm).toLocaleTimeString("pt-BR"); }
    catch { geradoEl.textContent = ""; }
  }
}

async function fetchHealth() {
  try {
    const res = await fetch("/health", { cache: "no-store" });
    // 200 ou 503 são respostas válidas (503 = stale/offline mas server vivo)
    const data = await res.json().catch(() => null);
    if (data && typeof data === "object") {
      state.health = data;
      return;
    }
    state.health = { online: false, error: "resposta inválida" };
  } catch (err) {
    // /health não respondeu → server completamente caído
    state.health = { online: false, error: err.message };
  }
}

function setChartLoading(symbol, loading) {
  const symU = normalizeSymbol(symbol);
  if (!symU) return;
  if (!state.chartLoadingBySymbol) state.chartLoadingBySymbol = Object.create(null);
  state.chartLoadingBySymbol[symU] = Boolean(loading);
}

// ===== tabs =====
function renderTabs(ativos) {
  const wrap = document.getElementById("chartTabs");
  ativos = ativos.map(normalizeSymbol).filter(Boolean);
  state.ativoSelecionado = normalizeSymbol(state.ativoSelecionado);
  if (!state.ativoSelecionado && ativos.length) state.ativoSelecionado = ativos[0];
  wrap.innerHTML = ativos
    .map((a) => {
      const active = a === state.ativoSelecionado ? " active" : "";
      const klines = state.cachedKlinesBySymbol[a];
      const last = klines && klines.data && klines.data[klines.data.length - 1];
      const price = last ? fmtNum(last.close, 2) : "—";
      return '<button class="tab ' + assetThemeClass(a) + active + '" data-ativo="' + a + '"><span class="tab-sym">' + a + '</span><span class="tab-price">' + price + "</span></button>";
    })
    .join("");
  wrap.querySelectorAll("button").forEach((btn) => {
    btn.onclick = async () => {
      const target = normalizeSymbol(btn.dataset.ativo);
      if (!target || target === state.ativoSelecionado) return;
      const previous = normalizeSymbol(state.ativoSelecionado);
      destroyTradingViewChart(previous);
      destroyTradingViewChart(target);
      state.ativoSelecionado = target;
      setActiveChartPanel(target);
      const myToken = ++state.tabSwitchToken;
      const els = getChartElements(target);
      setChartLoading(target, true);
      if (els.chart) els.chart.innerHTML = '<div class="chart-empty">carregando ' + target + "...</div>";
      try {
        await Promise.all([fetchBinanceKlines(target), fetchBotDecisions(target)]);
      } catch (err) {
        console.error("[tabSwitch]", target, err);
      } finally {
        setChartLoading(target, false);
        // Se outro tab foi clicado durante o fetch, ignora este render — o mais novo vence
        if (myToken === state.tabSwitchToken) renderAll();
      }
    };
  });
}

// ===== indicadores =====
function rsiSeries(values, period) {
  period = period || 14;
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const calc = (g, l) => l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  out[period] = calc(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = calc(avgGain, avgLoss);
  }
  return out;
}
function smaSeries(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out.push(s / period);
  }
  return out;
}

// ===== chart RSI =====
function renderRsiChart(symbol, closes, signature, assetState) {
  const symU = normalizeSymbol(symbol);
  if (signature && assetState && assetState.rsiMounted && signature === assetState.lastRsiSignature) return;
  if (assetState) assetState.lastRsiSignature = signature;
  const svg = getChartElements(symU).rsi;
  if (!svg) return;
  if (assetState) assetState.rsiMounted = true;
  svg.innerHTML = "";
  const validCloses = Array.isArray(closes) ? closes.filter((c) => Number.isFinite(c)) : [];
  if (validCloses.length < RSI_PERIOD + 1) {
    const msg = validCloses.length === 0
      ? "RSI · carregando dados da Binance…"
      : "RSI · aguardando " + (RSI_PERIOD + 1) + " candles (atual: " + validCloses.length + ")";
    svg.innerHTML = '<text x="400" y="50" text-anchor="middle" class="axis-label">' + msg + "</text>";
    return;
  }
  closes = validCloses;
  const W = 800, H = 100, padL = 56, padR = 12, padT = 8, padB = 16;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (i / Math.max(1, closes.length - 1)) * innerW;
  const y = (v) => padT + innerH - (v / 100) * innerH;

  let s = "";
  s += '<rect class="rsi-zone-over" x="' + padL + '" y="' + y(100) + '" width="' + innerW + '" height="' + (y(70) - y(100)) + '"/>';
  s += '<rect class="rsi-zone-under" x="' + padL + '" y="' + y(30) + '" width="' + innerW + '" height="' + (y(0) - y(30)) + '"/>';
  [30, 50, 70].forEach((v) => {
    const cls = v === 50 ? "rsi-grid-mid" : "rsi-grid-edge";
    s += '<line class="' + cls + '" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
    s += '<text class="axis-label" x="' + (padL - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + "</text>";
  });
  s += '<text class="rsi-label" x="' + padL + '" y="' + (padT + 10) + '">RSI(' + RSI_PERIOD + ")</text>";
  const arr = rsiSeries(closes, RSI_PERIOD);
  const pts = arr.map((v, i) => v === null ? null : x(i) + "," + y(v)).filter(Boolean).join(" ");
  if (pts) s += '<polyline class="rsi-line" points="' + pts + '"/>';
  svg.innerHTML = s;
}

// ===== chart preço (klines reais + markers do bot) =====
function renderChartLegacy(symbol) {
  const symU = normalizeSymbol(symbol || state.ativoSelecionado);
  if (!symU) return;
  const svg = getChartElements(symU).chart;
  if (!svg) return;
  const assetState = getAssetState(symU);
  const klinesEntry = state.cachedKlinesBySymbol[symU];
  const klines = klinesEntry && Array.isArray(klinesEntry.data) ? klinesEntry.data : [];
  const decisoes = state.cachedDecisionsBySymbol[symU] || [];

  const lastKline = klines.length ? klines[klines.length - 1] : null;
  const sig = symU + ":k" + klines.length + ":" +
    (lastKline ? [lastKline.closeTime, lastKline.open, lastKline.high, lastKline.low, lastKline.close, lastKline.volume].join(":") : "0") +
    ":d" + decisoes.length;
  if (assetState && assetState.chartMounted && sig === assetState.lastChartSignature) return;
  if (assetState) assetState.lastChartSignature = sig;
  if (assetState) assetState.chartMounted = true;

  svg.innerHTML = "";
  if (klines.length < 2) {
    svg.innerHTML = '<text x="400" y="120" text-anchor="middle" class="axis-label">sem dados de mercado (Binance indisponível)</text>';
    const rsi = getChartElements(symU).rsi;
    if (rsi) rsi.innerHTML = "";
    if (assetState) assetState.rsiMounted = true;
    return;
  }

  const W = 800, H = 280, padL = 56, padR = 12, padT = 22, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const volGap = 10;
  const volH = 30;
  const priceH = innerH - volGap - volH;

  // Filtra defensivamente — kline corrompida não envenena indicadores
  const closes = klines.map((k) => k.close).filter((c) => Number.isFinite(c));
  const highs = klines.map((k) => k.high).filter((h) => Number.isFinite(h));
  const lows = klines.map((k) => k.low).filter((l) => Number.isFinite(l));
  const volumes = klines.map((k) => k.volume).filter((v) => Number.isFinite(v));
  if (closes.length < MIN_KLINES_INDICATORS) {
    svg.innerHTML = '<text x="400" y="120" text-anchor="middle" class="axis-label">' + symU + ' · aguardando ' + MIN_KLINES_INDICATORS + ' candles válidos (atual: ' + closes.length + ')</text>';
    const rsiSvg = getChartElements(symU).rsi;
    if (rsiSvg) rsiSvg.innerHTML = "";
    if (assetState) assetState.rsiMounted = true;
    return;
  }
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const rawRange = rawMax - rawMin;
  const padPct = 0.06;
  const padAmount = rawRange > 0 ? rawRange * padPct : Math.max(1, Math.abs(rawMax) * 0.001);
  const minP = rawMin - padAmount;
  const maxP = rawMax + padAmount;
  const range = maxP - minP || 1;

  const tStart = klines[0].openTime;
  const tEnd = klines[klines.length - 1].closeTime;
  const tSpan = Math.max(1, tEnd - tStart);

  const xByIndex = (i) => padL + (i / Math.max(1, klines.length - 1)) * innerW;
  const xByTime = (t) => {
    const clamped = Math.max(tStart, Math.min(tEnd, t));
    return padL + ((clamped - tStart) / tSpan) * innerW;
  };
  const y = (p) => padT + priceH - ((p - minP) / range) * priceH;
  const volTop = padT + priceH + volGap;
  const maxVol = Math.max(...volumes, 1);

  let svgContent = "";

  // grid
  for (let g = 0; g <= 4; g++) {
    const yv = padT + (g / 4) * priceH;
    const v = maxP - (g / 4) * range;
    svgContent += '<line class="grid-line" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yv + '" y2="' + yv + '"/>';
    svgContent += '<text class="axis-label" x="' + (padL - 8) + '" y="' + (yv + 3) + '" text-anchor="end">' + fmtNum(v, 2) + "</text>";
  }
  svgContent += '<text class="axis-label chart-symbol-label" x="' + (W - padR) + '" y="' + padT + '" text-anchor="end">' + symU + " · Binance Spot · 1m</text>";
  svgContent +=
    '<text class="ohlc-label" x="' + padL + '" y="' + padT + '">' +
      "O " + fmtNum(lastKline.open, 2) +
      " H " + fmtNum(lastKline.high, 2) +
      " L " + fmtNum(lastKline.low, 2) +
      " C " + fmtNum(lastKline.close, 2) +
      " V " + fmtNum(lastKline.volume, 2) +
    "</text>";
  svgContent += '<line class="volume-axis" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + volTop + '" y2="' + volTop + '"/>';

  const step = innerW / Math.max(1, klines.length - 1);
  const candleW = Math.max(3, Math.min(9, step * 0.62));
  let candlesSvg = "";
  let volumesSvg = "";
  klines.forEach((k, i) => {
    const cx = xByIndex(i);
    const up = k.close >= k.open;
    const cls = up ? "up" : "down";
    const yOpen = y(k.open);
    const yClose = y(k.close);
    const yHigh = y(k.high);
    const yLow = y(k.low);
    const bodyY = Math.min(yOpen, yClose);
    const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
    const volBarH = Math.max(1, (k.volume / maxVol) * volH);
    const title =
      symU + " Binance 1m " + fmtTime(k.openTime) +
      " O " + fmtNum(k.open, 2) +
      " H " + fmtNum(k.high, 2) +
      " L " + fmtNum(k.low, 2) +
      " C " + fmtNum(k.close, 2) +
      " V " + fmtNum(k.volume, 2);
    volumesSvg +=
      '<rect class="volume-bar ' + cls + '" x="' + (cx - candleW / 2) + '" y="' + (volTop + volH - volBarH) + '" width="' + candleW + '" height="' + volBarH + '"><title>' + title + "</title></rect>";
    candlesSvg +=
      '<line class="candle-wick ' + cls + '" x1="' + cx + '" x2="' + cx + '" y1="' + yHigh + '" y2="' + yLow + '"><title>' + title + "</title></line>" +
      '<rect class="candle-body ' + cls + '" x="' + (cx - candleW / 2) + '" y="' + bodyY + '" width="' + candleW + '" height="' + bodyH + '"><title>' + title + "</title></rect>";
  });
  svgContent += volumesSvg + candlesSvg;

  // SMAs sobre os fechamentos reais da Binance
  const smaToPoints = (arr) => arr
    .map((v, i) => v === null ? null : xByIndex(i) + "," + y(v))
    .filter(Boolean)
    .join(" ");
  const sma9pts = smaToPoints(smaSeries(closes, SMA_FAST_PERIOD));
  const sma21pts = smaToPoints(smaSeries(closes, SMA_SLOW_PERIOD));
  if (sma9pts) svgContent += '<polyline class="sma9-line" points="' + sma9pts + '"/>';
  if (sma21pts) svgContent += '<polyline class="sma21-line" points="' + sma21pts + '"/>';

  // RSI sub-chart (sobre klines.close)
  renderRsiChart(symU, closes, sig, assetState);

  // markers de decisões do bot — alinhados por timestamp à janela das klines
  decisoes.forEach((d) => {
    if (d.decisao !== "compra" && d.decisao !== "venda") return;
    if (typeof d.precoEntrada !== "number" || !Number.isFinite(d.precoEntrada)) return;
    const t = new Date(d.timestamp).getTime();
    if (!Number.isFinite(t) || t < tStart || t > tEnd) return; // fora da janela visível
    const cx = xByTime(t);
    const cy = y(d.precoEntrada);
    const dirCls = "marker-" + d.decisao;
    const resKey =
      d.resultado === "lucro" || d.resultado === "prejuizo" || d.resultado === "neutro"
        ? d.resultado
        : "pendente";
    const label = d.decisao === "compra" ? "C" : "V";
    const tooltip = d.decisao.toUpperCase() + " @ " + fmtNum(d.precoEntrada, 2) + " — " + fmtTs(d.timestamp) + " — " + resKey;
    svgContent +=
      '<g class="trade-marker ' + dirCls + " r-" + resKey + '" transform="translate(' + cx + " " + cy + ')">' +
        '<title>' + tooltip + "</title>" +
        '<circle class="trade-marker-glow" r="11"></circle>' +
        '<circle class="trade-marker-ring" r="7"></circle>' +
        '<text class="trade-marker-label" x="0" y="3" text-anchor="middle">' + label + "</text>" +
      "</g>";
  });

  // x-axis labels
  svgContent += '<text class="axis-label" x="' + padL + '" y="' + (H - 8) + '">' + fmtTime(tStart) + "</text>";
  svgContent += '<text class="axis-label" x="' + ((padL + (W - padR)) / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + fmtTime((tStart + tEnd) / 2) + "</text>";
  svgContent += '<text class="axis-label" x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end">' + fmtTime(tEnd) + "</text>";

  svg.innerHTML = svgContent;
}

// ===== painéis =====
function getAssetColors(symbol) {
  const symU = normalizeSymbol(symbol);
  if (symU.startsWith("BTC")) return { primary: "#f2a900", secondary: "#58a6ff" };
  if (symU.startsWith("ETH")) return { primary: "#8b5cf6", secondary: "#22d3ee" };
  return { primary: "#58a6ff", secondary: "#a371f7" };
}

function toChartTime(ms) {
  return Math.floor(Number(ms) / 1000);
}

function formatChartTime(time) {
  const seconds = typeof time === "number" ? time : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return new Date(seconds * 1000).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toCandleData(klines) {
  return klines
    .filter((k) =>
      Number.isFinite(k.openTime) &&
      Number.isFinite(k.open) &&
      Number.isFinite(k.high) &&
      Number.isFinite(k.low) &&
      Number.isFinite(k.close)
    )
    .map((k) => ({
      time: toChartTime(k.openTime),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close
    }));
}

function toVolumeData(klines) {
  return klines
    .filter((k) => Number.isFinite(k.openTime) && Number.isFinite(k.volume))
    .map((k) => ({
      time: toChartTime(k.openTime),
      value: k.volume,
      color: k.close >= k.open ? "rgba(63, 185, 80, 0.28)" : "rgba(248, 81, 73, 0.28)"
    }));
}

function toTradeMarkers(decisoes, candleStart, candleEnd) {
  return decisoes
    .filter((d) =>
      (d.decisao === "compra" || d.decisao === "venda") &&
      typeof d.precoEntrada === "number" &&
      Number.isFinite(d.precoEntrada)
    )
    .map((d) => {
      const t = new Date(d.timestamp).getTime();
      if (!Number.isFinite(t) || t < candleStart || t > candleEnd) return null;
      const isBuy = d.decisao === "compra";
      return {
        time: toChartTime(Math.floor(t / 60_000) * 60_000),
        position: isBuy ? "belowBar" : "aboveBar",
        color: isBuy ? "#3fb950" : "#f85149",
        shape: "circle",
        text: isBuy ? "C" : "V",
        size: 1
      };
    })
    .filter(Boolean);
}

function createTradingViewChart(symbol, container, hoverEl) {
  if (!window.LightweightCharts) {
    console.error("[chart] LightweightCharts.createChart abortado: window.LightweightCharts indefinido");
    return null;
  }
  if (!container) {
    console.error("[chart] container nulo ao criar chart de", symbol);
    return null;
  }
  // Limpa qualquer conteúdo antigo (ex: div .chart-empty "carregando…") antes do canvas
  container.innerHTML = "";
  dbg("createChart", symbol, "containerSize=" + container.clientWidth + "x" + container.clientHeight);
  const colors = getAssetColors(symbol);
  const chart = LightweightCharts.createChart(container, {
    autoSize: true,
    width: Math.max(320, container.clientWidth),
    height: 410,
    layout: {
      background: { color: "transparent" },
      textColor: "#8b949e",
      fontFamily: "Inter, Segoe UI, system-ui, sans-serif"
    },
    grid: {
      vertLines: { color: "rgba(139, 148, 158, 0.08)" },
      horzLines: { color: "rgba(139, 148, 158, 0.12)" }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "rgba(230, 237, 243, 0.32)", width: 1, style: 3, labelBackgroundColor: colors.primary },
      horzLine: { color: "rgba(230, 237, 243, 0.32)", width: 1, style: 3, labelBackgroundColor: colors.primary }
    },
    rightPriceScale: {
      borderColor: "rgba(139, 148, 158, 0.22)",
      scaleMargins: { top: 0.08, bottom: 0.24 }
    },
    timeScale: {
      borderColor: "rgba(139, 148, 158, 0.22)",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 7
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    },
    localization: {
      priceFormatter: (price) => fmtNum(price, 2)
    }
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: "#3fb950",
    downColor: "#f85149",
    borderUpColor: "#3fb950",
    borderDownColor: "#f85149",
    wickUpColor: "#3fb950",
    wickDownColor: "#f85149",
    priceLineColor: colors.primary,
    lastValueVisible: true,
    priceLineVisible: true
  });

  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    lastValueVisible: false,
    priceLineVisible: false
  });
  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.78, bottom: 0 }
  });

  chart.subscribeCrosshairMove((param) => {
    if (!hoverEl) return;
    if (!param || !param.time || !param.seriesData) {
      hoverEl.textContent = "mova o mouse sobre o gráfico";
      return;
    }
    const candle = param.seriesData.get(candleSeries);
    if (!candle) return;
    hoverEl.textContent =
      formatChartTime(param.time) +
      "  O " + fmtNum(candle.open, 2) +
      "  H " + fmtNum(candle.high, 2) +
      "  L " + fmtNum(candle.low, 2) +
      "  C " + fmtNum(candle.close, 2);
  });

  return { chart, candleSeries, volumeSeries };
}

function ensureTradingViewInstance(symbol, container, hoverEl, assetState) {
  if (!assetState.chart || !assetState.candleSeries || !assetState.volumeSeries) {
    dbg("instance criar nova", symbol);
    const instance = createTradingViewChart(symbol, container, hoverEl);
    if (!instance) return null;
    assetState.chart = instance.chart;
    assetState.candleSeries = instance.candleSeries;
    assetState.volumeSeries = instance.volumeSeries;
  }
  return assetState;
}

function renderChart(symbol) {
  const symU = normalizeSymbol(symbol || state.ativoSelecionado);
  if (!symU) return;
  const els = getChartElements(symU);
  if (!els.chart) {
    dbg("renderChart abort: container não encontrado", symU);
    return;
  }
  const assetState = getAssetState(symU);
  // Não renderiza panel inativo se ainda não tem chart criado (evita trabalho em hidden)
  if (els.panel && !els.panel.classList.contains("active") && !assetState.chart) {
    dbg("renderChart skip: panel inativo sem chart", symU);
    return;
  }
  const klinesEntry = state.cachedKlinesBySymbol[symU];
  const klines = klinesEntry && Array.isArray(klinesEntry.data) ? klinesEntry.data : [];
  const decisoes = state.cachedDecisionsBySymbol[symU] || [];
  const isLoading = Boolean(state.chartLoadingBySymbol && state.chartLoadingBySymbol[symU]);

  if (!window.LightweightCharts) {
    console.error("[renderChart] LightweightCharts não carregou — verifique <script> CDN");
    destroyTradingViewChart(symU);
    els.chart.innerHTML = '<div class="chart-empty">TradingView Lightweight Charts indisponível — confira o script CDN</div>';
    return;
  }
  if (klines.length < 2) {
    dbg("renderChart aguarda klines", symU, "loading=" + isLoading);
    destroyTradingViewChart(symU);
    els.chart.innerHTML = '<div class="chart-empty">' + (isLoading ? "carregando " + symU + "..." : "sem dados de mercado da Binance") + "</div>";
    return;
  }

  const candles = toCandleData(klines);
  if (candles.length < MIN_KLINES_INDICATORS) {
    dbg("renderChart candles insuficientes", symU, "n=" + candles.length);
    destroyTradingViewChart(symU);
    els.chart.innerHTML = '<div class="chart-empty">' + symU + (isLoading ? " · carregando candles..." : " · aguardando candles válidos (atual: " + candles.length + ")") + "</div>";
    return;
  }

  const lastCandle = candles[candles.length - 1];
  const sig = symU + ":k" + candles.length + ":" +
    [lastCandle.time, lastCandle.open, lastCandle.high, lastCandle.low, lastCandle.close].join(":") +
    ":d" + decisoes.length;
  if (assetState && assetState.chartMounted && sig === assetState.lastChartSignature) {
    dbg("renderChart skip: signature inalterada", symU);
    return;
  }

  const instance = ensureTradingViewInstance(symU, els.chart, els.hover, assetState);
  if (!instance) {
    console.error("[renderChart] falhou ao criar instance Lightweight Charts", symU);
    els.chart.innerHTML = '<div class="chart-empty">' + symU + " · falha ao inicializar gráfico (veja console)</div>";
    return;
  }
  try {
    instance.candleSeries.setData(candles);
    instance.volumeSeries.setData(toVolumeData(klines));
    instance.candleSeries.setMarkers(toTradeMarkers(decisoes, candles[0].time * 1000, lastCandle.time * 1000));
    if (!assetState.chartMounted) instance.chart.timeScale().fitContent();
    assetState.lastChartSignature = sig;
    assetState.chartMounted = true;
    dbg("renderChart OK", symU, "candles=" + candles.length, "markers=" + decisoes.length);
  } catch (err) {
    console.error("[renderChart] setData falhou", symU, err);
    destroyTradingViewChart(symU);
    els.chart.innerHTML = '<div class="chart-empty">' + symU + " · erro ao desenhar candles: " + err.message + "</div>";
  }
}

function renderHero(lastDecisao, klines) {
  const dec = (lastDecisao && lastDecisao.decisao) || "esperar";
  const heroEl = document.getElementById("hero");
  heroEl.className = "hero " + dec;

  const ativo = state.ativoSelecionado || (lastDecisao && lastDecisao.ativo) || "—";
  document.getElementById("heroAtivo").textContent = ativo;

  // preço atual: prefere klines reais (mais fresco que decisões)
  const lastKline = klines && klines.length ? klines[klines.length - 1] : null;
  const firstKline = klines && klines.length ? klines[0] : null;
  const priceNow = lastKline ? lastKline.close : (lastDecisao ? lastDecisao.precoEntrada : null);
  const priceFirst = firstKline ? firstKline.close : null;

  const priceEl = document.getElementById("heroPrice");
  if (Number.isFinite(priceNow)) {
    priceEl.textContent = "$ " + fmtNum(priceNow, 2);
    priceEl.classList.remove("dim");
  } else {
    priceEl.textContent = "—";
    priceEl.classList.add("dim");
  }

  const deltaEl = document.getElementById("heroPriceDelta");
  const delta = priceNow !== null && priceFirst !== null ? fmtPriceDelta(priceNow, priceFirst) : null;
  if (delta) {
    deltaEl.textContent = delta.sign + fmtNum(delta.pct, 2) + "% (1h)";
    deltaEl.className = "price-delta " + clsSign(delta.pct);
  } else {
    deltaEl.textContent = "";
    deltaEl.className = "price-delta";
  }

  const updatedEl = document.getElementById("heroUpdated");
  if (lastDecisao && lastDecisao.timestamp) {
    updatedEl.textContent = "última decisão: " + ago(lastDecisao.timestamp);
  } else {
    updatedEl.textContent = "aguardando decisão…";
  }

  const badge = document.getElementById("heroBadge");
  badge.textContent = dec.toUpperCase();
  badge.className = "badge-big b-" + dec;

  const score = lastDecisao && typeof lastDecisao.confianca === "number" ? lastDecisao.confianca : 0;
  const heroConfEl = document.getElementById("heroConf");
  heroConfEl.textContent = fmtNum(score, 1);
  heroConfEl.className = score >= 65 ? "pos" : score < 40 ? "neg" : "mid";
  document.getElementById("heroScoreMarker").style.left = Math.max(0, Math.min(100, score)) + "%";

  const rsiVal = lastDecisao && typeof lastDecisao.rsi === "number" ? lastDecisao.rsi : null;
  const rsiInfo = rsiClassify(rsiVal);
  document.getElementById("heroRsiVal").textContent = rsiVal === null ? "—" : fmtNum(rsiVal, 1);
  const tag = document.getElementById("heroRsiTag");
  tag.textContent = rsiInfo.tag;
  tag.className = "rsi-tag " + rsiInfo.cls;
  document.getElementById("heroRsiMarker").style.left = (rsiVal === null ? 50 : Math.max(0, Math.min(100, rsiVal))) + "%";
}

function renderIndicators(last) {
  if (!last) return;
  const tend = last.tendencia || (last.analise && last.analise.tendencia) || "—";
  const intens = typeof last.intensidade === "number" ? last.intensidade : 0;
  const tendEl = document.getElementById("indTend");
  tendEl.className = "indicator " + (tend === "alta" ? "up" : tend === "baixa" ? "down" : "warn");
  document.getElementById("indTendVal").textContent = tend;
  document.getElementById("indTendSub").textContent = "intensidade " + fmtNum(intens, 2) + "%";

  const rsiVal = typeof last.rsi === "number" ? last.rsi : 50;
  const rsiInfo = rsiClassify(rsiVal);
  const rsiEl = document.getElementById("indRsi");
  rsiEl.className = "indicator " + (rsiVal < 30 ? "up" : rsiVal > 70 ? "down" : "warn");
  document.getElementById("indRsiVal").textContent = fmtNum(rsiVal, 1);
  document.getElementById("indRsiSub").textContent = rsiInfo.tag;
  document.getElementById("indRsiBar").style.width = Math.max(0, Math.min(100, rsiVal)) + "%";

  const mom = typeof last.momentum === "number" ? last.momentum : 0;
  const momEl = document.getElementById("indMom");
  momEl.className = "indicator " + (mom > 0.05 ? "up" : mom < -0.05 ? "down" : "warn");
  document.getElementById("indMomVal").textContent = (mom > 0 ? "+" : "") + fmtNum(mom, 3) + "%/c";
  document.getElementById("indMomSub").textContent = mom > 0.05 ? "positivo" : mom < -0.05 ? "negativo" : "estável";

  const score = typeof last.confianca === "number" ? last.confianca : 0;
  const scoreEl = document.getElementById("indScore");
  scoreEl.className = "indicator " + (score >= 65 ? "up" : score < 40 ? "down" : "warn");
  const scoreBar = document.getElementById("indScoreBar");
  scoreBar.parentElement.className = "indicator-bar " + (score >= 65 ? "ibar-green" : score < 40 ? "ibar-red" : "ibar-yellow");
  document.getElementById("indScoreVal").textContent = fmtNum(score, 1);
  document.getElementById("indScoreSub").textContent = score >= 65 ? "libera trade" : score < 40 ? "bloqueio" : "cautela";
  scoreBar.style.width = Math.max(0, Math.min(100, score)) + "%";
}

function renderReason(last) {
  if (!last) {
    document.getElementById("reasonText").textContent = "aguardando primeiro ciclo…";
    document.getElementById("reasonText").className = "why";
    document.getElementById("reasonFonte").textContent = "—";
    return;
  }
  const just = (last.analise && last.analise.justificativa) || "(sem justificativa)";
  const isFallback = last.analise && typeof last.analise.justificativa === "string" && last.analise.justificativa.toLowerCase().includes("fallback");
  const fonte = isFallback ? "fallback heurístico" : "IA Anthropic";
  const why = document.getElementById("reasonText");
  why.textContent = just;
  why.className = "why " + (last.decisao === "compra" ? "ok" : last.decisao === "venda" ? "bad" : "");
  document.getElementById("reasonFonte").textContent = fonte;
  renderIndicators(last);
}

function renderMetrics(perf) {
  if (!perf || typeof perf !== "object") perf = {};
  const metrics = perf._source === DASHBOARD_METRICS_SOURCE
    ? perf
    : normalizeRepairDashboardMetrics(state.cachedRepairBacktest);
  logDashboardMetricsSource();
  const winRate = Number(metrics.winRate) || 0;
  const lucro = Number(metrics.lucro) || 0;
  const prejuizo = Number(metrics.prejuizo) || 0;
  const saldoFinal = Number(metrics.saldoFinal);
  const retornoTotalPct = clampRetornoPct(metrics.retornoPct ?? metrics.retornoTotalPct, "renderMetrics");
  const drawdownMaxPct = Number(metrics.drawdownMaxPct) || 0;

  document.getElementById("mTotal").textContent = metrics.totalTrades ?? 0;
  document.getElementById("mWr").textContent = fmtNum(winRate, 2) + "%";
  document.getElementById("barWr").style.width = Math.min(100, Math.max(0, winRate)) + "%";

  document.getElementById("mLucro").textContent = "+" + fmtNum(lucro, 2) + "%";
  document.getElementById("mPrejuizo").textContent = "-" + fmtNum(prejuizo, 2) + "%";
  const total = lucro + prejuizo;
  const lFlex = total > 0 ? (lucro / total) : 0;
  const pFlex = total > 0 ? (prejuizo / total) : 0;
  document.getElementById("barLucro").style.flex = lFlex;
  document.getElementById("barPrejuizo").style.flex = pFlex;

  const saldoEl = document.getElementById("mSaldo");
  saldoEl.textContent = Number.isFinite(saldoFinal)
    ? "$" + fmtNum(saldoFinal, 2)
    : (retornoTotalPct > 0 ? "+" : "") + fmtNum(retornoTotalPct, 2) + "%";
  saldoEl.className = "metric-value " + clsSign(retornoTotalPct);

  const saldoMetaEl = document.getElementById("mSaldoMeta");
  if (saldoMetaEl) {
    const sinal = retornoTotalPct > 0 ? "+" : "";
    saldoMetaEl.textContent = "retorno " + sinal + fmtNum(retornoTotalPct, 2) + "% | DD max " + fmtNum(drawdownMaxPct, 2) + "% | PF " + fmtNum(metrics.profitFactor, 2) + " | EXP " + fmtNum(metrics.expectancy, 2);
  }

  const metaEl = document.getElementById("mTotalMeta");
  if (metaEl) metaEl.textContent = "decisoes avaliadas (" + DASHBOARD_METRICS_SOURCE + ")";
}

function buildMetricsForSelectedAtivo() {
  return normalizeRepairDashboardMetrics(state.cachedRepairBacktest);
}

function renderStrategySetups() {
  const wrap = document.getElementById("setupEdgeList");
  const meta = document.getElementById("setupEdgeMeta");
  if (!wrap || !meta) return;
  const data = state.cachedStrategyPerformance || {};
  const ranking = Array.isArray(data.ranking) ? data.ranking : [];
  const top = ranking
    .filter((item) => item && item.trusted && !item.blocked)
    .slice(0, 4);

  meta.textContent = data.minTrades ? "min " + data.minTrades + " trades" : "edge historico";
  if (!top.length) {
    wrap.innerHTML = '<div class="metric-meta">sem dados suficientes</div>';
    return;
  }

  wrap.innerHTML = top.map((item) => {
    const edge = Number(item.edgeScore) || 0;
    const cls = edge >= 70 ? "pos" : edge < 45 ? "neg" : "mid";
    return (
      '<div class="setup-edge-item">' +
        '<div class="setup-edge-name">' + (item.setup || "setup") + ' · ' + (item.ativo || "—") + '</div>' +
        '<div class="setup-edge-stats">' +
          '<span>PF ' + fmtNum(item.profitFactor, 2) + '</span>' +
          '<span>EXP ' + fmtNum(item.expectancy, 2) + '</span>' +
          '<span>WR ' + fmtNum(item.winRate, 1) + '%</span>' +
          '<span class="' + cls + '">EDGE ' + fmtNum(edge, 0) + '</span>' +
        '</div>' +
      '</div>'
    );
  }).join("");
}

function renderMarketRegime() {
  const nameEl = document.getElementById("marketRegimeName");
  const confEl = document.getElementById("marketRegimeConfidence");
  const metaEl = document.getElementById("marketRegimeMeta");
  const setupsEl = document.getElementById("marketRegimeSetups");
  if (!nameEl || !confEl || !metaEl || !setupsEl) return;
  const data = state.cachedMarketRegime || {};
  const regime = data.regime || "NEUTRAL";
  const confidence = Number(data.confidence) || 0;
  const favored = Array.isArray(data.setupsFavorecidos) ? data.setupsFavorecidos : [];
  const penalized = Array.isArray(data.setupsPenalizados) ? data.setupsPenalizados : [];

  nameEl.textContent = regime;
  nameEl.className = "setup-edge-name " + (confidence >= 70 ? "pos" : confidence < 60 ? "mid" : "");
  confEl.textContent = "confiança " + fmtNum(confidence, 0) + "%";
  metaEl.textContent = (data.ativo || "BTCUSDT") + " · " + (data.timeframe || "1m");
  if (confidence < 60 || regime === "NEUTRAL") {
    setupsEl.innerHTML = "<span>fallback neutro</span>";
    return;
  }
  setupsEl.innerHTML =
    "<span>fav " + (favored.length ? favored.join(", ") : "—") + "</span>" +
    "<span>bloq " + (penalized.length ? penalized.join(", ") : "—") + "</span>";
}

function renderMarketQuality() {
  const scoreEl = document.getElementById("marketQualityScore");
  const labelEl = document.getElementById("marketQualityLabel");
  const metaEl = document.getElementById("marketQualityMeta");
  const reasonEl = document.getElementById("marketQualityReason");
  if (!scoreEl || !labelEl || !metaEl || !reasonEl) return;
  const data = state.cachedMarketQuality || {};
  const score = Number(data.score);
  const safeScoreVal = Number.isFinite(score) ? score : 50;
  const label = data.label || "NEUTRA";
  const operavel = data.operavel !== false;
  const premiumOnly = data.premiumOnly === true;
  scoreEl.textContent = fmtNum(safeScoreVal, 0);
  scoreEl.className = "setup-edge-name " + (safeScoreVal >= 60 ? "pos" : safeScoreVal < 40 ? "neg" : "mid");
  labelEl.textContent = label;
  metaEl.textContent = operavel ? (premiumOnly ? "somente premium" : "operável") : "bloqueado";
  reasonEl.innerHTML =
    "<span>" + (data.motivoPrincipal || "fallback neutro") + "</span>" +
    "<span>" + (operavel ? "operável" : "não operar") + "</span>";
}

function renderExecutionPanel() {
  const live = state.cachedExecutionLive || {};
  const position = live.livePosition || null;
  const timeline = state.cachedTradeTimeline || {};
  const analytics = state.cachedExecutionAnalytics || {};
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const pnlClass = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.className = "exec-value " + clsSign(Number(value) || 0);
  };

  if (!position) {
    setText("execStatus", "sem posição aberta");
    setText("execSide", "—");
    setText("execEntry", "—");
    setText("execSize", "—");
    setText("execPnl", "—");
    setText("execRR", "—");
    setText("execStop", "—");
    setText("execTarget", "—");
    setText("execTrailing", "—");
    setText("execOpenTime", "—");
  } else {
    const openedAt = position.openedAt || position.opened_at;
    const ageMs = openedAt ? Date.now() - new Date(openedAt).getTime() : NaN;
    const age = Number.isFinite(ageMs) && ageMs >= 0
      ? (ageMs < 3_600_000 ? Math.round(ageMs / 60_000) + "min" : Math.round(ageMs / 3_600_000) + "h")
      : "—";
    const pnl = Number(position.floatingPnl ?? position.floating_pnl) || 0;
    setText("execStatus", (position.ativo || "—") + " · " + (position.status || "OPEN"));
    setText("execSide", position.side || "—");
    setText("execEntry", "$" + fmtNum(position.entryPrice ?? position.entry_price, 2));
    setText("execSize", fmtNum(position.remainingQuantity ?? position.remaining_quantity ?? position.quantity, 6));
    setText("execPnl", (pnl > 0 ? "+" : "") + "$" + fmtNum(pnl, 2));
    pnlClass("execPnl", pnl);
    setText("execRR", fmtNum(position.rrCurrent ?? position.rr_current, 2) + "R");
    setText("execStop", position.stopPrice ?? position.stop_price ? "$" + fmtNum(position.stopPrice ?? position.stop_price, 2) : "—");
    setText("execTarget", position.targetPrice ?? position.target_price ? "$" + fmtNum(position.targetPrice ?? position.target_price, 2) : "—");
    setText("execTrailing", position.trailingStop ?? position.trailing_stop ? "$" + fmtNum(position.trailingStop ?? position.trailing_stop, 2) : "—");
    setText("execOpenTime", age);
  }

  setText("execAvgSlip", fmtNum(analytics.avgSlippage, 3) + "%");
  setText("execAvgDelay", fmtNum(analytics.avgExecutionDelay, 0) + "ms");
  setText("execMaeMfe", "MAE " + fmtNum(analytics.mae, 2) + " / MFE " + fmtNum(analytics.mfe, 2));

  const list = document.getElementById("execTimeline");
  if (!list) return;
  const events = Array.isArray(timeline.events) ? timeline.events.slice(-8) : [];
  if (!events.length) {
    list.innerHTML = '<div class="metric-meta">sem eventos de execução</div>';
    return;
  }
  list.innerHTML = events.map((ev) => {
    const rawType = ev.event_type || ev.eventType || "EVENT";
    const type = rawType === "BREAKEVEN" ? "STOP MOVE" : rawType === "PARTIAL TP" ? "PARTIAL" : rawType;
    const price = ev.price !== null && ev.price !== undefined ? "$" + fmtNum(ev.price, 2) : "—";
    return (
      '<div class="exec-timeline-item">' +
        '<span class="exec-dot"></span>' +
        '<div><strong>' + type + '</strong><span>' + price + ' · ' + fmtTime(ev.created_at || ev.createdAt) + '</span></div>' +
      '</div>'
    );
  }).join("");
}

function renderExchangeConditions() {
  const data = state.cachedExchangeConditions || {};
  const current = data.current || {};
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("exSpread", fmtNum(data.spreadAtualPct ?? current.spreadPct, 4) + "%");
  setText("exAvgSlip", fmtNum(data.slippageMedioPct ?? current.actualSlippagePct, 4) + "%");
  setText("exLatency", fmtNum(data.latencyMs ?? current.latencyMs, 0) + "ms");
  setText("exLiquidity", fmtNum(data.liquidity ?? current.liquidityScore, 0));
  setText("exQuality", fmtNum(data.executionQuality ?? current.executionQuality, 0));
  setText("exStress", data.marketStress || current.stressLabel || "-");
  setText("exMode", current.mode || "-");
  setText("exImpact", fmtNum(data.marketImpactPct ?? current.marketImpactPct, 4) + "%");
  setText("exFillDeviation", fmtNum(data.fillDeviationPct ?? current.fillDeviationPct, 4) + "%");
  setText("exOpportunityCost", "$" + fmtNum(data.opportunityCost ?? current.opportunityCost, 2));
}

function renderLivePortfolio() {
  const live = state.cachedExecutionLive || {};
  const p = live.portfolio || {};
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const signedMoney = (value) => {
    const n = Number(value) || 0;
    return (n > 0 ? "+" : "") + "$" + fmtNum(n, 2);
  };
  setText("pfSaldoAtual", "$" + fmtNum(p.saldoAtual, 2));
  setText("pfSaldoInicial", "$" + fmtNum(p.saldoInicial, 2));
  setText("pfCapitalLivre", "$" + fmtNum(p.capitalLivre, 2));
  setText("pfPnlRealizado", signedMoney(p.pnlRealizado));
  setText("pfPnlFlutuante", signedMoney(p.pnlFlutuante));
  setText("pfCapitalUso", "$" + fmtNum(p.capitalAlocado ?? p.capitalEmUso, 2));
  setText("pfTradesAbertos", String(p.tradesAbertos ?? 0));
  setText("pfDrawdown", fmtNum(p.drawdownAtual, 2) + "%");
  setText("pfExposure", fmtNum(p.exposureTotalPct ?? p.exposureAtualPct, 2) + "%");
  setText("pfRiscoAtual", "$" + fmtNum(p.riscoAgregado ?? p.riscoAtual, 2));
  setText("pfRetornoDiario", signedMoney(p.retornoDiario));
  setText("pfRetornoSemanal", signedMoney(p.retornoSemanal));
}

function renderOpenPositionsTable() {
  const body = document.getElementById("openPositionsBody");
  if (!body) return;
  const live = state.cachedExecutionLive || {};
  const positions = Array.isArray(live.openPositions) ? live.openPositions : [];
  if (!positions.length) {
    body.innerHTML = '<tr><td colspan="11">sem posições abertas</td></tr>';
    return;
  }
  body.innerHTML = positions.map((p) => {
    const side = p.side || "—";
    const entry = Number(p.entryPrice ?? p.entry_price);
    const current = Number(p.currentPrice ?? p.current_price);
    const qty = Number(p.remainingQuantity ?? p.remaining_quantity ?? p.quantity) || 0;
    const pnl = Number(p.floatingPnl ?? p.floating_pnl) || 0;
    const pnlPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(current)
      ? (side === "SHORT" ? ((entry - current) / entry) * 100 : ((current - entry) / entry) * 100)
      : 0;
    const openedAt = p.openedAt || p.opened_at;
    const ageMs = openedAt ? Date.now() - new Date(openedAt).getTime() : NaN;
    const age = Number.isFinite(ageMs) && ageMs >= 0
      ? (ageMs < 3_600_000 ? Math.round(ageMs / 60_000) + "min" : Math.round(ageMs / 3_600_000) + "h")
      : "—";
    return (
      "<tr>" +
        "<td>" + (p.ativo || "—") + "</td>" +
        "<td>" + side + "</td>" +
        "<td>$" + fmtNum(entry, 2) + "</td>" +
        "<td>$" + fmtNum(current, 2) + "</td>" +
        '<td class="' + clsSign(pnlPct) + '">' + (pnlPct > 0 ? "+" : "") + fmtNum(pnlPct, 2) + "%</td>" +
        '<td class="' + clsSign(pnl) + '">' + (pnl > 0 ? "+" : "") + "$" + fmtNum(pnl, 2) + "</td>" +
        "<td>" + fmtNum(qty, 6) + "</td>" +
        "<td>" + (p.stopPrice ?? p.stop_price ? "$" + fmtNum(p.stopPrice ?? p.stop_price, 2) : "—") + "</td>" +
        "<td>" + (p.targetPrice ?? p.target_price ? "$" + fmtNum(p.targetPrice ?? p.target_price, 2) : "—") + "</td>" +
        "<td>" + age + "</td>" +
        "<td>" + (p.status || "—") + "</td>" +
      "</tr>"
    );
  }).join("");
}

function renderSystemHealthPanel() {
  const brain = state.cachedMetaBrain || {};
  const exec = state.cachedExecutionHealth || {};
  const risk = brain.adaptiveRisk || {};
  const stress = brain.marketStress || {};
  const rotation = Array.isArray(brain.strategyRotation) ? brain.strategyRotation : [];
  const dominant = brain.dominantSetup || (rotation[0] && rotation[0].setup) || "—";
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("sysRiskMode", brain.riskMode || risk.riskMode || "—");
  setText("sysDominantSetup", dominant);
  setText("sysStress", (stress.level || "—") + (Number.isFinite(Number(stress.score)) ? " " + fmtNum(stress.score, 0) : ""));
  setText("sysGlobalConfidence", Number.isFinite(Number(brain.globalConfidence)) ? fmtNum(brain.globalConfidence, 0) + "%" : "—");
  setText("sysAdaptiveRisk", Number.isFinite(Number(risk.riskPerTradePct)) ? fmtNum(risk.riskPerTradePct, 3) + "%" : "—");
  setText("sysMlHealth", Number.isFinite(Number(brain.mlHealth)) ? fmtNum(brain.mlHealth, 0) + "%" : "—");
  setText("sysCurrentEdge", Number.isFinite(Number(brain.currentEdge)) ? fmtNum(brain.currentEdge, 0) : "—");
  setText("sysExecutionStatus", exec.engineStatus || exec.status || "—");
  setText("sysOpenPositions", String(exec.openPositions ?? 0));
  setText("sysTradesToday", String(exec.recentOrders ?? 0));
  setText("sysLatency", Number.isFinite(Number(exec.avgLatencyMs)) ? fmtNum(exec.avgLatencyMs, 0) + "ms" : "—");
  setText("sysRegimeStatus", stress.level ? "online" : "—");
  const explainer = document.getElementById("sysExplainer");
  if (explainer) {
    const lines = Array.isArray(brain.explainer) ? brain.explainer : [];
    explainer.textContent = lines[0] || "aguardando leitura adaptativa";
  }
}

function renderHistory(decisions) {
  // Sempre filtra estritamente pelo ativo selecionado pra evitar mistura de dados
  const symU = normalizeSymbol(state.ativoSelecionado);
  const filtered = symU
    ? (decisions || []).filter((d) => d && typeof d.ativo === "string" && d.ativo.toUpperCase() === symU)
    : [];
  const hist = filtered.slice(-30).reverse();
  document.getElementById("hist").innerHTML = hist
    .map((r) => {
      const cls = r.decisao === "compra" ? "highlight-compra" : r.decisao === "venda" ? "highlight-venda" : "";
      return (
        '<tr class="' + cls + '">' +
        "<td>" + fmtTs(r.timestamp) + "</td>" +
        "<td>" + (r.ativo || "—") + "</td>" +
        "<td>" + pill(r.decisao || "esperar") + "</td>" +
        "<td>" + (r.tendencia || (r.analise && r.analise.tendencia) || "—") + "</td>" +
        "<td>" + (r.confianca ?? "—") + "</td>" +
        "<td>" + fmtNum(r.precoEntrada, 2) + "</td>" +
        "<td>" + pill(r.resultado || "neutro") + "</td>" +
        "</tr>"
      );
    })
    .join("");
}

function renderAll() {
  // Lista canônica vem de /symbols (state.symbols). Cache keys são fallback se ainda vazio.
  const fonteAtivos = state.symbols.length
    ? state.symbols
    : (Object.keys(state.cachedKlinesBySymbol).length
        ? Object.keys(state.cachedKlinesBySymbol)
        : Object.keys(state.cachedDecisionsBySymbol));
  const ativosNormalizados = fonteAtivos.map(normalizeSymbol).filter(Boolean);
  if (ativosNormalizados.length === 0) return;
  state.ativoSelecionado = normalizeSymbol(state.ativoSelecionado);
  if (!ativosNormalizados.includes(state.ativoSelecionado)) state.ativoSelecionado = ativosNormalizados[0];
  ensureChartPanels(ativosNormalizados);
  renderTabs(ativosNormalizados);
  setActiveChartPanel(state.ativoSelecionado);

  const symU = normalizeSymbol(state.ativoSelecionado);
  // ESTRITAMENTE do cache do ativo selecionado — zero leakage
  const decisoesAtivo = state.cachedDecisionsBySymbol[symU] || [];
  const klinesAtivo = (state.cachedKlinesBySymbol[symU] && state.cachedKlinesBySymbol[symU].data) || [];
  const lastDecisao = decisoesAtivo.length ? decisoesAtivo[decisoesAtivo.length - 1] : null;

  renderHero(lastDecisao, klinesAtivo);
  renderReason(lastDecisao);
  renderMetrics(buildMetricsForSelectedAtivo());
  renderMarketRegime();
  renderStrategySetups();
  renderExecutionPanel();
  renderExchangeConditions();
  renderLivePortfolio();
  renderOpenPositionsTable();
  renderSystemHealthPanel();
  for (const ativo of ativosNormalizados) renderChart(ativo);
  renderHistory(decisoesAtivo); // já filtrado por ativo, mas renderHistory também aplica filtro defensivo

  // Total ciclos = soma das decisões em cache por ativo (não array global agregado)
  let totalCiclos = 0;
  for (const a of ativosNormalizados) totalCiclos += (state.cachedDecisionsBySymbol[a] || []).length;

  document.getElementById("lastUpdate").textContent = new Date().toLocaleTimeString("pt-BR");
  document.getElementById("ativos").textContent = ativosNormalizados.join(", ");
  document.getElementById("totalCiclos").textContent = totalCiclos;
  updateBotStatus(lastDecisao && lastDecisao.timestamp);
  updateHealthIndicators();
  renderDatasetCard();
  renderMlCard();
}

// ===== refresh loop =====
async function refresh(force) {
  if (state.refreshInFlight && !force) return;
  state.refreshInFlight = true;
  const repairGeneration = state.repairGeneration;
  let ativos = [];
  try {
    // Health primeiro — se backend caiu, sabemos imediatamente
    await fetchHealth();
    fetchMlStatus();
    fetchMlPredictionForCurrent();
    // Dataset stats — leve, lê SQL apenas (não bloqueia UI)
    fetchDatasetStats();
    const [repairMetrics, strategyPerformance, marketRegime, rawAtivos] = await Promise.all([
      fetchRepairBacktest().catch((err) => {
        console.error("[repair]", err);
        state.cachedRepairBacktest = null;
        return null;
      }),
      fetchStrategyPerformance().catch((err) => {
        console.error("[strategy-performance]", err);
        state.cachedStrategyPerformance = null;
        return null;
      }),
      fetchMarketRegime().catch((err) => {
        console.error("[market-regime]", err);
        state.cachedMarketRegime = null;
        return null;
      }),
      fetchSymbolList()
    ]);
    ativos = rawAtivos.map(normalizeSymbol).filter(Boolean);
    state.cachedRepairBacktest = repairMetrics && typeof repairMetrics === "object" ? repairMetrics : null;
    state.cachedStrategyPerformance = strategyPerformance && typeof strategyPerformance === "object" ? strategyPerformance : null;
    state.cachedMarketRegime = marketRegime && typeof marketRegime === "object" ? marketRegime : null;

    if (!ativos.length) {
      updateBotStatus(null);
      return;
    }
    state.symbols = ativos;
    if (!state.ativoSelecionado || !ativos.includes(state.ativoSelecionado)) {
      state.ativoSelecionado = ativos[0];
      invalidateChartState(state.ativoSelecionado);
    }

    // Em paralelo: klines (Binance) + decisões do bot, por ativo, com falhas isoladas
    try {
      const live = await fetchExecutionLive(state.ativoSelecionado);
      await Promise.all([
        fetchTradeTimeline(live && live.livePosition ? live.livePosition.positionId : null).catch((err) => {
          console.error("[execution-timeline]", err);
          state.cachedTradeTimeline = null;
        }),
        fetchExecutionAnalytics().catch((err) => {
          console.error("[execution-analytics]", err);
          state.cachedExecutionAnalytics = null;
        }),
        fetchExecutionHealth().catch((err) => {
          console.error("[execution-health]", err);
          state.cachedExecutionHealth = null;
        }),
        fetchExchangeConditions().catch((err) => {
          console.error("[exchange-conditions]", err);
          state.cachedExchangeConditions = null;
        }),
        fetchPortfolioAnalytics().catch((err) => {
          console.error("[portfolio-analytics]", err);
          state.cachedPortfolioAnalytics = null;
        }),
        fetchMonteCarlo().catch((err) => {
          console.error("[monte-carlo]", err);
          state.cachedMonteCarlo = null;
        }),
        fetchMetaBrain(state.ativoSelecionado).catch((err) => {
          console.error("[meta-brain]", err);
          state.cachedMetaBrain = null;
        })
      ]);
    } catch (err) {
      console.error("[execution-live]", err);
      state.cachedExecutionLive = null;
      state.cachedTradeTimeline = null;
    }

    const fetches = [];
    for (const s of ativos) {
      setChartLoading(s, true);
      fetches.push(
        fetchBinanceKlines(s).catch((err) => { console.error("[klines]", s, err); }),
        fetchBotDecisions(s).catch((err) => { console.error("[decisions]", s, err); })
      );
    }
    try {
      await Promise.all(fetches);
    } finally {
      for (const s of ativos) setChartLoading(s, false);
    }

    if (repairGeneration !== state.repairGeneration) return;
    renderAll();
  } catch (err) {
    console.error("[refresh]", err);
    updateBotStatus(null);
  } finally {
    for (const s of ativos) setChartLoading(s, false);
    state.refreshInFlight = false;
  }
}

function startRefreshLoop() {
  if (state.refreshIntervalId) clearInterval(state.refreshIntervalId);
  if (window.__IA_TRADER_REFRESH_INTERVAL_ID__) clearInterval(window.__IA_TRADER_REFRESH_INTERVAL_ID__);
  refresh();
  state.refreshIntervalId = setInterval(refresh, REFRESH_INTERVAL_MS);
  window.__IA_TRADER_REFRESH_INTERVAL_ID__ = state.refreshIntervalId;
}

// ===== repair backtest =====
async function repairBacktest() {
  const btn = document.getElementById("btnRepair");
  const statusEl = document.getElementById("repairStatus");
  if (!btn || !statusEl) return;
  btn.disabled = true;
  const labelOriginal = btn.textContent;
  btn.textContent = "recalculando…";
  statusEl.className = "repair-status";
  statusEl.textContent = "processando histórico…";
  try {
    state.repairGeneration += 1;
    const url = noCacheUrl("/repair-backtest");
    assertDashboardMetricsSource(url);
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    console.log("[repair]", data);
    const freshData = (await fetchRepairBacktest()) || {};
    const metrics = buildMetricsForSelectedAtivo();
    renderMetrics(metrics);
    statusEl.className = "repair-status ok";
    const sinal = metrics.retornoTotalPct > 0 ? "+" : "";
    // Força próximo refresh imediato pra atualizar dashboard
    statusEl.textContent =
      "OK " + (freshData.tradesValidos ?? metrics.totalTrades) + " validos | " + (freshData.tradesDescartados ?? 0) + " descartados | saldo final $" + fmtNum(metrics.saldoFinal, 2) +
      " (" + sinal + fmtNum(metrics.retornoTotalPct, 2) + "%) | DD max " + fmtNum(metrics.drawdownMaxPct, 2) + "%";
    await refresh(true);
  } catch (err) {
    statusEl.className = "repair-status bad";
    statusEl.textContent = "✗ falhou: " + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
    btn.textContent = labelOriginal;
    setTimeout(() => {
      if (statusEl.classList.contains("ok")) {
        statusEl.textContent = "";
        statusEl.className = "repair-status";
      }
    }, 12_000);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnRepair");
  if (btn) btn.addEventListener("click", repairBacktest);
  const btnRetrain = document.getElementById("btnRetrain");
  if (btnRetrain) btnRetrain.addEventListener("click", triggerMlRetrain);
});

startRefreshLoop();
