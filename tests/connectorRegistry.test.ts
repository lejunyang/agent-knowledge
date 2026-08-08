import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemConnector } from "../src/ingestion/filesystem.js";
import { GitRepositoryConnector } from "../src/ingestion/gitRepository.js";
import { LarkExportConnector } from "../src/ingestion/larkExport.js";
import {
  createConnectorFromRegistration,
  getConnectorRegistrationPath,
  listConnectorRegistrations,
  readConnectorRegistration,
  registerConnector
} from "../src/ingestion/registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

describe("connector registry", () => {
  it("persists strict 0600 registrations and recreates built-in connectors", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-connector-registry-")
    );
    tempDirs.push(root);
    const repositoryDir = path.join(root, "repositories", "business");

    const registered = await registerConnector(
      root,
      {
        kind: "git",
        connectorId: "business-repository",
        redactionPolicy: "secrets-only",
        options: {
          repositoryDir,
          ref: "HEAD",
          pathspecs: ["README.md", "docs"],
          projectKey: "github.com/example/business"
        }
      },
      { inventoryIdentity: `git_inventory_${"a".repeat(64)}` }
    );

    expect(registered.created).toBe(true);
    expect(registered.path).toBe(
      getConnectorRegistrationPath(root, "business-repository")
    );
    expect((await stat(registered.path)).mode & 0o777).toBe(0o600);
    expect(registered.record).toMatchObject({
      version: 1,
      kind: "git",
      connectorId: "business-repository",
      redactionPolicy: "secrets-only",
      inventoryIdentity: `git_inventory_${"a".repeat(64)}`,
      options: {
        repositoryDir: path.resolve(repositoryDir),
        ref: "HEAD",
        pathspecs: ["README.md", "docs"],
        projectKey: "github.com/example/business"
      }
    });
    expect(registered.record.scopeFingerprint).toMatch(
      /^scope_sha256_[a-f0-9]{64}$/
    );
    expect(await listConnectorRegistrations(root)).toHaveLength(1);
    expect(
      createConnectorFromRegistration(registered.record)
    ).toBeInstanceOf(GitRepositoryConnector);
  });

  it("updates movable complete-inventory paths only when identity remains stable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-connector-move-")
    );
    tempDirs.push(root);
    const identity = `lark_inventory_${"b".repeat(64)}`;
    const first = await registerConnector(
      root,
      {
        kind: "lark-export",
        connectorId: "lark-business",
        redactionPolicy: "secrets-and-pii",
        options: {
          exportDir: path.join(root, "exports", "snapshot-one"),
          projectKeys: ["github.com/example/business"]
        }
      },
      { inventoryIdentity: identity }
    );
    const second = await registerConnector(
      root,
      {
        kind: "lark-export",
        connectorId: "lark-business",
        redactionPolicy: "secrets-and-pii",
        options: {
          exportDir: path.join(root, "exports", "snapshot-two"),
          projectKeys: ["github.com/example/business"]
        }
      },
      { inventoryIdentity: identity }
    );

    expect(second.created).toBe(false);
    expect(second.record.registeredAt).toBe(first.record.registeredAt);
    expect(second.record.options).toMatchObject({
      exportDir: path.resolve(root, "exports", "snapshot-two")
    });
    expect(
      createConnectorFromRegistration(second.record)
    ).toBeInstanceOf(LarkExportConnector);

    await expect(
      registerConnector(
        root,
        {
          kind: "lark-export",
          connectorId: "lark-business",
          redactionPolicy: "secrets-and-pii",
          options: {
            exportDir: path.join(root, "exports", "other-scope"),
            projectKeys: ["github.com/example/other"]
          }
        },
        { inventoryIdentity: `lark_inventory_${"c".repeat(64)}` }
      )
    ).rejects.toThrow(/scope changed/);
  });

  it("rejects filesystem scope changes and never accepts credential fields", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-connector-scope-")
    );
    tempDirs.push(root);
    await registerConnector(root, {
      kind: "files",
      connectorId: "business-docs",
      redactionPolicy: "secrets-only",
      options: {
        baseDir: path.join(root, "exports", "business"),
        patterns: ["**/*.md"],
        artifactKind: "document",
        projectKeys: ["github.com/example/business"]
      }
    });

    await expect(
      registerConnector(root, {
        kind: "files",
        connectorId: "business-docs",
        redactionPolicy: "secrets-only",
        options: {
          baseDir: path.join(root, "exports", "other"),
          patterns: ["**/*.md"],
          artifactKind: "document",
          projectKeys: ["github.com/example/business"]
        }
      })
    ).rejects.toThrow(/scope changed/);

    await expect(
      registerConnector(root, {
        kind: "files",
        connectorId: "invalid-secret",
        redactionPolicy: "secrets-only",
        options: {
          baseDir: path.join(root, "exports", "business"),
          patterns: ["**/*.md"],
          artifactKind: "document",
          projectKeys: [],
          token: "must-not-persist"
        }
      } as never)
    ).rejects.toThrow();

    const record = await readConnectorRegistration(root, "business-docs");
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain("must-not-persist");
    expect(createConnectorFromRegistration(record!)).toBeInstanceOf(
      FileSystemConnector
    );
  });

  it("forces transcript redaction and returns registrations in connector order", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-connector-transcript-")
    );
    tempDirs.push(root);
    await registerConnector(root, {
      kind: "transcripts",
      connectorId: "z-sessions",
      redactionPolicy: "secrets-and-pii",
      options: {
        baseDir: path.join(root, "sessions"),
        patterns: ["**/*.jsonl"],
        projectKeys: []
      }
    });
    await registerConnector(root, {
      kind: "files",
      connectorId: "a-docs",
      redactionPolicy: "secrets-and-pii",
      options: {
        baseDir: path.join(root, "docs"),
        patterns: ["**/*.txt"],
        artifactKind: "document",
        projectKeys: []
      }
    });

    expect(
      (await listConnectorRegistrations(root)).map(
        (registration) => registration.connectorId
      )
    ).toEqual(["a-docs", "z-sessions"]);
    await expect(
      registerConnector(root, {
        kind: "transcripts",
        connectorId: "weak-sessions",
        redactionPolicy: "secrets-only",
        options: {
          baseDir: path.join(root, "sessions"),
          patterns: ["**/*.jsonl"],
          projectKeys: []
        }
      } as never)
    ).rejects.toThrow();
  });
});
