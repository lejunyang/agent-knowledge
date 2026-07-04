#!/usr/bin/env node
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

program
  .command("init")
  .option("--root <dir>", "workspace root", process.cwd())
  .action(async (options: { root: string }) => {
    await initKnowledgeWorkspace(options.root);
    console.log(`Initialized knowledge workspace at ${options.root}`);
  });

program
  .command("index")
  .option("--root <dir>", "workspace root", process.cwd())
  .action((options: { root: string }) => {
    const result = rebuildIndex(options.root);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("query")
  .requiredOption("--task <task>", "task text")
  .option("--root <dir>", "workspace root", process.cwd())
  .option("--domain <domain...>", "domains")
  .option("--scenario <scenario...>", "scenarios")
  .option("--agent-role <role>", "agent role", "main")
  .action((options: { task: string; root: string; domain?: string[]; scenario?: string[]; agentRole: string }) => {
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? []
    });
    const ranked = queryMemories(options.root, request);
    const packet = buildContextPacket({ request, ranked });
    console.log(JSON.stringify(packet, null, 2));
  });

program
  .command("write-candidate")
  .requiredOption("--input <file>", "candidate JSON file")
  .option("--root <dir>", "workspace root", process.cwd())
  .action(async (options: { input: string; root: string }) => {
    const input = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput;
    const result = await writeCandidateMemory(options.root, input);
    console.log(JSON.stringify(result, null, 2));
  });

await program.parseAsync(process.argv);
