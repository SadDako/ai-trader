import { db } from "../state/database.js";

export type PositionSide = "LONG" | "SHORT";
export type PositionStatus = "PENDING" | "OPEN" | "PARTIAL" | "BREAKEVEN" | "TRAILING" | "CLOSING" | "CLOSED" | "STOPPED" | "CANCELLED";
export type TradeTimelineEvent = "ENTRY" | "PARTIAL TP" | "MOVE TO BREAKEVEN" | "TRAILING UPDATE" | "EXIT";

export interface PositionManagerConfig {
  pyramiding?: boolean;
  scaleOutFraction?: number;
  breakEvenR?: number;
  trailingAtrMultiplier?: number;
  reentryLockMs?: number;
}

export interface ManagedPosition {
  positionId: string;
  ativo: string;
  side: PositionSide;
  status: PositionStatus;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  remainingQuantity: number;
  realizedPnl: number;
  floatingPnl: number;
  stopPrice: number | null;
  targetPrice: number | null;
  trailingStop: number | null;
  breakEvenPrice: number | null;
  rrCurrent: number;
  mae: number;
  mfe: number;
  tradeDecayScore: number;
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
  setup: string | null;
  regime: string | null;
  reentryLockedUntil: string | null;
}

export interface OpenPositionInput {
  positionId: string;
  orderId: string;
  ativo: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  setup?: string | null;
  regime?: string | null;
  openedAt: string;
}

export interface IntrabarTick {
  ativo: string;
  price: number;
  timestamp: string;
  atr?: number;
  volumeRelative?: number;
}

const DEFAULT_CONFIG: Required<PositionManagerConfig> = {
  pyramiding: false,
  scaleOutFraction: 0.5,
  breakEvenR: 1,
  trailingAtrMultiplier: 1.1,
  reentryLockMs: 15 * 60_000
};

const ACTIVE_STATUSES = ["PENDING", "OPEN", "PARTIAL", "BREAKEVEN", "TRAILING", "CLOSING"];
const ALLOWED_TRANSITIONS: Record<PositionStatus, PositionStatus[]> = {
  PENDING: ["OPEN", "CANCELLED"],
  OPEN: ["PARTIAL", "BREAKEVEN", "TRAILING", "CLOSING", "CLOSED", "STOPPED", "CANCELLED"],
  PARTIAL: ["BREAKEVEN", "TRAILING", "CLOSING", "CLOSED", "STOPPED"],
  BREAKEVEN: ["TRAILING", "PARTIAL", "CLOSING", "CLOSED", "STOPPED"],
  TRAILING: ["PARTIAL", "CLOSING", "CLOSED", "STOPPED"],
  CLOSING: ["CLOSED", "STOPPED", "CANCELLED"],
  CLOSED: [],
  STOPPED: [],
  CANCELLED: []
};

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number, digits = 6): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sideMultiplier(side: PositionSide): number {
  return side === "LONG" ? 1 : -1;
}

function pnlFor(side: PositionSide, entry: number, price: number, qty: number): number {
  return (price - entry) * qty * sideMultiplier(side);
}

function rrFor(position: ManagedPosition, price: number): number {
  const stop = finite(position.stopPrice, NaN);
  const target = finite(position.targetPrice, NaN);
  const entry = position.entryPrice;
  const risk = Number.isFinite(stop) ? Math.abs(entry - stop) : 0;
  if (risk <= 0) return 0;
  const progress = Math.abs(price - entry) * sideMultiplier(position.side) / risk;
  if (Number.isFinite(target) && Math.abs(target - entry) > 0) return round(progress, 4);
  return round(progress, 4);
}

function tradeDecayScore(openedAt: string, at: string): number {
  const opened = new Date(openedAt).getTime();
  const current = new Date(at).getTime();
  if (!Number.isFinite(opened) || !Number.isFinite(current) || current <= opened) return 100;
  const holdMinutes = (current - opened) / 60_000;
  const warmup = Math.max(0, holdMinutes - 15);
  return round(Math.max(0, 100 - warmup * 1.85), 2);
}

