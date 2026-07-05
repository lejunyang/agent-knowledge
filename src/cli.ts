#!/usr/bin/env node
/**
 * CLI 入口是其他 agent 最常接触的集成面。
 *
 * 设计意图：
 * - 对人类保持简单命令：init / index / query / write-candidate / list / organize-inbox / capture-material。
 * - 对 agent 保持稳定 JSON 输出，便于脚本解析和上下文注入。
 * - root 解析支持 `--root`、`AGENT_KNOWLEDGE_ROOT`、`~/.agent_knowledge` 三层 fallback，
 *   这样不同项目的 hooks 可以共享同一套默认知识库。
 */
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  MemoryQueryRequestSchema,
  appendJsonlLog,
  buildContextPacket,
  catalogKnowledge,
  captureMaterial,
  initKnowledgeWorkspace,
  listKnowledge,
  organizeInbox,
  queryMemories,
  queryMemoriesWithDebug,
  rebuildIndex,
  writeCandidateMemory,
  type CandidateMemoryInput
} from "./index.js";
import { getDefaultKnowledgeRoot } from "./paths.js";

const program = new Command();

program.name("agent-knowledge").description("Local human-readable memory toolkit for agents").version("0.1.0");

function resolveCliRoot(root?: string): string {
  return root ?? process.env.AGENT_KNOWLEDGE_ROOT ?? getDefaultKnowledgeRoot();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readHookInput(): Promise<Record<string, unknown>> {
  const text = await readStdin();
  if (text.trim().length === 0) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function hookContext(hookEventName: "SessionStart" | "UserPromptSubmit", additionalContext: string): void {
  console.log(
    JSON.stringify(
      {
        hookSpecificOutput: {
          hookEventName,
          additionalContext
        }
      },
      null,
      2
    )
  );
}

function compactCatalogForHook(catalog: Awaited<ReturnType<typeof catalogKnowledge>>): Record<string, unknown> {
  return {
    total: catalog.total,
    byStatus: catalog.byStatus,
    byType: catalog.byType,
    domains: Object.keys(catalog.byDomain).sort(),
    scenarios: [...new Set(catalog.items.flatMap((item) => item.scenarios))].sort(),
    items: catalog.items.slice(0, 20).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      status: item.status,
      domain: item.domain,
      scenarios: item.scenarios
    }))
  };
}

program
  .command("init")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    console.log(`Initialized knowledge workspace at ${root}`);
  });

