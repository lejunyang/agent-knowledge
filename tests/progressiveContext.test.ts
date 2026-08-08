import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMaterial } from "../src/memory/organizer.js";
import { rebuildIndex } from "../src/storage/indexer.js";
import { buildSourceManifest } from "../src/storage/sourceManifest.js";
import { buildContextPacket } from "../src/retrieval/contextPacket.js";
import {
  expandEvidence,
  expandKnowledge
} from "../src/retrieval/expansion.js";
import { queryMemoriesWithDebug } from "../src/retrieval/query.js";
import { MemoryQueryRequestSchema } from "../src/core/schema.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

/** 写一条有真实 section/hash anchor 的 active V2 knowledge。 */
async function createGroundedKnowledge(root: string): Promise<{
  knowledgeId: string;
  claimId: string;
}> {
  const source = buildSourceManifest({
    sourceId: "src_account_guide",
    connector: "file",
    externalKey: "file:account-guide",
    title: "账号指南",
    content:
      "<h1>登录态</h1><p>商业化 UID 与抖音 UID 属于不同账号组。</p>",
    observedAt: "2026-08-09T00:00:00.000Z",
    processingStatus: "refined"
  });
  const manifestDirectory = path.join(
    root,
    "knowledge",
    "source-manifests"
  );
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(
    path.join(manifestDirectory, "src_account_guide.json"),
    `${JSON.stringify(source, null, 2)}\n`,
    "utf8"
  );
  const section = source.sections[0]!;
  await captureMaterial(
    root,
    [
      {
        id: "k_account_identity_boundary",
        title: "商业化 UID 与抖音 UID 的账号组边界",
        kind: "semantic",
        layer: "knowledge",
        synopsis: "两类 UID 属于不同账号组，不能默认相等。",
        explanation: `# 商业化 UID 与抖音 UID 的账号组边界

## 背景

商业化账号组和抖音账号组是独立身份空间。

## 为什么不能默认相等

UID 只在所属账号组内唯一；跨账号组需要通过 OAuth 或业务绑定关系建立映射。

## 排查边界

先确认当前域名、AppID 和账号组，再判断页面需要哪类 UID。`,
        aliases: [
          {
            value: "账号组边界",
            kind: "user_phrase",
            weight: 0.9,
            source: "documented"
          }
        ],
        domain: "business/account",
        related_domains: [],
        scenarios: [
          {
            id: "account-login",
            role: "primary",
            weight: 1
          }
        ],
        tags: [],
        claims: [
          {
            id: "claim_uid_group_boundary",
            statement: "商业化 UID 与抖音 UID 属于不同账号组。",
            status: "supported",
            confidence: 0.96,
            evidence: [
              {
                source_id: source.source_id,
                section_id: section.section_id,
                quote_hash: section.text_hash
              }
            ]
          }
        ],
        confidence: 0.96,
        source_authority: "documented",
        evidence: [`source:${source.source_id}`],
        project_keys: ["github.com/example/account-service"]
      }
    ],
    { target: "active", rebuild: true }
  );
  return {
    knowledgeId: "k_account_identity_boundary",
    claimId: "claim_uid_group_boundary"
  };
}

describe("progressive context", () => {
  it("injects synopsis and exposes explicit knowledge/evidence expansion", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-progressive-")
    );
    tempDirs.push(root);
    const ids = await createGroundedKnowledge(root);
    const request = MemoryQueryRequestSchema.parse({
      task: "商业化 UID 和抖音 UID 是同一个 ID 吗",
      projectKeys: ["github.com/example/account-service"]
    });
    const query = queryMemoriesWithDebug(root, request);
    const packet = buildContextPacket({ request, ranked: query.ranked });

    expect(packet.context_version).toBe("2.0");
    expect(packet.claims[0]?.content).toBe(
      "两类 UID 属于不同账号组，不能默认相等。"
    );
    expect(packet.claims[0]?.content).not.toContain("为什么不能默认相等");
    expect(packet.evidence_handles).toEqual([
      expect.objectContaining({
        knowledgeId: ids.knowledgeId,
        claimId: ids.claimId,
        sourceId: "src_account_guide"
      })
    ]);
    expect(packet.expansion.commands).toEqual(
      expect.arrayContaining([
        `agent-knowledge knowledge show ${ids.knowledgeId} --layer knowledge`,
        `agent-knowledge knowledge evidence ${ids.claimId}`
      ])
    );

    const expanded = expandKnowledge(root, {
      id: ids.knowledgeId,
      layer: "knowledge",
      request: {
        projectKeys: ["github.com/example/account-service"]
      }
    });
    const evidence = await expandEvidence(root, {
      claimId: ids.claimId,
      request: {
        projectKeys: ["github.com/example/account-service"]
      }
    });
    expect(expanded.content).toContain("为什么不能默认相等");
    expect(evidence.anchors[0]?.source_id).toBe("src_account_guide");
  });

  it("does not let explicit IDs bypass project isolation", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-progressive-project-")
    );
    tempDirs.push(root);
    const ids = await createGroundedKnowledge(root);
    rebuildIndex(root);

    expect(() =>
      expandKnowledge(root, {
        id: ids.knowledgeId,
        layer: "knowledge",
        request: {
          projectKeys: ["github.com/example/other-project"]
        }
      })
    ).toThrow("Accessible active knowledge not found");
    await expect(
      expandEvidence(root, {
        claimId: ids.claimId,
        request: {
          projectKeys: ["github.com/example/other-project"]
        }
      })
    ).rejects.toThrow("Accessible active knowledge not found");
  });
});
