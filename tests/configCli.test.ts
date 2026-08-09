import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUserConfig, writeUserConfig } from "../src/core/config.js";
import { captureMaterial } from "./helpers/candidate.js";
import { detectProject } from "../src/integration/projects.js";

const execFileAsync = promisify(execFile);
const tsxLoader = path.resolve("node_modules", "tsx", "dist", "loader.mjs");
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function runCli(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync("node", ["--import", tsxLoader, path.resolve("src/cli.ts"), ...args], {
    cwd: environment.TEST_CWD ?? process.cwd(),
    env: {
      ...process.env,
      AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "1",
      ...environment,
      TEST_CWD: undefined
    }
  });
  return result.stdout.trim();
}

describe("CLI user configuration", () => {
  it("prefers explicit root, then user config, then legacy environment", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-config-cli-"));
    tempDirs.push(temp);
    const configPath = path.join(temp, "config.json");
    const configuredRoot = path.join(temp, "configured-root");
    const explicitRoot = path.join(temp, "explicit-root");
    const environmentRoot = path.join(temp, "environment-root");
    writeUserConfig(configPath, resolveUserConfig({ knowledgeRoot: configuredRoot }));

    const configuredOutput = await runCli(["--config", configPath, "init"], {
      AGENT_KNOWLEDGE_ROOT: environmentRoot
    });
    const explicitOutput = await runCli(["--config", configPath, "init", "--root", explicitRoot], {
      AGENT_KNOWLEDGE_ROOT: environmentRoot
    });

    expect(configuredOutput).toContain(configuredRoot);
    expect(explicitOutput).toContain(explicitRoot);
  });

  it("prints the selected config path and fully resolved configuration", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-config-show-"));
    tempDirs.push(temp);
    const configPath = path.join(temp, "config.json");
    writeUserConfig(
      configPath,
      resolveUserConfig({
        knowledgeRoot: path.join(temp, "knowledge"),
        integration: { product: "codex" }
      })
    );

    const printedPath = await runCli(["--config", configPath, "config", "path"]);
    const printedConfig = JSON.parse(
      await runCli(["--config", configPath, "config", "show"])
    ) as { integration: { product: string } };

    expect(printedPath).toBe(configPath);
    expect(printedConfig.integration.product).toBe("codex");
  });

  it("keeps global user config separate from sidecar config options", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-sidecar-config-cli-"));
    tempDirs.push(temp);
    const userConfigPath = path.join(temp, "user.json");
    const root = path.join(temp, "knowledge");
    const sidecarConfigPath = path.join(temp, "sidecar.json");
    writeUserConfig(
      userConfigPath,
      resolveUserConfig({ knowledgeRoot: root })
    );
    await writeFile(
      sidecarConfigPath,
      `${JSON.stringify(
        {
          version: 1,
          id: "sidecar-smoke",
          provider: "hindsight",
          mode: "shadow",
          baseUrl: "http://127.0.0.1:9",
          scope: "smoke",
          endpoints: {
            health: "/health",
            ingest: "/memories",
            search: "/search"
          },
          timeoutMs: 100,
          retry: {
            maxAttempts: 1,
            baseDelayMs: 1,
            maxDelayMs: 1
          },
          polling: { intervalMs: 1, maxAttempts: 1 },
          metadata: {}
        },
        null,
        2
      )}\n`
    );

    const output = JSON.parse(
      await runCli([
        "--config",
        userConfigPath,
        "sidecar",
        "doctor",
        "--config",
        sidecarConfigPath
      ])
    ) as { sidecarId: string; healthy: boolean };

    expect(output).toMatchObject({
      sidecarId: "sidecar-smoke",
      healthy: false
    });
  });

  it("loads project shared and local config above the selected user config", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-project-config-cli-"));
    tempDirs.push(temp);
    const configPath = path.join(temp, "user.json");
    const projectRoot = path.join(temp, "repo");
    const nested = path.join(projectRoot, "nested");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: projectRoot });
    writeUserConfig(
      configPath,
      resolveUserConfig({
        knowledgeRoot: "/global",
        embeddings: { retrieval: "lexical" }
      })
    );
    await writeFile(
      path.join(projectRoot, ".agent-knowledge.json"),
      `${JSON.stringify({
        knowledgeRoot: "/project",
        embeddings: { retrieval: "hybrid" }
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(projectRoot, ".agent-knowledge.local.json"),
      `${JSON.stringify({
        knowledgeRoot: "/project-local",
        embeddings: { graphDepth: 2 }
      })}\n`,
      "utf8"
    );

    const printedConfig = JSON.parse(
      await runCli(["--config", configPath, "config", "show"], {
        AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "0",
        TEST_CWD: nested
      })
    ) as {
      knowledgeRoot: string;
      embeddings: { retrieval: string; graphDepth: number };
    };
    const sources = JSON.parse(
      await runCli(["--config", configPath, "config", "sources"], {
        AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "0",
        TEST_CWD: nested
      })
    ) as {
      project: { path: string; exists: boolean };
      projectLocal: { path: string; exists: boolean };
    };

    expect(printedConfig.knowledgeRoot).toBe("/project-local");
    expect(printedConfig.embeddings).toMatchObject({
      retrieval: "hybrid",
      graphDepth: 2
    });
    expect(sources.project).toEqual({
      path: path.join(realpathSync(projectRoot), ".agent-knowledge.json"),
      exists: true
    });
    expect(sources.projectLocal).toEqual({
      path: path.join(
        realpathSync(projectRoot),
        ".agent-knowledge.local.json"
      ),
      exists: true
    });
  });

  it("renders Chinese help by default and English help with a manual override", async () => {
    const chinese = await runCli(["--help"], {
      LANG: "fr_FR.UTF-8",
      LC_ALL: "",
      LC_MESSAGES: ""
    });
    const english = await runCli(["--locale", "en", "--help"], {
      LANG: "zh_CN.UTF-8"
    });

    expect(chinese).toContain("本地、可读、可审计的 Agent 知识工具");
    expect(chinese).toContain("交互式配置");
    expect(chinese).toContain("常用流程");
    expect(chinese).toContain("source refresh");
    expect(english).toContain("Local human-readable memory toolkit for agents");
    expect(english).toContain("Interactively configure");
    expect(english).toContain("Common workflows");
    expect(english).toContain("source refresh");
  });

  it("documents examples, lifecycle enums, and safety boundaries in command help", async () => {
    const source = await runCli(["source", "--help"]);
    const refresh = await runCli(["source", "refresh", "--help"]);
    const eventAppend = await runCli(["event", "append", "--help"]);
    const sourceMark = await runCli(["source", "mark", "--help"]);
    const ingestGit = await runCli(["ingest", "git", "--help"]);
    const integrationInstall = await runCli([
      "integration",
      "install",
      "--help"
    ]);
    const automationRun = await runCli(["automation", "run", "--help"]);

    expect(source).toContain("推荐日常流程");
    expect(source).toContain("source refresh");
    expect(refresh).toContain("检查 → 按需摄入 → 复查");
    expect(refresh).toContain("--force");
    expect(refresh).toContain("不会自动 fetch Git 远端");
    expect(eventAppend).toContain("support 阶段");
    expect(eventAppend).toContain("initiative 阶段");
    expect(eventAppend).toContain("root_cause");
    expect(eventAppend).toContain("retrospective");
    expect(sourceMark).toContain("refined 需要 active knowledge");
    expect(sourceMark).toContain("duplicate 需要 --duplicate-of");
    expect(ingestGit).toContain("只读取本地 committed blob");
    expect(ingestGit).toContain("不会执行 fetch/pull");
    expect(integrationInstall).toContain("Codex 默认安装 hooks,skills");
    expect(integrationInstall).toContain(".codex/hooks.json");
    expect(integrationInstall).toContain(".agents/skills");
    expect(integrationInstall).toContain("codex plugin marketplace add");
    expect(integrationInstall).toContain("不支持 standalone agents");
    expect(automationRun).toContain("只访问 profile allowlist");
    expect(automationRun).toContain("不批准 inbox");
    expect(automationRun).toContain("notification outbox");
  });

  it("describes user-facing management commands in parent help", async () => {
    const top = await runCli(["--help"]);
    const config = await runCli(["config", "--help"]);
    const sync = await runCli(["sync", "--help"]);
    const staging = await runCli(["staging", "--help"]);
    const subagents = await runCli(["subagents", "--help"]);
    const maintenance = await runCli(["maintenance", "--help"]);
    const graph = await runCli(["graph", "--help"]);
    const integration = await runCli(["integration", "--help"]);
    const automation = await runCli(["automation", "--help"]);
    const notifications = await runCli(["notifications", "--help"]);
    const sidecar = await runCli(["sidecar", "--help"]);
    const sidecarSetup = await runCli(["sidecar", "setup", "--help"]);
    const sidecarCompare = await runCli(["sidecar", "compare", "--help"]);
    const sidecarHistory = await runCli(["sidecar", "history", "--help"]);

    expect(top).toContain("把单个候选 JSON 安全写入");
    expect(top).toContain("全局 --config/--locale/--json 必须放在子命令之前");
    expect(config).toContain("显示用户配置文件路径");
    expect(config).toContain("显示分层合并后的生效配置");
    expect(sync).toContain("显式 WebDAV 参数");
    expect(sync).toContain("显式 S3 参数");
    expect(staging).toContain("汇总待消费 staging 事件");
    expect(subagents).toContain("读取本地详细 Subagent 调试日志");
    expect(maintenance).toContain("接受 proposal 并写入知识或 Skill inbox");
    expect(graph).toContain("有限深度子图");
    expect(integration).toContain("结构化安装 hooks");
    expect(integration).toContain("检查产品接入是否完整");
    expect(automation).toContain("运行有界来源刷新");
    expect(notifications).toContain("后台通知 outbox");
    expect(sidecar).toContain("Hindsight、memU、Mem0");
    expect(sidecarSetup).toContain("一条命令");
    expect(sidecarSetup).toContain("不拉镜像、不启动服务、不写真实凭据");
    expect(sidecarCompare).toContain("native_memory_id");
    expect(sidecarCompare).toContain("abstention failure");
    expect(sidecarHistory).toContain("历次 native/sidecar 比较指标");
  });

  it("documents graph retrieval modes and traversal controls in query help", async () => {
    const chinese = await runCli(["query", "--help"]);

    expect(chinese).toContain("lexical、hybrid、graph 或 hybrid-graph");
    expect(chinese).toContain("--graph-depth");
    expect(chinese).toContain("--graph-decay");
  });

  it("prints knowledge audit findings and fails only at the configured severity", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-audit-cli-")
    );
    tempDirs.push(temp);
    await import("node:fs/promises").then(({ cp }) =>
      cp("tests/fixtures/basic-knowledge", temp, { recursive: true })
    );

    const report = JSON.parse(
      await runCli([
        "knowledge",
        "audit",
        "--root",
        temp,
        "--fail-on",
        "never"
      ])
    ) as {
      summary: { knowledgeDocuments: number };
      findings: Array<{ severity: string }>;
    };
    expect(report.summary.knowledgeDocuments).toBe(2);
    expect(report.findings.some((finding) => finding.severity === "warning")).toBe(
      true
    );

    await expect(
      execFileAsync(
        "node",
        [
          "--import",
          tsxLoader,
          path.resolve("src/cli.ts"),
          "knowledge",
          "audit",
          "--root",
          temp,
          "--fail-on",
          "warning"
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "1"
          }
        }
      )
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"knowledge_body_too_thin"')
    });
  });

  it("initializes and reports a separate Git knowledge workspace", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-workspace-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "data");

    const initialized = JSON.parse(
      await runCli(["workspace", "git-init", "--root", root])
    ) as { initialized: boolean; rootDir: string };
    const status = JSON.parse(
      await runCli(["workspace", "git-status", "--root", root])
    ) as {
      isGit: boolean;
      remote: string | null;
      trackedKnowledgeFiles: number;
    };

    expect(initialized).toEqual({
      initialized: true,
      rootDir: root
    });
    expect(status).toMatchObject({
      isGit: true,
      remote: null,
      trackedKnowledgeFiles: 0
    });
  });

  it("stores, restores, and deletes encrypted Vault evidence without printing plaintext", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-vault-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const output = path.join(temp, "restored.txt");
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 5).toString("base64")
    };

    const initialized = JSON.parse(
      await runCli(["vault", "init", "--root", root], environment)
    ) as { initialized: boolean; keyId: string };
    const putStdout = await runCli(
      [
        "vault",
        "put",
        "--root",
        root,
        "--text",
        "complete private transcript",
        "--content-type",
        "text/plain"
      ],
      environment
    );
    const stored = JSON.parse(putStdout) as { id: string };
    const status = JSON.parse(
      await runCli(["vault", "status", "--root", root], environment)
    ) as { objects: number; keyAvailable: boolean };
    const restored = JSON.parse(
      await runCli(
        [
          "vault",
          "get",
          stored.id,
          "--root",
          root,
          "--output",
          output
        ],
        environment
      )
    ) as { outputPath: string };
    const deleted = JSON.parse(
      await runCli(
        [
          "vault",
          "delete",
          stored.id,
          "--root",
          root,
          "--reason",
          "test cleanup"
        ],
        environment
      )
    ) as { deleted: boolean };

    expect(initialized.initialized).toBe(true);
    expect(initialized.keyId).toMatch(/^key_[a-f0-9]{16}$/);
    expect(putStdout).not.toContain("complete private transcript");
    expect(status).toMatchObject({ objects: 1, keyAvailable: true });
    expect(restored.outputPath).toBe(output);
    expect(await import("node:fs/promises").then(({ readFile }) =>
      readFile(output, "utf8")
    )).toBe("complete private transcript");
    expect(deleted.deleted).toBe(true);
    await expect(
      runCli(
        [
          "vault",
          "get",
          stored.id,
          "--root",
          root,
          "--output",
          path.join(temp, "missing.txt")
        ],
        environment
      )
    ).rejects.toThrow();
  });

  it("incrementally ingests transcript files without printing or persisting private values", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-ingest-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const transcripts = path.join(temp, "transcripts");
    const privateEmail = "owner@example.com";
    const privatePhone = "13800138000";
    const privateToken = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 6).toString("base64")
    };
    await mkdir(transcripts, { recursive: true });
    await writeFile(
      path.join(transcripts, `session-${privateEmail}.jsonl`),
      [
        JSON.stringify({ role: "user", email: privateEmail, phone: privatePhone }),
        JSON.stringify({ role: "tool", token: privateToken })
      ].join("\n"),
      "utf8"
    );

    const firstStdout = await runCli(
      [
        "ingest",
        "transcripts",
        "--root",
        root,
        "--connector-id",
        "trae-sessions",
        "--base-dir",
        transcripts,
        "--project-key",
        "github.com/example/support"
      ],
      environment
    );
    const first = JSON.parse(firstStdout) as {
      completed: number;
      skipped: number;
      jobs: Array<{
        sourceManifestPath: string;
        redactions: Record<string, number>;
      }>;
    };
    const manifestText = await readFile(
      first.jobs[0]!.sourceManifestPath,
      "utf8"
    );
    const persistedOutput = `${firstStdout}\n${manifestText}`;

    expect(first).toMatchObject({
      completed: 1,
      skipped: 0,
      jobs: [
        {
          redactions: {
            openai_style_key: 1,
            phone: 1,
            email: 1
          }
        }
      ]
    });
    expect(persistedOutput).not.toContain(privateEmail);
    expect(persistedOutput).not.toContain(privatePhone);
    expect(persistedOutput).not.toContain(privateToken);
    expect(manifestText).toContain("[REDACTED_EMAIL]");
    expect(manifestText).not.toContain("[REDACTED_PHONE]");
    expect(manifestText).not.toContain("[REDACTED_SECRET]");

    const second = JSON.parse(
      await runCli(
        [
          "ingest",
          "transcripts",
          "--root",
          root,
          "--connector-id",
          "trae-sessions",
          "--base-dir",
          transcripts,
          "--project-key",
          "github.com/example/support"
        ],
        environment
      )
    ) as { completed: number; skipped: number };
    expect(second).toMatchObject({ completed: 0, skipped: 1 });
  });

  it("ingests committed Git documents with remote, commit, and path hashes", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-ingest-git-cli-")
    );
    tempDirs.push(temp);
    const repository = path.join(temp, "repository");
    const root = path.join(temp, "workspace");
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 18).toString("base64")
    };
    await mkdir(path.join(repository, "docs"), { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main"], {
      cwd: repository
    });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repository
    });
    await execFileAsync("git", ["config", "user.name", "CLI Test"], {
      cwd: repository
    });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "git@github.com:Example/Business.git"],
      { cwd: repository }
    );
    await writeFile(
      path.join(repository, "docs", "guide.md"),
      "# Guide\n\nCommitted business workflow.\n",
      "utf8"
    );
    await execFileAsync("git", ["add", "docs/guide.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "docs: add guide"], {
      cwd: repository
    });

    const first = JSON.parse(
      await runCli(
        [
          "ingest",
          "git",
          "--root",
          root,
          "--connector-id",
          "business-repository",
          "--repository",
          repository,
          "--pathspec",
          "docs"
        ],
        environment
      )
    ) as {
      completed: number;
      jobs: Array<{ sourceManifestPath: string }>;
    };
    const manifest = JSON.parse(
      await readFile(first.jobs[0]!.sourceManifestPath, "utf8")
    ) as {
      schema_version: number;
      artifact_kind: string;
      project_keys: string[];
      version: {
        upstream: { commit_sha?: string; path_hash?: string };
      };
    };

    expect(first.completed).toBe(1);
    expect(manifest).toMatchObject({
      schema_version: 5,
      artifact_kind: "repository",
      project_keys: ["github.com/example/business"]
    });
    expect(manifest.version.upstream.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.version.upstream.path_hash).toMatch(/^[a-f0-9]{40}$/);

    const second = JSON.parse(
      await runCli(
        [
          "ingest",
          "git",
          "--root",
          root,
          "--connector-id",
          "business-repository",
          "--repository",
          repository,
          "--pathspec",
          "docs"
        ],
        environment
      )
    ) as {
      completed: number;
      skipped: number;
      jobs: Array<{ classification: string }>;
    };
    expect(second).toMatchObject({ completed: 0, skipped: 1 });
    expect(second.jobs[0]?.classification).toBe("unchanged");
  });

  it("reviews and exports versioned sources without printing complete evidence", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-review-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const sources = path.join(temp, "sources");
    const output = path.join(temp, "review", "source.md");
    const completeEvidence =
      "# Account\n\nComplete evidence body with internal workflow.";
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 22).toString("base64")
    };
    await mkdir(sources, { recursive: true });
    await writeFile(
      path.join(sources, "account.md"),
      completeEvidence,
      "utf8"
    );
    const ingested = JSON.parse(
      await runCli(
        [
          "ingest",
          "files",
          "--root",
          root,
          "--connector-id",
          "business-docs",
          "--base-dir",
          sources,
          "--pattern",
          "**/*.md",
          "--project-key",
          "github.com/example/business"
        ],
        environment
      )
    ) as {
      jobs: Array<{ sourceId: string }>;
    };
    const sourceId = ingested.jobs[0]!.sourceId;
    const listed = JSON.parse(
      await runCli(
        ["source", "list", "--root", root, "--needs-review"],
        environment
      )
    ) as {
      total: number;
      inventory: { incompleteConnectors: number; unresolved: number };
    };
    const showStdout = await runCli(
      ["source", "show", sourceId, "--root", root],
      environment
    );
    const shown = JSON.parse(showStdout) as {
      expectedFingerprint: string;
      reviewToken: string;
    };
    const exportStdout = await runCli(
      [
        "source",
        "export",
        sourceId,
        "--root",
        root,
        "--fingerprint",
        shown.expectedFingerprint,
        "--output",
        output
      ],
      environment
    );
    const marked = JSON.parse(
      await runCli(
        [
          "source",
          "mark",
          sourceId,
          "--root",
          root,
          "--fingerprint",
          shown.expectedFingerprint,
          "--review-token",
          shown.reviewToken,
          "--status",
          "blocked",
          "--reason",
          "等待业务 owner 确认"
        ],
        environment
      )
    ) as { processingStatus: string; reviewState: string };

    expect(listed.total).toBe(1);
    expect(showStdout).not.toContain(completeEvidence);
    expect(exportStdout).not.toContain(completeEvidence);
    expect(await readFile(output, "utf8")).toBe(completeEvidence);
    expect(marked).toMatchObject({
      processingStatus: "blocked",
      reviewState: "current"
    });
    await expect(
      runCli(
        [
          "source",
          "mark",
          sourceId,
          "--root",
          root,
          "--fingerprint",
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--review-token",
          shown.reviewToken,
          "--status",
          "blocked",
          "--reason",
          "stale review"
        ],
        environment
      )
    ).rejects.toThrow();
  });

  it("ingests a complete offline Lark export into the source review queue", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-export-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const exportDir = path.join(temp, "lark-export");
    const documentDir = path.join(exportDir, "account-guide");
    const content =
      '<h1>账号体系</h1><p>商业化 UID 与抖音 UID 属于不同账号组。</p><p>password=private-password</p>';
    const contentHash = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(content).digest("hex")
    );
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 24).toString("base64")
    };
    await mkdir(documentDir, { recursive: true });
    await writeFile(path.join(documentDir, "content.xml"), content, "utf8");
    await writeFile(
      path.join(exportDir, "manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-08-09T00:00:00.000Z",
          roots: ["wiki:root"],
          documents: {
            "wiki:account": {
              key: "wiki:account",
              title: "账号指南",
              objType: "docx",
              revisionId: 17,
              upstreamUpdatedAt: "2026-08-08T12:00:00.000Z",
              observedAt: "2026-08-09T00:00:00.000Z",
              directory: "account-guide",
              contentHash
            }
          },
          resources: {},
          failures: {},
          complete: true,
          pending: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const stdout = await runCli(
      [
        "ingest",
        "lark-export",
        "--root",
        root,
        "--connector-id",
        "lark-business",
        "--export-dir",
        exportDir,
        "--project-key",
        "github.com/example/business"
      ],
      environment
    );
    const result = JSON.parse(stdout) as {
      completed: number;
      jobs: Array<{ sourceManifestPath: string }>;
    };
    const sourceManifest = JSON.parse(
      await readFile(result.jobs[0]!.sourceManifestPath, "utf8")
    ) as {
      connector: string;
      external_key: string;
      project_keys: string[];
      redaction_policy: string;
      version: { upstream: { revision?: string; path_hash?: string } };
    };
    const queue = JSON.parse(
      await runCli(
        ["source", "list", "--root", root, "--needs-review"],
        environment
      )
    ) as {
      total: number;
      inventory: {
        incompleteConnectors: number;
        unresolved: number;
        failedSources: number;
        connectors: Array<{
          connectorId: string;
          mode: string;
          complete: boolean;
          unresolved: number;
          failedSources: number;
        }>;
      };
    };

    expect(result.completed).toBe(1);
    expect(stdout).not.toContain("private-password");
    expect(sourceManifest).toMatchObject({
      connector: "lark-business",
      external_key: "wiki:account",
      project_keys: ["github.com/example/business"],
      redaction_policy: "secrets-and-pii"
    });
    expect(sourceManifest.version.upstream.revision).toBe("17");
    expect(sourceManifest.version.upstream.path_hash).toBe(contentHash);
    expect(queue.total).toBe(1);
    expect(queue.inventory).toEqual({
      incompleteConnectors: 0,
      unresolved: 0,
      failedSources: 0,
      connectors: [
        {
          connectorId: "lark-business",
          mode: "complete",
          complete: true,
          unresolved: 0,
          failedSources: 0
        }
      ]
    });
  });

  it("registers ingestion sources and checks updates without reading Vault payloads", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-check-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const sourceDir = path.join(temp, "business-docs");
    const sourceFile = path.join(sourceDir, "guide.md");
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 31).toString("base64")
    };
    await mkdir(sourceDir, { recursive: true });
    await writeFile(sourceFile, "# Guide\n\nVersion one.\n", "utf8");

    const first = JSON.parse(
      await runCli(
        [
          "ingest",
          "files",
          "--root",
          root,
          "--connector-id",
          "business-docs",
          "--base-dir",
          sourceDir,
          "--pattern",
          "**/*.md",
          "--project-key",
          "github.com/example/business"
        ],
        environment
      )
    ) as {
      completed: number;
      jobs: Array<{ sourceManifestPath: string; vaultObject: string }>;
      registration: {
        connectorId: string;
        kind: string;
        path: string;
      };
    };
    const registrationPath = path.join(root, first.registration.path);
    const manifestPath = first.jobs[0]!.sourceManifestPath;
    const beforeCheck = await readFile(manifestPath, "utf8");

    expect(first.completed).toBe(1);
    expect(first.registration).toEqual({
      connectorId: "business-docs",
      kind: "files",
      path: expect.stringContaining(
        ".memory/ingestion/connectors/"
      )
    });
    expect((await stat(registrationPath)).mode & 0o777).toBe(0o600);

    const unchanged = JSON.parse(
      await runCli([
        "source",
        "check",
        "--root",
        root,
        "--connector-id",
        "business-docs"
      ])
    ) as {
      networkAccess: string;
      summary: {
        connectors: number;
        updatesAvailable: number;
        verificationRequired: number;
        errors: number;
      };
      reports: Array<{
        freshnessBoundary: string;
        summary: { unchanged: number };
      }>;
    };

    expect(unchanged).toMatchObject({
      networkAccess: "none",
      summary: {
        connectors: 1,
        updatesAvailable: 0,
        verificationRequired: 0,
        errors: 0
      }
    });
    expect(unchanged.reports[0]).toMatchObject({
      freshnessBoundary: "local-filesystem",
      summary: { unchanged: 1 }
    });
    expect(await readFile(manifestPath, "utf8")).toBe(beforeCheck);

    await writeFile(
      sourceFile,
      "# Guide\n\nVersion two with a changed workflow.\n",
      "utf8"
    );
    const changed = JSON.parse(
      await runCli([
        "source",
        "check",
        "--root",
        root,
        "--connector-id",
        "business-docs"
      ])
    ) as {
      summary: {
        updatesAvailable: number;
        verificationRequired: number;
      };
      reports: Array<{
        summary: { update_unknown: number };
        items: Array<{ state: string }>;
      }>;
    };

    expect(changed.summary).toMatchObject({
      updatesAvailable: 0,
      verificationRequired: 1
    });
    expect(changed.reports[0]).toMatchObject({
      summary: { update_unknown: 1 }
    });
    expect(changed.reports[0]?.items[0]?.state).toBe("update_unknown");
    expect(await readFile(manifestPath, "utf8")).toBe(beforeCheck);

    await expect(
      execFileAsync(
        "node",
        [
          "--import",
          tsxLoader,
          path.resolve("src/cli.ts"),
          "source",
          "check",
          "--root",
          root,
          "--connector-id",
          "business-docs",
          "--fail-on-updates"
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "1"
          }
        }
      )
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"verificationRequired": 1')
    });

    const refreshed = JSON.parse(
      await runCli(
        [
          "ingest",
          "files",
          "--root",
          root,
          "--connector-id",
          "business-docs",
          "--base-dir",
          sourceDir,
          "--pattern",
          "**/*.md",
          "--project-key",
          "github.com/example/business"
        ],
        environment
      )
    ) as { jobs: Array<{ classification: string }> };
    const current = JSON.parse(
      await runCli([
        "source",
        "check",
        "--root",
        root,
        "--connector-id",
        "business-docs"
      ])
    ) as {
      reports: Array<{ summary: { unchanged: number } }>;
    };

    expect(refreshed.jobs[0]?.classification).toBe("content_changed");
    expect(current.reports[0]?.summary.unchanged).toBe(1);
  });

  it("refreshes registered sources without repeating connector scope arguments", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-refresh-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const sourceDir = path.join(temp, "business-docs");
    const sourceFile = path.join(sourceDir, "guide.md");
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 27).toString("base64")
    };
    await mkdir(sourceDir, { recursive: true });
    await writeFile(sourceFile, "# Guide\n\nVersion one.\n", "utf8");
    await runCli(
      [
        "ingest",
        "files",
        "--root",
        root,
        "--connector-id",
        "daily-business-docs",
        "--base-dir",
        sourceDir,
        "--pattern",
        "**/*.md",
        "--project-key",
        "github.com/example/business"
      ],
      environment
    );
    await writeFile(
      sourceFile,
      "# Guide\n\nVersion two with a daily update.\n",
      "utf8"
    );

    const refreshed = JSON.parse(
      await runCli(
        [
          "source",
          "refresh",
          "--root",
          root,
          "--connector-id",
          "daily-business-docs"
        ],
        environment
      )
    ) as {
      summary: {
        connectors: number;
        refreshed: number;
        unchanged: number;
        errors: number;
      };
      results: Array<{
        connectorId: string;
        action: string;
        ingestion?: { classifications: Record<string, number> };
        after?: { summary: { unchanged: number } };
      }>;
    };

    expect(refreshed.summary).toEqual({
      connectors: 1,
      refreshed: 1,
      unchanged: 0,
      errors: 0
    });
    expect(refreshed.results[0]).toMatchObject({
      connectorId: "daily-business-docs",
      action: "refreshed",
      ingestion: {
        classifications: { content_changed: 1 }
      },
      after: {
        summary: { unchanged: 1 }
      }
    });

    const skipped = JSON.parse(
      await runCli(
        [
          "source",
          "refresh",
          "--root",
          root,
          "--connector-id",
          "daily-business-docs"
        ]
      )
    ) as {
      summary: { refreshed: number; unchanged: number };
      results: Array<{ action: string }>;
    };
    expect(skipped.summary).toMatchObject({
      refreshed: 0,
      unchanged: 1
    });
    expect(skipped.results[0]?.action).toBe("unchanged");
  });

  it("records support and initiative event timelines with encrypted payloads", async () => {
    const temp = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-event-cli-")
    );
    tempDirs.push(temp);
    const root = path.join(temp, "workspace");
    const payload = path.join(temp, "support-payload.json");
    const output = path.join(temp, "exports", "support-payload.json");
    const privateEmail = "owner@example.com";
    const privatePhone = "13800138000";
    const environment = {
      AGENT_KNOWLEDGE_VAULT_KEY: Buffer.alloc(32, 26).toString("base64")
    };
    await writeFile(
      payload,
      JSON.stringify({
        question: "登录失败",
        email: privateEmail,
        phone: privatePhone
      }),
      "utf8"
    );

    const appendStdout = await runCli(
      [
        "event",
        "append",
        "--root",
        root,
        "--stream-type",
        "support",
        "--stream-id",
        "case_login_001",
        "--stage",
        "intake",
        "--event-type",
        "customer_question",
        "--summary",
        `客户 ${privateEmail} 反馈手机号 ${privatePhone} 登录失败`,
        "--payload",
        payload,
        "--content-type",
        "application/json",
        "--project-key",
        "github.com/example/support",
        "--actor-type",
        "customer",
        "--capture-mode",
        "automated_session",
        "--idempotency-key",
        "message-001"
      ],
      environment
    );
    const appended = JSON.parse(appendStdout) as { eventId: string };
    const timelineStdout = await runCli(
      [
        "event",
        "timeline",
        "support",
        "case_login_001",
        "--root",
        root
      ],
      environment
    );
    const timeline = JSON.parse(timelineStdout) as {
      status: string;
      integrity: { valid: boolean };
      events: Array<{ summary: string }>;
    };
    const exportStdout = await runCli(
      [
        "event",
        "export",
        appended.eventId,
        "--root",
        root,
        "--output",
        output
      ],
      environment
    );
    const status = JSON.parse(
      await runCli(["event", "status", "--root", root], environment)
    ) as { streams: number; events: number };
    const listed = JSON.parse(
      await runCli(
        [
          "event",
          "list",
          "--root",
          root,
          "--stream-type",
          "support",
          "--project-key",
          "github.com/example/support"
        ],
        environment
      )
    ) as { total: number };

    expect(appendStdout).not.toContain(privateEmail);
    expect(appendStdout).not.toContain(privatePhone);
    expect(timelineStdout).not.toContain(privateEmail);
    expect(timelineStdout).not.toContain(privatePhone);
    expect(exportStdout).not.toContain("登录失败");
    expect(await readFile(output, "utf8")).toContain("[REDACTED_EMAIL]");
    expect(await readFile(output, "utf8")).toContain("[REDACTED_PHONE]");
    expect(timeline).toMatchObject({
      status: "active",
      integrity: { valid: true }
    });
    expect(timeline.events[0]?.summary).toContain("[REDACTED_EMAIL]");
    expect(status).toEqual({
      streams: 1,
      events: 1,
      payloadBackedEvents: 1,
      missingPayloads: 0,
      byStreamType: { support: 1, initiative: 0 },
      byStatus: { active: 1 }
    });
    expect(listed.total).toBe(1);
  });

  it("automatically scopes query to the current Git project unless project IDs are explicit", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-project-"));
    tempDirs.push(temp);
    const projectRoot = path.join(temp, "repo");
    const nested = path.join(projectRoot, "packages", "app");
    const knowledgeRoot = path.join(temp, "knowledge-root");
    const configPath = path.join(temp, "missing-config.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: projectRoot });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "git@github.com:Example/Scoped-Repo.git"],
      { cwd: projectRoot }
    );
    const project = await detectProject(knowledgeRoot, nested);
    await captureMaterial(
      knowledgeRoot,
      [
        {
          id: "k_project_scoped_query_marker",
          title: "项目专用检索标记",
          aliases: ["alpha-scope-marker"],
          memory_type: "semantic",
          domain: "project/query-scope",
          related_domains: [],
          scenario: ["project-query"],
          tags: ["project-scope"],
          confidence: 0.95,
          source_authority: "user_confirmed",
          summary: "只有当前 Git 项目可以检索这条知识。",
          evidence: ["test:project-scope"],
          project_keys: [project.key]
        }
      ],
      { target: "active", rebuild: true }
    );

    const automatic = JSON.parse(
      await runCli(
        [
          "--config",
          configPath,
          "query",
          "--root",
          knowledgeRoot,
          "--task",
          "alpha-scope-marker",
          "--retrieval",
          "lexical"
        ],
        { TEST_CWD: nested }
      )
    ) as { claims: Array<{ id: string }> };
    const explicitOther = JSON.parse(
      await runCli(
        [
          "--config",
          configPath,
          "query",
          "--root",
          knowledgeRoot,
          "--task",
          "alpha-scope-marker",
          "--retrieval",
          "lexical",
          "--project",
          "github.com/example/project-other"
        ],
        { TEST_CWD: nested }
      )
    ) as { claims: Array<{ id: string }> };

    expect(automatic.claims.map((item) => item.id)).toContain(
      "k_project_scoped_query_marker"
    );
    expect(explicitOther.claims).toEqual([]);
  });
});
