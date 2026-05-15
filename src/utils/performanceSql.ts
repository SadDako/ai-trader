import { db } from "../state/database.js";
import { safeNumber, safeRound, safeBalance, clampNonNegative } from "./safeMath.js";

const TAXA_OPERACAO_PCT = 0.1;
const TAXA_TOTAL_PCT = TAXA_OPERACAO_PCT * 2;
const SALDO_FLOOR = -100;
const SALDO_CEILING = 1_000_000;

export interface AtivoBreakdown {
  ativo: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  lucro: number;
  prejuizo: number;
  saldo: number;
  lucroMedio: number;
  prejuizoMedio: number;
}

export interface PerformanceSqlResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  lucro: number;
  prejuizo: number;
  saldo: number;
  lucroMedio: number;
  prejuizoMedio: number;
  porAtivo: AtivoBreakdown[];
  ultimosTrades: number;
}

function round(value: number, decimals = 2): number {
  return safeRound(value, decimals);
}

function tradeReturnPct(decisao: string, precoEntrada: number, precoAtual: number): number {
  const pe = safeNumber(precoEntrada);
  const pa = safeNumber(precoAtual);
  if (pe === 0) return 0;
  let bruto = 0;
  if (decisao === "compra") {
    bruto = ((pa - pe) / pe) * 100;
  } else if (decisao === "venda") {
    bruto = ((pe - pa) / pe) * 100;
  } else {
    return 0;
  }
  const liquido = bruto - TAXA_TOTAL_PCT;
  return Number.isFinite(liquido) ? liquido : 0;
}

interface OpRow {
  ativo: string;
  decisao: string;
  resultado: string;
  preco_entrada: number;
  preco_atual: number;
}

const stmtOps = db.prepare(`
  SELECT ativo, decisao, resultado, preco_entrada, preco_atual
  FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
`);

export function computePerformanceSql(): PerformanceSqlResult {
  const ops = stmtOps.all() as unknown as OpRow[];
  const empty: PerformanceSqlResult = {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    lucro: 0, prejuizo: 0, saldo: 0, lucroMedio: 0, prejuizoMedio: 0,
    porAtivo: [], ultimosTrades: 0
  };
  if (ops.length === 0) return empty;

  let wins = 0, losses = 0, lucro = 0, prejuizo = 0;
  const lucros: number[] = [];
  const prejuizos: number[] = [];
  const porAtivoMap = new Map<string, { wins: number; losses: number; total: number; lucro: number; prejuizo: number; lucros: number[]; prejuizos: number[] }>();

  for (const op of ops) {
    const ret = tradeReturnPct(op.decisao, op.preco_entrada, op.preco_atual);
    const isWin = op.resultado === "lucro";
    const isLoss = op.resultado === "prejuizo";

    if (isWin) wins += 1;
    if (isLoss) losses += 1;

    if (ret > 0) { lucro += ret; lucros.push(ret); }
    else if (ret < 0) { prejuizo += -ret; prejuizos.push(-ret); }

    const key = op.ativo;
    const a = porAtivoMap.get(key) ?? { wins: 0, losses: 0, total: 0, lucro: 0, prejuizo: 0, lucros: [], prejuizos: [] };
    a.total += 1;
    if (isWin) a.wins += 1;
    if (isLoss) a.losses += 1;
    if (ret > 0) { a.lucro += ret; a.lucros.push(ret); }
    else if (ret < 0) { a.prejuizo += -ret; a.prejuizos.push(-ret); }
    porAtivoMap.set(key, a);
  }

  const total = ops.length;
  const lucroMedio = lucros.length ? lucro / lucros.length : 0;
  const prejuizoMedio = prejuizos.length ? prejuizo / prejuizos.length : 0;

  const porAtivo: AtivoBreakdown[] = [];
  for (const [ativo, a] of porAtivoMap) {
    porAtivo.push({
      ativo,
      total: a.total,
      wins: a.wins,
      losses: a.losses,
      winRate: a.total ? round((a.wins / a.total) * 100) : 0,
      lucro: round(a.lucro),
      prejuizo: round(a.prejuizo),
      saldo: round(a.lucro - a.prejuizo),
      lucroMedio: a.lucros.length ? round(a.lucro / a.lucros.length) : 0,
      prejuizoMedio: a.prejuizos.length ? round(a.prejuizo / a.prejuizos.length) : 0
    });
  }
  porAtivo.sort((x, y) => x.ativo.localeCompare(y.ativo));

  // Sanitização final — protege contra NaN/Infinity/saldo extremo
  const lucroSafe = clampNonNegative(lucro);
  const prejuizoSafe = clampNonNegative(prejuizo);
  const saldoSafe = safeBalance(lucroSafe - prejuizoSafe, SALDO_FLOOR, SALDO_CEILING);
  const wrSafe = total > 0 ? clampNonNegative((wins / total) * 100) : 0;

  return {
    totalTrades: total,
    wins,
    losses,
    winRate: round(wrSafe),
    lucro: round(lucroSafe),
    prejuizo: round(prejuizoSafe),
    saldo: round(saldoSafe),
    lucroMedio: round(clampNonNegative(lucroMedio)),
    prejuizoMedio: round(clampNonNegative(prejuizoMedio)),
    porAtivo,
    ultimosTrades: total
  };
}

interface ResultadoRow {
  decisao: string;
  resultado: string;
}

const stmtAjustePorDirecao = db.prepare(`
  SELECT decisao, resultado FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
    AND (resultado = 'lucro' OR resultado = 'prejuizo')
`);

export function computeAjustePorDirecaoSql(): { ajusteCompra: number; ajusteVenda: number } {
  const rows = stmtAjustePorDirecao.all() as unknown as ResultadoRow[];
  const stats = { compra: { acertos: 0, erros: 0 }, venda: { acertos: 0, erros: 0 } };
  for (const r of rows) {
    const bucket = r.decisao === "compra" ? stats.compra : r.decisao === "venda" ? stats.venda : null;
    if (!bucket) continue;
    if (r.resultado === "lucro") bucket.acertos += 1;
    else bucket.erros += 1;
  }
  const calc = (s: { acertos: number; erros: number }) => {
    const total = s.acertos + s.erros;
    if (total < 3) return 1;
    const taxa = s.acertos / total;
    return Math.max(0.5, Math.min(1.5, 0.5 + taxa));
  };
  return {
    ajusteCompra: round(calc(stats.compra), 3),
    ajusteVenda: round(calc(stats.venda), 3)
  };
}
