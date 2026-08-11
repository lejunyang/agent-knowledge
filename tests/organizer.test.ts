import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKnowledgeMarkdown } from "../src/storage/markdown.js";
import { listKnowledge, organizeInbox } from "../src/memory/organizer.js";
import { captureMaterial } from "./helpers/candidate.js";
import { queryMemories } from "../src/retrieval/query.js";
import { PublishedAssetManifestSchema } from "../src/storage/sourceAssets.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

/** 创建一个无需 Vault 的已发布资产 fixture，专门验证 Markdown 引用解析和移动。 */
async function createPublishedAsset(rootDir: string): Promise<{
  assetId: string;
  relativePath: string;
}> {
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01
  ]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const assetId = `asset_sha256_${hash}`;
  const relativePath = path.posix.join(
    "knowledge",
    "assets",
    "objects",
    hash.slice(0, 2),
    `${assetId}.png`
  );
  const manifest = PublishedAssetManifestSchema.parse({
    schema_version: 1,
    asset_id: assetId,
    source_id: "src_test_diagram",
    source_fingerprint: `sha256:${"b".repeat(64)}`,
    content_hash: `sha256:${hash}`,
    content_type: "image/png",
    content_bytes: bytes.length,
    title: "部署拓扑.png",
    relative_path: relativePath,
    published_at: "2026-08-11T00:00:00.000Z"
  });
  const objectPath = path.join(rootDir, relativePath);
  const manifestPath = path.join(
    rootDir,
    "knowledge",
    "assets",
    "manifests",
    `${assetId}.json`
  );
  await mkdir(path.dirname(objectPath), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(objectPath, bytes);
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return { assetId, relativePath };
}

describe("listKnowledge", () => {
  it("summarizes active knowledge and inbox items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-list-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const summary = await listKnowledge(root);

    expect(summary.total).toBe(2);
    expect(summary.byStatus.active).toBe(2);
    expect(summary.byType.semantic).toBe(1);
    expect(summary.byType.procedural).toBe(1);
  });

  it("does not parse Skill review drafts as knowledge while listing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-list-skill-draft-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const skillDir = path.join(
      root,
      "knowledge",
      "_inbox-skills",
      "release-validation"
    );
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: release-validation\ndescription: Review draft\n---\n",
      "utf8"
    );

    const summary = await listKnowledge(root);

    expect(summary.total).toBe(2);
  });

  it("does not parse asset documentation as KnowledgeDocument", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-list-asset-doc-")
    );
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const assetDirectory = path.join(
      root,
      "knowledge",
      "assets",
      "objects"
    );
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(
      path.join(assetDirectory, "README.md"),
      "# Content-addressed asset object\n",
      "utf8"
    );

    const summary = await listKnowledge(root);

    expect(summary.total).toBe(2);
  });
});

