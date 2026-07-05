#!/usr/bin/env node
/**
 * CLI 入口是其他 agent 最常接触的集成面。
 *
 * 设计意图：
 * - 对人类保持简单命令：init / index / query / write-candidate。
 * - 对 agent 保持稳定 JSON 输出，便于脚本解析和上下文注入。
 * - root 解析支持 `--root`、`AGENT_KNOWLEDGE_ROOT`、当前目录三层 fallback，
 *   这样 hooks 可以通过环境变量共享同一套知识库，而不必每次拼接绝对路径。
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  MemoryQueryRequestSchema,
  buildContextPacket,
  initKnowledgeWorkspace,
  queryMemories,
  rebuildIndex,
  writeCandidateMemory,
  type CandidateMemoryInput
} from "./index.js";

const program = new Command();

program.name("agent-knowledge").description("Local human-readable memory toolkit for agents").version("0.1.0");

function resolveCliRoot(root?: string): string {
  return root ?? process.env.AGENT_KNOWLEDGE_ROOT ?? process.cwd();
}

program
  .command("init")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or current directory")
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    console.log(`Initialized knowledge workspace at ${root}`);
  });

program
  .command("index")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or current directory")
  .action((options: { root?: string }) => {
    const result = rebuildIndex(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("query")
  .requiredOption("--task <task>", "task text")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or current directory")
  .option("--domain <domain...>", "domains")
  .option("--scenario <scenario...>", "scenarios")
  .option("--agent-role <role>", "agent role", "main")
  .action((options: { task: string; root?: string; domain?: string[]; scenario?: string[]; agentRole: string }) => {
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? []
    });
    const ranked = queryMemories(resolveCliRoot(options.root), request);
    const packet = buildContextPacket({ request, ranked });
    console.log(JSON.stringify(packet, null, 2));
  });

program
  .command("write-candidate")
  .requiredOption("--input <file>", "candidate JSON file")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or current directory")
  .action(async (options: { input: string; root?: string }) => {
    const input = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput;
    const result = await writeCandidateMemory(resolveCliRoot(options.root), input);
    console.log(JSON.stringify(result, null, 2));
  });

await program.parseAsync(process.argv);
