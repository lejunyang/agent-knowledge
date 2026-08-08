import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteVaultObject,
  getVaultObject,
  getVaultObjectPath,
  getVaultStatus,
  getVaultTombstonePath,
  initializeVault,
  parseVaultKey,
  putVaultObject,
  vaultKeyFromEnvironment,
  writeVaultObjectToFile
} from "../src/vault/core.js";

const tempDirs: string[] = [];
const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

describe("Evidence Vault", () => {
  it("parses configured keys and rejects invalid lengths", () => {
    expect(parseVaultKey(key.toString("hex"))).toEqual(key);
    expect(parseVaultKey(key.toString("base64"))).toEqual(key);
    expect(
      vaultKeyFromEnvironment("CUSTOM_VAULT_KEY", {
        CUSTOM_VAULT_KEY: key.toString("base64")
      })
    ).toEqual(key);
    expect(() => parseVaultKey("too-short")).toThrow(/32 bytes/);
    expect(() => vaultKeyFromEnvironment("MISSING", {})).toThrow(/MISSING/);
  });

  it("encrypts complete evidence, deduplicates by plaintext, and decrypts safely", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-vault-"));
    tempDirs.push(root);
    const plaintext = Buffer.from(
      "完整客服对话：用户反馈登录失败，工具查询返回 root cause。",
      "utf8"
    );
    const first = await putVaultObject(
      root,
      { bytes: plaintext, contentType: "application/json" },
      { key, actor: "test" }
    );
    const second = await putVaultObject(
      root,
      { bytes: plaintext, contentType: "application/json" },
      { key, actor: "test" }
    );
    const rawEnvelope = await readFile(first.objectPath, "utf8");
    const restored = await getVaultObject(root, first.id, {
      key,
      actor: "test"
    });

    expect(first.id).toMatch(/^vault_sha256_[a-f0-9]{64}$/);
    expect(first.deduplicated).toBe(false);
    expect(second).toMatchObject({
      id: first.id,
      deduplicated: true
    });
    expect(rawEnvelope).not.toContain(plaintext.toString("utf8"));
    expect(restored.bytes).toEqual(plaintext);
    expect(restored.contentType).toBe("application/json");
  });

  it("rejects wrong keys and authenticated ciphertext tampering", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-vault-integrity-")
    );
    tempDirs.push(root);
    const stored = await putVaultObject(
      root,
      { bytes: Buffer.from("sensitive evidence"), contentType: "text/plain" },
      { key }
    );

    await expect(
      getVaultObject(root, stored.id, { key: otherKey })
    ).rejects.toThrow(/key mismatch/);

    const envelope = JSON.parse(
      await readFile(stored.objectPath, "utf8")
    ) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    envelope.ciphertext = ciphertext.toString("base64");
    await writeFile(
      stored.objectPath,
      `${JSON.stringify(envelope)}\n`,
      "utf8"
    );
    await expect(getVaultObject(root, stored.id, { key })).rejects.toThrow(
      /authentication failed/
    );
  });

  it("writes decrypted output with restricted permissions and refuses overwrite by default", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-vault-output-")
    );
    tempDirs.push(root);
    const stored = await putVaultObject(
      root,
      { bytes: Buffer.from("complete document"), contentType: "text/markdown" },
      { key }
    );
    const output = path.join(root, "exports", "document.md");
    const result = await writeVaultObjectToFile(
      root,
      { id: stored.id, outputPath: output },
      { key }
    );
    const outputStat = await stat(output);

    expect(result.outputPath).toBe(output);
    expect(await readFile(output, "utf8")).toBe("complete document");
    expect(outputStat.mode & 0o777).toBe(0o600);
    await expect(
      writeVaultObjectToFile(
        root,
        { id: stored.id, outputPath: output },
        { key }
      )
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("physically deletes ciphertext, writes a tombstone, and blocks silent resurrection", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-vault-delete-")
    );
    tempDirs.push(root);
    const plaintext = Buffer.from("delete me");
    const stored = await putVaultObject(
      root,
      { bytes: plaintext, contentType: "text/plain" },
      { key }
    );
    const deleted = await deleteVaultObject(
      root,
      stored.id,
      { reason: "retention expired" },
      { key, actor: "owner" }
    );

    expect(deleted.deleted).toBe(true);
    await expect(stat(getVaultObjectPath(root, stored.id))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
    const tombstone = JSON.parse(
      await readFile(getVaultTombstonePath(root, stored.id), "utf8")
    ) as Record<string, unknown>;
    expect(tombstone).not.toHaveProperty("reason");
    expect(tombstone.reason_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(
      putVaultObject(
        root,
        { bytes: plaintext, contentType: "text/plain" },
        { key }
      )
    ).rejects.toThrow(/cannot be silently recreated/);
  });

  it("reports only aggregate status", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-vault-status-")
    );
    tempDirs.push(root);
    await initializeVault(root, { key });
    await putVaultObject(
      root,
      { bytes: Buffer.from("one"), contentType: "text/plain" },
      { key }
    );

    const status = await getVaultStatus(root, { key });

    expect(status).toMatchObject({
      initialized: true,
      keyAvailable: true,
      objects: 1,
      tombstones: 0
    });
    expect(JSON.stringify(status)).not.toContain("vault_sha256_");
  });
});