describe("organizeInbox", () => {
  it("rewrites inbox asset links relative to the promoted active Markdown path", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-organize-assets-")
    );
    tempDirs.push(root);
    const asset = await createPublishedAsset(root);
    const assetUri = `asset:${String.fromCharCode(47, 47)}${asset.assetId}`;
    const explanation = `# 图文排障流程

## 部署拓扑

![部署拓扑](${assetUri})

该图展示入口、服务和存储之间的调用方向。排障时先确认入口请求是否到达服务，再检查服务到存储的依赖；如果图片版本与当前发布版本不一致，应回到 attachment source 重新审阅，不得猜测旧图含义。

## 失败策略

若图片缺失、hash 不一致或授权范围不明确，应停止发布并保留 Vault evidence。不能把飞书临时 URL、token 或本机绝对路径写入长期知识。

\`\`\`md
![仅作语法示例](${assetUri})
\`\`\`
`;
    const captured = await captureMaterial(
      root,
      [
        {
          title: "图文排障流程",
          kind: "procedural",
          layer: "knowledge",
          synopsis: "排障知识可引用经过审阅发布的部署拓扑。",
          explanation,
          aliases: [],
          domain: "knowledge/media",
          related_domains: [],
          scenarios: [
            { id: "knowledge-media", role: "primary", weight: 1 }
          ],
          tags: [],
          claims: [],
          confidence: 0.9,
          source_authority: "documented",
          evidence: ["source:src_test_diagram"]
        }
      ],
      { target: "inbox", rebuild: false }
    );
    const inboxMarkdown = await readFile(
      captured.written[0]!.filePath,
      "utf8"
    );

    expect(inboxMarkdown).toContain(
      `![部署拓扑](../assets/objects/${asset.assetId.slice(
        "asset_sha256_".length,
        "asset_sha256_".length + 2
      )}/${asset.assetId}.png)`
    );
    expect(inboxMarkdown).toContain(`![仅作语法示例](${assetUri})`);

    const result = await organizeInbox(root, {
      apply: true,
      rebuild: false
    });
    const promoted = result.moved[0]!;
    const activeMarkdown = await readFile(
      path.join(root, promoted.to),
      "utf8"
    );

    expect(activeMarkdown).toContain(
      `![部署拓扑](../../../assets/objects/${asset.assetId.slice(
        "asset_sha256_".length,
        "asset_sha256_".length + 2
      )}/${asset.assetId}.png)`
    );
    expect(activeMarkdown).not.toContain(
      `![部署拓扑](../assets/objects/`
    );
    expect(activeMarkdown).toContain(`![仅作语法示例](${assetUri})`);
  });

  it("dry-runs inbox promotion without moving files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-organize-dry-"));
    tempDirs.push(root);
    await writeFile(
      path.join(root, "placeholder"),
      "placeholder",
      "utf8"
    );

    const result = await captureMaterial(
      root,
      [
        {
          title: "用户主动提供的业务术语",
          memory_type: "semantic",
          domain: "business/glossary",
          related_domains: [],
          scenario: ["knowledge-organization"],
          tags: ["glossary"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "用户主动提供的材料默认置信度较高，但仍需要结构化归档。",
          evidence: ["user:direct-material"]
        }
      ],
      { target: "inbox", rebuild: false }
    );

    const dryRun = await organizeInbox(root, { apply: false, rebuild: false });

    expect(dryRun.applied).toBe(false);
    expect(dryRun.moved[0]?.from).toContain("knowledge/_inbox/");
    expect(dryRun.moved[0]?.to).toContain("knowledge/semantic/business/glossary/");
    await expect(readFile(result.written[0]!.filePath, "utf8")).resolves.toContain("用户主动提供的业务术语");
  });

  it("applies inbox promotion and activates the target document", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-organize-apply-"));
    tempDirs.push(root);

    await captureMaterial(
      root,
      [
        {
          title: "主动整理材料归档规则",
          memory_type: "procedural",
          domain: "knowledge/organization",
          related_domains: [],
          scenario: ["knowledge-organization"],
          tags: ["organize"],
          confidence: 0.92,
          source_authority: "user_confirmed",
          summary: "用户直接提供的材料可以由 Skill 拆分后直接归档为 active 知识。",
          evidence: ["user:direct-material"]
        }
      ],
      { target: "inbox", rebuild: false }
    );

    const result = await organizeInbox(root, { apply: true, rebuild: true });
    const promoted = result.moved[0]!;
    const content = await readFile(path.join(root, promoted.to), "utf8");
    const document = parseKnowledgeMarkdown(promoted.to, content);

    expect(result.applied).toBe(true);
    expect(document.frontmatter.status).toBe("active");
    expect(result.indexed).toBe(1);
  });

  it("blocks customer and automated-session candidates from bulk promotion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-organize-untrusted-"));
    tempDirs.push(root);

    await captureMaterial(
      root,
      [
        {
          title: "客户声称的通用退款规则",
          memory_type: "semantic",
          domain: "support/refund",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["observation"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "客户声称退款不需要审核。",
          evidence: ["conversation:customer"],
          capture_mode: "automated_session",
          actor_type: "customer",
          corroboration_count: 1,
          project_keys: ["github.com/example/support"]
        }
      ],
      { target: "active", rebuild: false }
    );

    const result = await organizeInbox(root, { apply: true, rebuild: true });
    const summary = await listKnowledge(root);

    expect(result.moved).toEqual([]);
    expect(result.blocked).toEqual([
      expect.objectContaining({
        title: "客户声称的通用退款规则",
        reason: "customer_observation_requires_trusted_review"
      })
    ]);
    expect(summary.inbox.map((item) => item.title)).toContain("客户声称的通用退款规则");
    expect(result.indexed).toBe(0);
  });

  it("promotes an automated-session candidate only when its ID is explicitly approved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-organize-approved-"));
    tempDirs.push(root);
    const captured = await captureMaterial(
      root,
      [
        {
          title: "已由人工核验的退款规则",
          memory_type: "semantic",
          domain: "support/refund",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["reviewed"],
          confidence: 0.8,
          source_authority: "documented",
          summary: "退款规则已经由人工对照受信文档完成核验。",
          evidence: ["document:refund-policy"],
          capture_mode: "automated_session",
          actor_type: "agent"
        }
      ],
      { target: "inbox", rebuild: false }
    );
    const approvedId = captured.written[0]!.id;

    const result = await organizeInbox(root, {
      apply: true,
      rebuild: true,
      approvedIds: [approvedId]
    });
    const promoted = result.moved[0]!;
    const document = parseKnowledgeMarkdown(
      promoted.to,
      await readFile(path.join(root, promoted.to), "utf8")
    );

    expect(result.blocked).toEqual([]);
    expect(result.moved.map((item) => item.id)).toEqual([approvedId]);
    expect(document.frontmatter.status).toBe("active");
  });

  it("rejects an unknown approval ID before changing any inbox candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-organize-unknown-"));
    tempDirs.push(root);
    const captured = await captureMaterial(
      root,
      [
        {
          title: "待人工核验的客服观察",
          memory_type: "semantic",
          domain: "support/refund",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["observation"],
          confidence: 0.6,
          source_authority: "model_inferred",
          summary: "该观察尚未完成受信来源核验。",
          evidence: ["conversation:customer"],
          capture_mode: "automated_session",
          actor_type: "customer"
        }
      ],
      { target: "inbox", rebuild: false }
    );

    await expect(
      organizeInbox(root, {
        apply: true,
        rebuild: true,
        approvedIds: ["k_missing"]
      })
    ).rejects.toThrow("Inbox knowledge IDs not found: k_missing");
    await expect(readFile(captured.written[0]!.filePath, "utf8")).resolves.toContain(
      "待人工核验的客服观察"
    );
  });
});

