import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const COOLDOWN_LIMITE = Number(process.env.LOSS_COOLDOWN_CANDLES ?? 10);

interface DecisionRecord {
  ativo?: unknown;
  resolveuPrejuizo?: unknown;
}

export interface LossCooldownStatus {
  ativa: boolean;
  ciclosRestantes: number;
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

export function checkLossCooldown(ativo: string): LossCooldownStatus {
  const decisoes = readDecisions().filter((d) => d.ativo === ativo);

  let idxResolucao = -1;
  for (let i = decisoes.length - 1; i >= 0; i--) {
    if (decisoes[i].resolveuPrejuizo === true) {
      idxResolucao = i;
      break;
    }
  }

  if (idxResolucao === -1) return { ativa: false, ciclosRestantes: 0, limite: COOLDOWN_LIMITE };

  const ciclosDesde = decisoes.length - 1 - idxResolucao;
  if (ciclosDesde >= COOLDOWN_LIMITE) return { ativa: false, ciclosRestantes: 0, limite: COOLDOWN_LIMITE };

  return {
    ativa: true,
    ciclosRestantes: COOLDOWN_LIMITE - ciclosDesde,
    limite: COOLDOWN_LIMITE
  };
}
