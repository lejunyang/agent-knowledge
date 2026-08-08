import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        integration: { product: "trae-cn" }
      })
    );

    const printedPath = await runCli(["--config", configPath, "config", "path"]);
    const printedConfig = JSON.parse(
      await runCli(["--config", configPath, "config", "show"])
    ) as { integration: { product: string } };

    expect(printedPath).toBe(configPath);
    expect(printedConfig.integration.product).toBe("trae-cn");
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
    expect(english).toContain("Local human-readable memory toolkit for agents");
    expect(english).toContain("Interactively configure");
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
          transcripts
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
    ) as { total: number };
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
