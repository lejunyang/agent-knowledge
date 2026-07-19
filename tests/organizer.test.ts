import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKnowledgeMarkdown } from "../src/storage/markdown.js";
import { captureMaterial, listKnowledge, organizeInbox } from "../src/memory/organizer.js";
import { queryMemories } from "../src/retrieval/query.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

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
});

describe("organizeInbox", () => {
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
          project_ids: ["project_support"]
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

    expect(document.frontmatter.aliases).toContain("account relation");
    expect(document.frontmatter.related_knowledge).toEqual([
      {
        id: "k_20260705_company_business_account_system_account_model",
        relation: "often_used_with",
        reason: "账户关系需要结合账户模型理解。"
      }
    ]);
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
