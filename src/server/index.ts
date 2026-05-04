import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePerformance } from "../utils/performance.js";

interface RawDecision {
  [key: string]: unknown;
}

function readDecisions(filePath: string): RawDecision[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RawDecision[]) : [];
  } catch {
    return [];
  }
}

export interface ServerHandle {
  port: number;
  close: () => void;
}

export function startServer(port?: number): ServerHandle {
  const PORT = port ?? Number(process.env.WEB_PORT ?? 3000);
  const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
  const PUBLIC_DIR = resolve(process.cwd(), "public");

  const app = express();

  app.use(express.static(PUBLIC_DIR));

  app.get("/decisions", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(readDecisions(DECISIONS_FILE));
  });

  app.get("/performance", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(computePerformance());
  });

  const server = app.listen(PORT, () => {
    console.log(`[web] Dashboard em http://localhost:${PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[web] Porta ${PORT} já está em uso — outro processo escutando?`);
    } else {
      console.error(`[web] Erro no servidor:`, err.message);
    }
  });

  return { port: PORT, close: () => server.close() };
}

// auto-start quando executado como entry point (npm run web)
const entry = process.argv[1] ? fileURLToPath("file://" + process.argv[1].replace(/\\/g, "/")) : "";
const self = fileURLToPath(import.meta.url);
if (entry === self) {
  startServer();
}
