import dotenv from "dotenv";

dotenv.config({ override: true });

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 3000;

const PLACEHOLDER_VALUES = new Set([
  "",
  "change-me",
  "replace-me",
  "your-api-key-here",
  "your-dashboard-token-here",
  "example"
]);

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !PLACEHOLDER_VALUES.has(value.toLowerCase()) ? value : undefined;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const env = {
  nodeEnv: readEnv("NODE_ENV") ?? "development",
  anthropicApiKey: readEnv("ANTHROPIC_API_KEY"),
  anthropicModel: readEnv("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL,
  webHost: readEnv("WEB_HOST") ?? DEFAULT_WEB_HOST,
  webPort: readNumberEnv("WEB_PORT", DEFAULT_WEB_PORT),
  dashboardAuthToken: readEnv("DASHBOARD_AUTH_TOKEN"),
  disableDashboardAuth: readEnv("DISABLE_DASHBOARD_AUTH") === "true"
} as const;

export function validateEnvironment(): string[] {
  const warnings: string[] = [];

  if (!env.anthropicApiKey) {
    warnings.push("ANTHROPIC_API_KEY ausente; o bot usara fallback heuristico sem chamada LLM.");
  }

  if (env.nodeEnv === "production" && !env.dashboardAuthToken && !env.disableDashboardAuth) {
    warnings.push("DASHBOARD_AUTH_TOKEN ausente em producao; defina um token ou isole a interface por rede/VPN.");
  }

  if (env.webHost !== "127.0.0.1" && env.webHost !== "localhost" && !env.dashboardAuthToken) {
    warnings.push("WEB_HOST exposto fora de localhost sem DASHBOARD_AUTH_TOKEN.");
  }

  return warnings;
}
