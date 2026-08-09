import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryUsePolicySchema,
  initializePolicyWorkspace,
  listPolicies,
  readPolicy,
  type MemoryUsePolicyInput,
  validatePolicyFile,
  writePolicy
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const retrievalPolicy = {
  version: 1 as const,
  id: "policy_account_deletion_route",
  kind: "retrieval_lesson" as const,
  status: "shadow" as const,
  title: "账号注销优先检索删除规则",
  rationale: "恢复知识在普通注销问题中会造成误路由。",
  priority: 50,
  applicability: {
    domains: ["account/deletion"],
    scenarios: ["support"],
    project_keys: [],
    query_terms_any: ["注销", "删除账号"],
    query_terms_all: [],
    excluded_terms: ["恢复账号"]
  },
  evidence: {
    query_run_ids: ["query-1", "query-2", "query-3"],
    feedback_keys: ["feedback-1"],
    eval_case_ids: []
  },
  directive: {
    route_domains: ["account/deletion"],
    route_scenarios: ["account-deletion"],
    prefer_memory_ids: ["k_account_deletion"],
    suppress_memory_ids: ["k_account_recovery"],
    abstain_if_no_preferred_memory: true,
    require_source_refresh: false
  },
  created_at: "2026-08-09",
  updated_at: "2026-08-09"
} satisfies MemoryUsePolicyInput;

const reasoningPolicy = {
  version: 1 as const,
  id: "policy_conflict_must_abstain",
  kind: "reasoning_policy" as const,
  status: "shadow" as const,
  title: "未解决冲突必须停止下结论",
  rationale: "按 confidence 二选一会掩盖事实冲突。",
  priority: 100,
  applicability: {
    domains: [],
    scenarios: ["support"],
    project_keys: ["github.com/example/business"],
    query_terms_any: [],
    query_terms_all: [],
    excluded_terms: []
  },
  evidence: {
    query_run_ids: ["query-conflict-1"],
    feedback_keys: ["feedback-conflict-1"],
    eval_case_ids: ["conflict-case-1"]
  },
  directive: {
    checks: ["unresolved_conflict"],
    required_layers: ["knowledge", "evidence"],
    authority_order: ["documented", "user_confirmed", "verified_task"],
    decision_on_violation: "abstain"
  },
  created_at: "2026-08-09",
  updated_at: "2026-08-09"
} satisfies MemoryUsePolicyInput;

describe("memory-use policy store", () => {
  it("validates both policy kinds and refuses active runtime status", () => {
    expect(MemoryUsePolicySchema.parse(retrievalPolicy).kind).toBe(
      "retrieval_lesson"
    );
    expect(MemoryUsePolicySchema.parse(reasoningPolicy).kind).toBe(
      "reasoning_policy"
    );
    expect(() =>
      MemoryUsePolicySchema.parse({ ...retrievalPolicy, status: "active" })
    ).toThrow();
  });

  it("writes owner-only YAML into the fixed Git policy hierarchy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-store-"));
    tempDirs.push(root);
    await initializePolicyWorkspace(root);

    const retrievalPath = await writePolicy(root, retrievalPolicy);
    const reasoningPath = await writePolicy(root, reasoningPolicy);

    expect(retrievalPath).toBe(
      path.join(root, "policies", "retrieval", `${retrievalPolicy.id}.yaml`)
    );
    expect(reasoningPath).toBe(
      path.join(root, "policies", "reasoning", `${reasoningPolicy.id}.yaml`)
    );
    expect((await stat(retrievalPath)).mode & 0o777).toBe(0o600);
    await expect(readPolicy(root, retrievalPolicy.id)).resolves.toEqual(
      retrievalPolicy
    );
    await expect(listPolicies(root)).resolves.toEqual([
      reasoningPolicy,
      retrievalPolicy
    ]);
    expect(await readFile(retrievalPath, "utf8")).toContain(
      "kind: retrieval_lesson"
    );
    await expect(
      access(path.join(root, "policies", "README.md"))
    ).resolves.toBeUndefined();
  });

  it("rejects overwrite, path traversal, and invalid imported YAML", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-invalid-"));
    tempDirs.push(root);
    await writePolicy(root, retrievalPolicy);
    await expect(writePolicy(root, retrievalPolicy)).rejects.toThrow(
      /already exists/
    );
    expect(() =>
      MemoryUsePolicySchema.parse({
        ...retrievalPolicy,
        id: "../escape"
      })
    ).toThrow();

    const invalidPath = path.join(root, "invalid.yaml");
    await writeFile(
      invalidPath,
      `version: 1
id: policy_invalid
kind: retrieval_lesson
status: active
`,
      "utf8"
    );
    await expect(validatePolicyFile(invalidPath)).rejects.toThrow();
  });
});