function toPosition(row: Record<string, unknown>): ManagedPosition {
  return {
    positionId: String(row.position_id),
    ativo: String(row.ativo),
    side: row.side === "SHORT" ? "SHORT" : "LONG",
    status: String(row.status) as PositionStatus,
    entryPrice: finite(row.entry_price),
    currentPrice: finite(row.current_price),
    quantity: finite(row.quantity),
    remainingQuantity: finite(row.remaining_quantity),
    realizedPnl: finite(row.realized_pnl),
    floatingPnl: finite(row.floating_pnl),
    stopPrice: row.stop_price === null || row.stop_price === undefined ? null : finite(row.stop_price),
    targetPrice: row.target_price === null || row.target_price === undefined ? null : finite(row.target_price),
    trailingStop: row.trailing_stop === null || row.trailing_stop === undefined ? null : finite(row.trailing_stop),
    breakEvenPrice: row.break_even_price === null || row.break_even_price === undefined ? null : finite(row.break_even_price),
    rrCurrent: finite(row.rr_current),
    mae: finite(row.mae),
    mfe: finite(row.mfe),
    tradeDecayScore: finite(row.trade_decay_score, 100),
    openedAt: String(row.opened_at),
    updatedAt: String(row.updated_at),
    closedAt: row.closed_at ? String(row.closed_at) : null,
    setup: row.setup ? String(row.setup) : null,
    regime: row.regime ? String(row.regime) : null,
    reentryLockedUntil: row.reentry_locked_until ? String(row.reentry_locked_until) : null
  };
}

