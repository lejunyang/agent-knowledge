/**
 * JSONL 操作日志只记录可审计的运行摘要，不保存完整知识正文。
 *
 * `.memory/` 仍然是可重建机器产物；日志用于排查检索和 catalog 行为，
 * 因此采用追加式 JSONL，便于 grep、tail 和离线分析。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolveWorkspacePath } from "./paths.js";

export type MemoryLogEvent = {
  event: string;
  timestamp?: string;
  [key: string]: unknown;
};

export function getLogFilePath(rootDir: string, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return resolveWorkspacePath(rootDir, ".memory", "logs", `${day}.jsonl`);
}

export function appendJsonlLog(rootDir: string, event: MemoryLogEvent): string {
  const logPath = getLogFilePath(rootDir);
  mkdirSync(resolveWorkspacePath(rootDir, ".memory", "logs"), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
  return logPath;
}
