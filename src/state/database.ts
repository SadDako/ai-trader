import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const DB_PATH = resolve(DATA_DIR, "trader.db");
const DECISIONS_JSON = resolve(DATA_DIR, "decisions.json");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ativo TEXT NOT NULL,
    decisao TEXT NOT NULL,
    confianca REAL NOT NULL,
    tendencia TEXT NOT NULL,
    forca REAL NOT NULL,
    rsi REAL NOT NULL,
    momentum REAL NOT NULL,
    intensidade REAL NOT NULL,
    preco_entrada REAL NOT NULL,
    preco_atual REAL NOT NULL,
    timestamp TEXT NOT NULL,
    resultado TEXT NOT NULL,
    avaliada INTEGER NOT NULL DEFAULT 0,
    resolveu_prejuizo INTEGER NOT NULL DEFAULT 0,
    justificativa TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_ativo ON decisions(ativo);
  CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_decisions_resultado ON decisions(resultado);
  CREATE INDEX IF NOT EXISTS idx_decisions_avaliada_decisao ON decisions(avaliada, decisao);
  CREATE INDEX IF NOT EXISTS idx_decisions_ativo_timestamp ON decisions(ativo, timestamp);

  CREATE TABLE IF NOT EXISTS strategy_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setup TEXT NOT NULL,
    ativo TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    direcao TEXT NOT NULL,
    total_trades INTEGER NOT NULL,
    win_rate REAL NOT NULL,
    profit_factor REAL NOT NULL,
    expectancy REAL NOT NULL,
    sharpe REAL NOT NULL,
    drawdown REAL NOT NULL,
    pnl_acumulado REAL NOT NULL,
    edge_score REAL NOT NULL,
    trusted INTEGER NOT NULL,
    blocked INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(setup, ativo, timeframe, direcao)
  );
  CREATE INDEX IF NOT EXISTS idx_strategy_performance_edge ON strategy_performance(edge_score);
  CREATE INDEX IF NOT EXISTS idx_strategy_performance_blocked ON strategy_performance(blocked);

  CREATE TABLE IF NOT EXISTS execution_orders (
    order_id TEXT PRIMARY KEY,
    decision_id INTEGER,
    decision_timestamp TEXT,
    ativo TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    position_id TEXT,
    quantity REAL NOT NULL,
    remaining_quantity REAL NOT NULL,
    requested_price REAL,
    limit_price REAL,
    stop_price REAL,
    avg_fill_price REAL,
    slippage_pct REAL NOT NULL,
    slippage_cost REAL NOT NULL,
    execution_latency_ms INTEGER NOT NULL,
    decision_delay_ms INTEGER NOT NULL,
    exchange_latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    filled_at TEXT,
    cancelled_at TEXT,
    execution_quality REAL NOT NULL,
    missed_profit REAL NOT NULL,
    adverse_excursion REAL NOT NULL,
    favorable_excursion REAL NOT NULL,
    setup TEXT,
    regime TEXT,
    regime_confidence REAL,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_execution_orders_ativo_created ON execution_orders(ativo, created_at);
  CREATE INDEX IF NOT EXISTS idx_execution_orders_status ON execution_orders(status);
  CREATE INDEX IF NOT EXISTS idx_execution_orders_position ON execution_orders(position_id);

  CREATE TABLE IF NOT EXISTS execution_fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    notional REAL NOT NULL,
    fee REAL NOT NULL,
    slippage_pct REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES execution_orders(order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_fills_order ON execution_fills(order_id);

  CREATE TABLE IF NOT EXISTS execution_positions (
    position_id TEXT PRIMARY KEY,
    ativo TEXT NOT NULL,
    side TEXT NOT NULL,
    status TEXT NOT NULL,
    entry_price REAL NOT NULL,
    current_price REAL NOT NULL,
    quantity REAL NOT NULL,
    remaining_quantity REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    floating_pnl REAL NOT NULL,
    stop_price REAL,
    target_price REAL,
    trailing_stop REAL,
    break_even_price REAL,
    rr_current REAL NOT NULL,
    mae REAL NOT NULL,
    mfe REAL NOT NULL,
    trade_decay_score REAL NOT NULL DEFAULT 100,
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    setup TEXT,
    regime TEXT,
    reentry_locked_until TEXT,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_execution_positions_status ON execution_positions(status);
  CREATE INDEX IF NOT EXISTS idx_execution_positions_ativo_status ON execution_positions(ativo, status);

  CREATE TABLE IF NOT EXISTS execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT,
    order_id TEXT,
    event_type TEXT NOT NULL,
    ativo TEXT NOT NULL,
    side TEXT,
    price REAL,
    quantity REAL,
    pnl REAL,
    created_at TEXT NOT NULL,
    message TEXT,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_execution_events_position ON execution_events(position_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_execution_events_ativo_created ON execution_events(ativo, created_at);

  CREATE TABLE IF NOT EXISTS meta_brain_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    severity TEXT NOT NULL,
    scope TEXT NOT NULL,
    message TEXT NOT NULL,
    setup TEXT,
    ativo TEXT,
    regime TEXT,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_meta_brain_logs_created ON meta_brain_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_meta_brain_logs_setup ON meta_brain_logs(setup);

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    saldo_inicial REAL NOT NULL,
    saldo_atual REAL NOT NULL,
    capital_livre REAL NOT NULL,
    capital_alocado REAL NOT NULL,
    pnl_realizado REAL NOT NULL,
    pnl_flutuante REAL NOT NULL,
    drawdown_atual REAL NOT NULL,
    retorno_diario REAL NOT NULL,
    retorno_semanal REAL NOT NULL,
    exposure_total_pct REAL NOT NULL,
    risco_agregado REAL NOT NULL,
    trades_abertos INTEGER NOT NULL,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_created ON portfolio_snapshots(created_at);
`);

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

for (const [column, definition] of [
  ["stop_loss", "REAL"],
  ["take_profit", "REAL"],
  ["atr", "REAL"],
  ["atr_pct", "REAL"],
  ["stop_distance", "REAL"],
  ["risk_pct", "REAL"],
  ["risk_amount", "REAL"],
  ["position_size", "REAL"],
  ["notional", "REAL"],
  ["rr", "REAL"],
  ["lucro_prejuizo", "REAL"],
  ["motivo_operacional", "TEXT"],
  ["setup", "TEXT"],
  ["timeframe", "TEXT"],
  ["direcao", "TEXT"],
  ["edge_score", "REAL"],
  ["regime", "TEXT"],
  ["regime_confidence", "REAL"],
  ["market_quality_score", "REAL"],
  ["market_quality_label", "TEXT"],
  ["execution_order_id", "TEXT"],
  ["execution_status", "TEXT"],
  ["execution_quality", "REAL"],
  ["slippage_cost", "REAL"],
  ["execution_latency_ms", "INTEGER"],
  ["missed_profit", "REAL"],
  ["adverse_excursion", "REAL"],
  ["favorable_excursion", "REAL"]
] as const) {
  ensureColumn("decisions", column, definition);
}

for (const [column, definition] of [
  ["trade_decay_score", "REAL NOT NULL DEFAULT 100"]
] as const) {
  ensureColumn("execution_positions", column, definition);
}

// Backfill: se a tabela está vazia mas tem decisions.json com dados, popula
function maybeBackfill(): void {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number } | undefined;
    if (row && row.n > 0) return;
    if (!existsSync(DECISIONS_JSON)) return;

    const raw = readFileSync(DECISIONS_JSON, "utf-8").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;

    const insert = db.prepare(`
      INSERT INTO decisions (
        ativo, decisao, confianca, tendencia, forca, rsi, momentum, intensidade,
        preco_entrada, preco_atual, timestamp, resultado, avaliada, resolveu_prejuizo, justificativa
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.prepare("BEGIN").run.bind(db.prepare("BEGIN"));
    db.exec("BEGIN");
    let inserted = 0;
    for (const r of parsed) {
      try {
        const ativo = typeof r.ativo === "string" ? r.ativo : "";
        if (!ativo) continue;
        const just = r.analise && typeof r.analise === "object" && typeof r.analise.justificativa === "string"
          ? r.analise.justificativa
          : null;
        insert.run(
          ativo,
          typeof r.decisao === "string" ? r.decisao : "esperar",
          Number.isFinite(r.confianca) ? r.confianca : 0,
          typeof r.tendencia === "string" ? r.tendencia : "lateral",
          Number.isFinite(r.forca) ? r.forca : 0,
          Number.isFinite(r.rsi) ? r.rsi : 50,
          Number.isFinite(r.momentum) ? r.momentum : 0,
          Number.isFinite(r.intensidade) ? r.intensidade : 0,
          Number.isFinite(r.precoEntrada) ? r.precoEntrada : 0,
          Number.isFinite(r.precoAtual) ? r.precoAtual : 0,
          typeof r.timestamp === "string" ? r.timestamp : new Date().toISOString(),
          typeof r.resultado === "string" ? r.resultado : "neutro",
          r.avaliada ? 1 : 0,
          r.resolveuPrejuizo ? 1 : 0,
          just
        );
        inserted += 1;
      } catch {
        // pula registros corrompidos
      }
    }
    db.exec("COMMIT");
    console.log(`[db] backfill: ${inserted} decisões importadas de decisions.json`);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[db] backfill falhou: ${msg}`);
  }
}

maybeBackfill();