const stmtActiveByAtivo = db.prepare(`
  SELECT * FROM execution_positions
  WHERE ativo = ? AND status IN ('PENDING', 'OPEN', 'PARTIAL', 'BREAKEVEN', 'TRAILING', 'CLOSING')
  ORDER BY opened_at DESC
`);
const stmtLatestActive = db.prepare(`
  SELECT * FROM execution_positions
  WHERE status IN ('PENDING', 'OPEN', 'PARTIAL', 'BREAKEVEN', 'TRAILING', 'CLOSING')
  ORDER BY updated_at DESC
  LIMIT 1
`);
const stmtAllActive = db.prepare(`
  SELECT * FROM execution_positions
  WHERE status IN ('PENDING', 'OPEN', 'PARTIAL', 'BREAKEVEN', 'TRAILING', 'CLOSING')
  ORDER BY updated_at DESC
`);
const stmtPositionById = db.prepare("SELECT * FROM execution_positions WHERE position_id = ?");
const stmtOpenPosition = db.prepare(`
  INSERT OR REPLACE INTO execution_positions (
    position_id, ativo, side, status, entry_price, current_price, quantity, remaining_quantity,
    realized_pnl, floating_pnl, stop_price, target_price, trailing_stop, break_even_price,
    rr_current, mae, mfe, trade_decay_score, opened_at, updated_at, closed_at, setup, regime, reentry_locked_until,
    metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdatePosition = db.prepare(`
  UPDATE execution_positions
  SET status = ?, current_price = ?, remaining_quantity = ?, realized_pnl = ?, floating_pnl = ?,
      stop_price = ?, target_price = ?, trailing_stop = ?, break_even_price = ?, rr_current = ?,
      mae = ?, mfe = ?, trade_decay_score = ?, updated_at = ?, closed_at = ?, reentry_locked_until = ?, metadata_json = ?
  WHERE position_id = ?
`);
const stmtEvent = db.prepare(`
  INSERT INTO execution_events (
    position_id, order_id, event_type, ativo, side, price, quantity, pnl, created_at, message, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtTimeline = db.prepare(`
  SELECT position_id, order_id, event_type, ativo, side, price, quantity, pnl, created_at, message, metadata_json
  FROM execution_events
  WHERE position_id = ?
  ORDER BY datetime(created_at) ASC, id ASC
`);

export class PositionManager {
  private config: Required<PositionManagerConfig>;

  constructor(config: PositionManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getActivePositions(ativo?: string): ManagedPosition[] {
    if (ativo) return (stmtActiveByAtivo.all(ativo.toUpperCase()) as Record<string, unknown>[]).map(toPosition);
    return (stmtAllActive.all() as Record<string, unknown>[]).map(toPosition);
  }

  getPosition(positionId: string): ManagedPosition | null {
    const row = stmtPositionById.get(positionId) as Record<string, unknown> | undefined;
    return row ? toPosition(row) : null;
  }

  canOpen(ativo: string, side: PositionSide, at = new Date()): { ok: boolean; reason?: string } {
    const active = this.getActivePositions(ativo);
    if (!this.config.pyramiding && active.some((p) => p.side === side && p.status !== "CLOSED")) {
      return { ok: false, reason: "pyramiding_disabled" };
    }
    const locked = active.find((p) => p.reentryLockedUntil && new Date(p.reentryLockedUntil).getTime() > at.getTime());
    if (locked) return { ok: false, reason: "reentry_lock" };
    return { ok: true };
  }

  open(input: OpenPositionInput): ManagedPosition {
    const status: PositionStatus = "OPEN";
    const position: ManagedPosition = {
      positionId: input.positionId,
      ativo: input.ativo.toUpperCase(),
      side: input.side,
      status,
      entryPrice: round(input.entryPrice),
      currentPrice: round(input.entryPrice),
      quantity: round(input.quantity, 8),
      remainingQuantity: round(input.quantity, 8),
      realizedPnl: 0,
      floatingPnl: 0,
      stopPrice: input.stopPrice ?? null,
      targetPrice: input.targetPrice ?? null,
      trailingStop: null,
      breakEvenPrice: null,
      rrCurrent: 0,
      mae: 0,
      mfe: 0,
      tradeDecayScore: 100,
      openedAt: input.openedAt,
      updatedAt: input.openedAt,
      closedAt: null,
      setup: input.setup ?? null,
      regime: input.regime ?? null,
      reentryLockedUntil: null
    };

    stmtOpenPosition.run(
      position.positionId,
      position.ativo,
      position.side,
      position.status,
      position.entryPrice,
      position.currentPrice,
      position.quantity,
      position.remainingQuantity,
      position.realizedPnl,
      position.floatingPnl,
      position.stopPrice,
      position.targetPrice,
      position.trailingStop,
      position.breakEvenPrice,
      position.rrCurrent,
      position.mae,
      position.mfe,
      position.tradeDecayScore,
      position.openedAt,
      position.updatedAt,
      position.closedAt,
      position.setup,
      position.regime,
      position.reentryLockedUntil,
      JSON.stringify({ source: "execution-engine" })
    );
    console.log(
      `[position] OPEN ${position.ativo} ${position.side} qty=${position.quantity} entry=${position.entryPrice} stop=${position.stopPrice ?? "-"} target=${position.targetPrice ?? "-"}`
    );
    console.log(
      `[position-opened] ${position.ativo} ${position.side} position=${position.positionId} qty=${position.quantity} entry=${position.entryPrice}`
    );
    this.event({
      positionId: position.positionId,
      orderId: input.orderId,
      eventType: "ENTRY",
      ativo: position.ativo,
      side: position.side,
      price: position.entryPrice,
      quantity: position.quantity,
      pnl: 0,
      createdAt: position.openedAt,
      message: "entrada executada"
    });
    return position;
  }

  updateIntrabar(tick: IntrabarTick): ManagedPosition[] {
    const positions = this.getActivePositions(tick.ativo);
    return positions.map((p) => this.applyTick(p, tick));
  }

  getTimeline(positionId: string): Array<Record<string, unknown>> {
    return stmtTimeline.all(positionId) as Array<Record<string, unknown>>;
  }

  private applyTick(position: ManagedPosition, tick: IntrabarTick): ManagedPosition {
    const price = round(tick.price);
    const at = tick.timestamp || nowIso();
    const floatingPnl = round(pnlFor(position.side, position.entryPrice, price, position.remainingQuantity), 4);
    const excursion = round((price - position.entryPrice) * sideMultiplier(position.side), 6);
    position.currentPrice = price;
    position.floatingPnl = floatingPnl;
    position.mae = round(Math.min(position.mae, excursion), 6);
    position.mfe = round(Math.max(position.mfe, excursion), 6);
    position.rrCurrent = rrFor(position, price);
    position.tradeDecayScore = tradeDecayScore(position.openedAt, at);
    position.updatedAt = at;
    console.log(`[position-updated] ${position.ativo} ${position.side} position=${position.positionId} price=${price} pnl=${floatingPnl} rr=${position.rrCurrent}`);
    console.log(`[pnl-updated] ${position.ativo} position=${position.positionId} floating=${floatingPnl} realized=${position.realizedPnl}`);

    const riskDistance = position.stopPrice ? Math.abs(position.entryPrice - position.stopPrice) : 0;
    if (!position.breakEvenPrice && riskDistance > 0 && position.rrCurrent >= this.config.breakEvenR) {
      position.breakEvenPrice = position.entryPrice;
      position.stopPrice = position.entryPrice;
      this.transition(position, "BREAKEVEN");
      this.event({
        positionId: position.positionId,
        eventType: "MOVE TO BREAKEVEN",
        ativo: position.ativo,
        side: position.side,
        price,
        quantity: position.remainingQuantity,
        pnl: position.realizedPnl,
        createdAt: at,
        message: "stop movido para break-even"
      });
      console.log(`[trailing-moved] ${position.ativo} ${position.side} position=${position.positionId} stop=${position.stopPrice} reason=breakeven`);
    }

    const atr = Math.max(0, finite(tick.atr));
    if (atr > 0 && position.rrCurrent >= 1.25) {
      const proposed = position.side === "LONG"
        ? price - atr * this.config.trailingAtrMultiplier
        : price + atr * this.config.trailingAtrMultiplier;
      const currentTrail = position.trailingStop ?? position.stopPrice ?? proposed;
      const better = position.side === "LONG" ? proposed > currentTrail : proposed < currentTrail;
      if (better) {
        position.trailingStop = round(proposed);
        position.stopPrice = position.trailingStop;
        this.transition(position, "TRAILING");
        this.event({
          positionId: position.positionId,
          eventType: "TRAILING UPDATE",
          ativo: position.ativo,
          side: position.side,
          price: position.trailingStop,
          quantity: position.remainingQuantity,
          pnl: position.realizedPnl,
          createdAt: at,
          message: "trailing stop ajustado"
        });
        console.log(`[trailing-moved] ${position.ativo} ${position.side} position=${position.positionId} stop=${position.trailingStop} reason=atr_trailing`);
      }
    }

    if (position.status !== "PARTIAL" && position.targetPrice && position.rrCurrent >= 1) {
      const qty = round(position.remainingQuantity * this.config.scaleOutFraction, 8);
      if (qty > 0 && qty < position.remainingQuantity) {
        const pnl = round(pnlFor(position.side, position.entryPrice, price, qty), 4);
        position.realizedPnl = round(position.realizedPnl + pnl, 4);
        position.remainingQuantity = round(position.remainingQuantity - qty, 8);
        this.transition(position, "PARTIAL");
        this.event({
          positionId: position.positionId,
          eventType: "PARTIAL TP",
          ativo: position.ativo,
          side: position.side,
          price,
          quantity: qty,
          pnl,
          createdAt: at,
          message: "scale-out parcial executado"
        });
        console.log(`[position] PARTIAL ${position.ativo} ${position.side} qty=${qty} price=${price} pnl=${pnl}`);
        console.log(`[partial-executed] ${position.ativo} ${position.side} position=${position.positionId} qty=${qty} price=${price} pnl=${pnl}`);
      }
    }

    const stop = position.stopPrice ?? position.trailingStop;
    if (stop && ((position.side === "LONG" && price <= stop) || (position.side === "SHORT" && price >= stop))) {
      this.close(position, stop, at, "STOPPED", "stop acionado");
      return this.getPosition(position.positionId) ?? position;
    }
    if (position.targetPrice && ((position.side === "LONG" && price >= position.targetPrice) || (position.side === "SHORT" && price <= position.targetPrice))) {
      this.close(position, position.targetPrice, at, "CLOSED", "alvo final executado");
      return this.getPosition(position.positionId) ?? position;
    }

    this.persist(position);
    return position;
  }

  private close(position: ManagedPosition, price: number, at: string, status: PositionStatus, message: string): void {
    const qty = position.remainingQuantity;
    const pnl = round(pnlFor(position.side, position.entryPrice, price, position.remainingQuantity), 4);
    position.realizedPnl = round(position.realizedPnl + pnl, 4);
    position.floatingPnl = 0;
    position.currentPrice = round(price);
    position.remainingQuantity = 0;
    this.transition(position, "CLOSING");
    this.transition(position, status);
    position.closedAt = at;
    position.updatedAt = at;
    position.reentryLockedUntil = new Date(new Date(at).getTime() + this.config.reentryLockMs).toISOString();
    this.event({
      positionId: position.positionId,
      eventType: "EXIT",
      ativo: position.ativo,
      side: position.side,
      price,
      quantity: qty,
      pnl,
      createdAt: at,
      message
    });
    console.log(`[position] ${status} ${position.ativo} ${position.side} price=${price} pnl=${pnl} message=${message}`);
    console.log(`[position-closed] ${position.ativo} ${position.side} position=${position.positionId} status=${status} price=${price} pnl=${pnl} reason=${message}`);
    this.persist(position);
  }

  private transition(position: ManagedPosition, next: PositionStatus): void {
    if (position.status === next) return;
    const allowed = ALLOWED_TRANSITIONS[position.status] || [];
    if (!allowed.includes(next)) {
      console.warn(`[position] invalid-transition ${position.positionId}: ${position.status} -> ${next}`);
      return;
    }
    position.status = next;
  }

  private persist(position: ManagedPosition): void {
    stmtUpdatePosition.run(
      position.status,
      position.currentPrice,
      position.remainingQuantity,
      position.realizedPnl,
      position.floatingPnl,
      position.stopPrice,
      position.targetPrice,
      position.trailingStop,
      position.breakEvenPrice,
      position.rrCurrent,
      position.mae,
      position.mfe,
      position.tradeDecayScore,
      position.updatedAt,
      position.closedAt,
      position.reentryLockedUntil,
      JSON.stringify({ source: "position-manager", updatedAt: position.updatedAt, trade_decay_score: position.tradeDecayScore }),
      position.positionId
    );
  }

  private event(input: {
    positionId?: string | null;
    orderId?: string | null;
    eventType: TradeTimelineEvent;
    ativo: string;
    side?: PositionSide | null;
    price?: number | null;
    quantity?: number | null;
    pnl?: number | null;
    createdAt?: string;
    message?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    stmtEvent.run(
      input.positionId ?? null,
      input.orderId ?? null,
      input.eventType,
      input.ativo.toUpperCase(),
      input.side ?? null,
      input.price ?? null,
      input.quantity ?? null,
      input.pnl ?? null,
      input.createdAt ?? nowIso(),
      input.message ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    );
  }
}

export const positionManager = new PositionManager();

export function activeStatusList(): string[] {
  return [...ACTIVE_STATUSES];
}