program
  .command("index")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action((options: { root?: string }) => {
    const result = rebuildIndex(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("query")
  .requiredOption("--task <task>", "task text")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--domain <domain...>", "domains")
  .option("--scenario <scenario...>", "scenarios")
  .option("--agent-role <role>", "agent role", "main")
  .option("--debug", "include retrieval debug details in JSON output", false)
  .action((options: { task: string; root?: string; domain?: string[]; scenario?: string[]; agentRole: string; debug: boolean }) => {
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? []
    });
    if (options.debug) {
      const { ranked, debug } = queryMemoriesWithDebug(resolveCliRoot(options.root), request);
      const packet = buildContextPacket({ request, ranked });
      console.log(JSON.stringify({ packet, debug }, null, 2));
      return;
    }

    const ranked = queryMemories(resolveCliRoot(options.root), request);
    const packet = buildContextPacket({ request, ranked });
    console.log(JSON.stringify(packet, null, 2));
  });

program
  .command("catalog")
  .description("Build a knowledge catalog and optionally refresh knowledge/_catalog.md")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--no-write", "print catalog JSON without rewriting knowledge/_catalog.md")
  .action(async (options: { root?: string; write: boolean }) => {
    const result = await catalogKnowledge(resolveCliRoot(options.root), { write: options.write });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("write-candidate")
  .requiredOption("--input <file>", "candidate JSON file")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { input: string; root?: string }) => {
    const input = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput;
    const result = await writeCandidateMemory(resolveCliRoot(options.root), input);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list")
  .description("Summarize knowledge files, statuses, domains, and inbox items")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const result = await listKnowledge(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("organize-inbox")
  .description("Plan or apply promotion of knowledge/_inbox Markdown files into typed active directories")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--apply", "move files and activate them; defaults to dry-run", false)
  .option("--no-rebuild", "skip index rebuild after applying changes")
  .action(async (options: { root?: string; apply: boolean; rebuild: boolean }) => {
    const result = await organizeInbox(resolveCliRoot(options.root), {
      apply: options.apply,
      rebuild: options.rebuild
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("capture-material")
  .description("Write user-provided, skill-structured material into active knowledge or inbox")
  .requiredOption("--input <file>", "JSON file containing one candidate object or an array of candidates")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--target <target>", "active or inbox", "active")
  .option("--no-rebuild", "skip index rebuild after writing material")
  .action(async (options: { input: string; root?: string; target: string; rebuild: boolean }) => {
    if (options.target !== "active" && options.target !== "inbox") {
      throw new Error("--target must be either active or inbox");
    }
    const rawInput = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput | CandidateMemoryInput[];
    const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
    const result = await captureMaterial(resolveCliRoot(options.root), inputs, {
      target: options.target,
      rebuild: options.rebuild
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("install-global")
  .description("Build the local package in the current directory and install it globally with npm")
  .option("--package-dir <dir>", "local package directory", process.cwd())
  .option("--skip-build", "skip npm run build before global installation", false)
  .action((options: { packageDir: string; skipBuild: boolean }) => {
    const packageDir = path.resolve(options.packageDir);
    if (!options.skipBuild) {
      execFileSync("npm", ["run", "build"], { cwd: packageDir, stdio: "inherit" });
    }
    execFileSync("npm", ["install", "-g", packageDir], { stdio: "inherit" });
    console.log(`Installed global command from ${packageDir}`);
  });

const hook = program.command("hook").description("Commands intended to be called from TRAE hooks.json templates");

hook
  .command("session-start")
  .description("Initialize AGENT_KNOWLEDGE_ROOT for the TRAE session and provide startup context")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    if (process.env.TRAE_ENV_FILE) {
      await appendFile(process.env.TRAE_ENV_FILE, `AGENT_KNOWLEDGE_ROOT="${root}"\n`, "utf8");
    }
    appendJsonlLog(root, {
      event: "hook.session_start",
      root
    });
    hookContext(
      "SessionStart",
      `Agent Knowledge 已启用。默认知识库 workspace root：${root}。知识文件位于 ${root}/knowledge，索引位于 ${root}/.memory/index.sqlite。`
    );
  });

hook
  .command("user-prompt-submit")
  .description("Query Agent Knowledge for the submitted prompt and return additional context")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    const input = await readHookInput();
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim().length === 0) {
      hookContext("UserPromptSubmit", "Agent Knowledge 未收到用户 prompt，跳过知识检索。");
      return;
    }

    try {
      await initKnowledgeWorkspace(root);
      rebuildIndex(root);
      const catalog = await catalogKnowledge(root, { write: false });
      const request = MemoryQueryRequestSchema.parse({
        task: prompt,
        agentRole: "main"
      });
      const { ranked, debug } = queryMemoriesWithDebug(root, request);
      const packet = buildContextPacket({ request, ranked });
      const hasContext =
        packet.always_apply.length +
          packet.relevant_facts.length +
          packet.procedures.length +
          packet.examples.length +
          packet.warnings.length >
        0;

      appendJsonlLog(root, {
        event: "hook.user_prompt_submit",
        promptLength: prompt.length,
        catalogTotal: catalog.total,
        resultIds: debug.resultIds,
        fallbackUsed: debug.fallbackUsed,
        fallbackSuppressedReason: debug.fallbackSuppressedReason
      });

      hookContext(
        "UserPromptSubmit",
        hasContext
          ? `Agent Knowledge catalog:\n\n${JSON.stringify(compactCatalogForHook(catalog), null, 2)}\n\nAgent Knowledge context packet:\n\n${JSON.stringify(packet, null, 2)}`
          : `Agent Knowledge catalog:\n\n${JSON.stringify(compactCatalogForHook(catalog), null, 2)}\n\nAgent Knowledge 已查询 ${root}，没有命中可注入的 active 知识。可根据 catalog 中的 domains/scenarios 重新选择更精确的查询条件。`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJsonlLog(root, {
        event: "hook.user_prompt_submit.error",
        promptLength: prompt.length,
        message
      });
      hookContext("UserPromptSubmit", `Agent Knowledge 检索失败，主流程可继续。错误：${message}`);
    }
  });

await program.parseAsync(process.argv);