describe("captureMaterial", () => {
  it("writes published asset URIs as relative links in active Markdown", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-capture-assets-")
    );
    tempDirs.push(root);
    const asset = await createPublishedAsset(root);
    const assetUri = `asset:${String.fromCharCode(47, 47)}${asset.assetId}`;

    const result = await captureMaterial(
      root,
      [
        {
          title: "带图的业务说明",
          kind: "semantic",
          layer: "knowledge",
          synopsis: "业务说明包含经过审阅的部署拓扑。",
          explanation: `# 带图的业务说明

## 结论

![部署拓扑](${assetUri})

该拓扑用于解释业务入口、服务节点和持久化层的关系。读取者应先核对图示版本与当前 source fingerprint，再根据文字说明判断适用范围；图片只是证据的一部分，不能替代失败策略和版本边界。

## 边界

媒体未发布、对象 hash 校验失败或权限不明确时必须停止写入。长期 Markdown 只能保留可从当前文件位置解析的相对路径，不能保存临时 URL、token 或绝对路径。
`,
          aliases: [],
          domain: "business/media",
          related_domains: [],
          scenarios: [{ id: "business-media", role: "primary", weight: 1 }],
          tags: [],
          claims: [],
          confidence: 0.9,
          source_authority: "documented",
          evidence: ["source:src_test_diagram"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const markdown = await readFile(result.written[0]!.filePath, "utf8");

    expect(markdown).toContain(
      `![部署拓扑](../../../assets/objects/${asset.assetId.slice(
        "asset_sha256_".length,
        "asset_sha256_".length + 2
      )}/${asset.assetId}.png)`
    );
    expect(markdown).not.toContain(assetUri);
    await expect(
      readFile(
        path.resolve(
          path.dirname(result.written[0]!.filePath),
          `../../../assets/objects/${asset.assetId.slice(
            "asset_sha256_".length,
            "asset_sha256_".length + 2
          )}/${asset.assetId}.png`
        )
      )
    ).resolves.toBeInstanceOf(Buffer);
  });

  it("rejects an unknown asset URI before writing any candidate in the batch", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-capture-unknown-asset-")
    );
    tempDirs.push(root);
    const missingAssetUri = `asset:${String.fromCharCode(
      47,
      47
    )}asset_sha256_${"c".repeat(64)}`;

    await expect(
      captureMaterial(
        root,
        [
          {
            title: "批次第一条",
            kind: "source",
            layer: "evidence",
            synopsis: "第一条本来可以写入。",
            explanation: "<p>第一条证据。</p>",
            aliases: [],
            domain: "business/media",
            related_domains: [],
            scenarios: [
              { id: "business-media", role: "primary", weight: 1 }
            ],
            tags: [],
            claims: [],
            confidence: 0.9,
            source_authority: "documented",
            evidence: ["source:first"]
          },
          {
            title: "批次第二条",
            kind: "source",
            layer: "evidence",
            synopsis: "第二条引用不存在的资产。",
            explanation: `![缺失](${missingAssetUri})`,
            aliases: [],
            domain: "business/media",
            related_domains: [],
            scenarios: [
              { id: "business-media", role: "primary", weight: 1 }
            ],
            tags: [],
            claims: [],
            confidence: 0.9,
            source_authority: "documented",
            evidence: ["source:second"]
          }
        ],
        { target: "active", rebuild: false }
      )
    ).rejects.toThrow(/Published asset manifest not found/);

    const summary = await listKnowledge(root);
    expect(summary.total).toBe(0);
  });

  it("writes user-provided structured material directly to active knowledge and indexes it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-capture-"));
    tempDirs.push(root);

    const result = await captureMaterial(
      root,
      [
        {
          title: "直接材料整理规则",
          memory_type: "semantic",
          domain: "knowledge/organization",
          related_domains: ["agent/memory"],
          scenario: ["knowledge-organization"],
          tags: ["direct-material"],
          confidence: 0.93,
          source_authority: "user_confirmed",
          summary: "用户直接提供的材料置信度较高，Skill 负责理解拆分，CLI 负责校验、落盘和索引。",
          evidence: ["user:direct-material"]
        }
      ],
      { target: "active", rebuild: true }
    );

    expect(result.target).toBe("active");
    expect(result.written[0]?.status).toBe("active");
    expect(result.written[0]?.filePath).toContain("knowledge/semantic/knowledge/organization/");
    expect(result.indexed).toBe(1);

    const ranked = queryMemories(root, {
      task: "如何整理用户直接提供的知识材料",
      agentRole: "main",
      domains: ["knowledge/organization"],
      scenarios: ["knowledge-organization"]
    });

    expect(ranked.map((item) => item.document.frontmatter.title)).toContain("直接材料整理规则");
  });

  it("preserves aliases and related knowledge when capturing active material", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-capture-relations-"));
    tempDirs.push(root);

    const result = await captureMaterial(
      root,
      [
        {
          title: "业务账户关系",
          aliases: ["account relation", "账户关联"],
          memory_type: "semantic",
          domain: "company/business/account-system",
          related_domains: ["commercialization/account"],
          scenario: ["business-knowledge"],
          tags: ["company-business"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "账户之间可能存在授权、绑定、层级等关系。",
          evidence: ["user:direct-material"],
          related_knowledge: [
            {
              id: "k_20260705_company_business_account_system_account_model",
              relation: "often_used_with",
              reason: "账户关系需要结合账户模型理解。"
            }
          ]
        }
      ],
      { target: "active", rebuild: false }
    );

    const content = await readFile(result.written[0]!.filePath, "utf8");
    const document = parseKnowledgeMarkdown("captured.md", content);

    expect(document.frontmatter.aliases.map((alias) => alias.value)).toContain(
      "account relation"
    );
    expect(document.frontmatter.related_knowledge).toEqual([
      {
        id: "k_20260705_company_business_account_system_account_model",
        relation: "often_used_with",
        reason: "账户关系需要结合账户模型理解。"
      }
    ]);
  });

  it("writes complete source content with an explicit ID into the source hierarchy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-capture-source-"));
    tempDirs.push(root);
    const content = "<title>业务材料</title><p>完整正文和引用。</p>";

    const result = await captureMaterial(
      root,
      [
        {
          id: "k_lark_source_material_001",
          title: "业务材料",
          memory_type: "source",
          domain: "bytedance/business/source/lark",
          related_domains: [],
          scenario: ["business-source"],
          tags: ["lark"],
          confidence: 0.95,
          source_authority: "documented",
          summary: "业务材料来源。",
          content,
          evidence: ["lark:docx:001"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const document = parseKnowledgeMarkdown(
      result.written[0]!.filePath,
      await readFile(result.written[0]!.filePath, "utf8")
    );

    expect(document.frontmatter.id).toBe("k_lark_source_material_001");
    expect(document.frontmatter.kind).toBe("source");
    expect(document.body).toBe(content);
    expect(result.written[0]?.filePath).toContain(
      "knowledge/source/bytedance/business/source/lark/"
    );

    const repeated = await captureMaterial(
      root,
      [
        {
          id: "k_lark_source_material_001",
          title: "业务材料",
          memory_type: "source",
          domain: "bytedance/business/source/lark",
          related_domains: [],
          scenario: ["business-source"],
          tags: ["lark"],
          confidence: 0.95,
          source_authority: "documented",
          summary: "业务材料来源。",
          content,
          evidence: ["lark:docx:001"]
        }
      ],
      { target: "active", rebuild: false }
    );
    expect(repeated.written[0]).toMatchObject({
      id: "k_lark_source_material_001",
      filePath: result.written[0]!.filePath,
      deduplicated: true
    });
  });

  it("replaces only an existing documented active source when explicitly enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-capture-replace-source-"));
    tempDirs.push(root);
    const base = {
      id: "k_lark_source_material_replace",
      title: "可刷新来源",
      memory_type: "source" as const,
      domain: "bytedance/business/source/lark",
      related_domains: [],
      scenario: ["business-source"],
      tags: ["lark"],
      confidence: 0.95,
      source_authority: "documented" as const,
      summary: "可持续刷新的飞书来源。",
      evidence: ["lark:docx:replace"],
      capture_mode: "direct_material" as const,
      actor_type: "owner" as const
    };
    const first = await captureMaterial(
      root,
      [{ ...base, content: "<title>第一版</title><p>旧正文。</p>" }],
      { target: "active", rebuild: false }
    );

    const replaced = await captureMaterial(
      root,
      [{ ...base, content: "<title>第二版</title><p>脱敏后的新正文。</p>" }],
      { target: "active", rebuild: false, replaceExistingSources: true }
    );
    const document = parseKnowledgeMarkdown(
      first.written[0]!.filePath,
      await readFile(first.written[0]!.filePath, "utf8")
    );

    expect(replaced.written[0]).toMatchObject({
      id: base.id,
      filePath: first.written[0]!.filePath,
      replaced: true
    });
    expect(document.body).toBe("<title>第二版</title><p>脱敏后的新正文。</p>");
  });

  it("refuses replacement for non-source or non-documented knowledge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-capture-replace-guard-"));
    tempDirs.push(root);
    const first = await captureMaterial(
      root,
      [
        {
          id: "k_guarded_semantic",
          title: "不可覆盖的精炼知识",
          memory_type: "semantic",
          domain: "knowledge/governance",
          related_domains: [],
          scenario: ["knowledge-organization"],
          tags: ["governance"],
          confidence: 0.95,
          source_authority: "user_confirmed",
          summary: "精炼知识必须通过 supersedes 更新。",
          evidence: ["owner:confirmed"]
        }
      ],
      { target: "active", rebuild: false }
    );

    await expect(
      captureMaterial(
        root,
        [
          {
            id: "k_guarded_semantic",
            title: "不可覆盖的精炼知识",
            memory_type: "semantic",
            domain: "knowledge/governance",
            related_domains: [],
            scenario: ["knowledge-organization"],
            tags: ["governance"],
            confidence: 0.95,
            source_authority: "user_confirmed",
            summary: "试图覆盖精炼知识。",
            evidence: ["owner:confirmed"]
          }
        ],
        { target: "active", rebuild: false, replaceExistingSources: true }
      )
    ).rejects.toThrow("Only documented active source knowledge can be replaced");

    await expect(readFile(first.written[0]!.filePath, "utf8")).resolves.toContain(
      "精炼知识必须通过 supersedes 更新"
    );
  });

  it("deprecates superseded active knowledge when a trusted replacement is captured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-capture-supersedes-"));
    tempDirs.push(root);
    const first = await captureMaterial(
      root,
      [
        {
          title: "旧版审核流程",
          memory_type: "procedural",
          domain: "support/review",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["review"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "旧版流程需要两级审核。",
          evidence: ["owner:confirmed"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const oldPath = first.written[0]!.filePath;
    const oldDocument = parseKnowledgeMarkdown("old.md", await readFile(oldPath, "utf8"));

    await captureMaterial(
      root,
      [
        {
          title: "新版审核流程",
          memory_type: "procedural",
          domain: "support/review",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["review"],
          confidence: 0.95,
          source_authority: "user_confirmed",
          summary: "新版流程只需要一级审核。",
          evidence: ["owner:confirmed"],
          supersedes: [oldDocument.frontmatter.id]
        }
      ],
      { target: "active", rebuild: true }
    );
    const updatedOld = parseKnowledgeMarkdown("old.md", await readFile(oldPath, "utf8"));

    expect(updatedOld.frontmatter.status).toBe("deprecated");
    expect(updatedOld.frontmatter.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
