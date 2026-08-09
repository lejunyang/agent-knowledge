import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptPolicyProposal,
  createPolicyProposal,
  listPolicyProposals,
  readPolicy,
  readPolicyProposal,
  rejectPolicyProposal,
  writePolicy
} from "../src/index.js";
import type { MemoryUsePolicyInput } from "../src/policy/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const candidate = {
  version: 1 as const,
  id: "policy_support_wrong_route",
  kind: "retrieval_lesson" as const,
  status: "shadow" as const,
  title: "客服问题避免错误恢复路由",
  rationale: "多个独立查询把注销问题错误路由到恢复知识。",
  priority: 50,
  applicability: {
    domains: ["account/deletion"],
    scenarios: ["support"],
    project_keys: [],
    query_terms_any: [],
    query_terms_all: [],
    excluded_terms: []
  },
  evidence: {
    query_run_ids: ["query-1", "query-2", "query-3"],
    feedback_keys: ["feedback-1", "feedback-2", "feedback-3"],
    eval_case_ids: []
  },
  directive: {
    route_domains: ["account/deletion"],
    route_scenarios: [],
    prefer_memory_ids: ["k_delete"],
    suppress_memory_ids: ["k_recovery"],
    abstain_if_no_preferred_memory: false,
    require_source_refresh: false
  },
  created_at: "2026-08-09",
  updated_at: "2026-08-09"
} satisfies MemoryUsePolicyInput;

describe("memory-use policy proposals", () => {
  it("creates stable owner-only pending proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-proposal-"));
    tempDirs.push(root);

    const first = await createPolicyProposal(root, {
      candidate,
      source: "feedback_mining",
      evidenceSummary: {
        independentQueryRuns: 3,
        feedbackEvents: 3,
        evalCases: 0
      }
    });
    const second = await createPolicyProposal(root, {
      candidate,
      source: "feedback_mining",
      evidenceSummary: {
        independentQueryRuns: 3,
        feedbackEvents: 3,
        evalCases: 0
      }
    });

    expect(second.id).toBe(first.id);
    expect(first.status).toBe("pending");
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    expect(await listPolicyProposals(root)).toHaveLength(1);
  });

  it("accepts only pending proposals into the Git policy store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-accept-"));
    tempDirs.push(root);
    const proposal = await createPolicyProposal(root, {
      candidate,
      source: "manual",
      evidenceSummary: {
        independentQueryRuns: 3,
        feedbackEvents: 3,
        evalCases: 0
      }
    });

    const accepted = await acceptPolicyProposal(root, proposal.id);

    expect(accepted.status).toBe("accepted");
    expect(accepted.policyPath).toContain(
      "policies/retrieval/policy_support_wrong_route.yaml"
    );
    await expect(readPolicy(root, candidate.id)).resolves.toMatchObject({
      status: "shadow",
      id: candidate.id
    });
    await expect(acceptPolicyProposal(root, proposal.id)).rejects.toThrow(
      /pending/
    );
  });

  it("rejects proposals and refuses to overwrite an existing policy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-reject-"));
    tempDirs.push(root);
    const rejectedProposal = await createPolicyProposal(root, {
      candidate,
      source: "manual",
      evidenceSummary: {
        independentQueryRuns: 3,
        feedbackEvents: 3,
        evalCases: 0
      }
    });
    await rejectPolicyProposal(
      root,
      rejectedProposal.id,
      "范围过宽，需要更多业务证据"
    );

    expect(
      (await readPolicyProposal(root, rejectedProposal.id))?.status
    ).toBe("rejected");
    await expect(
      acceptPolicyProposal(root, rejectedProposal.id)
    ).rejects.toThrow(/pending/);

    const secondCandidate = {
      ...candidate,
      id: "policy_existing_route"
    } satisfies MemoryUsePolicyInput;
    await writePolicy(root, secondCandidate);
    const conflicting = await createPolicyProposal(root, {
      candidate: secondCandidate,
      source: "manual",
      evidenceSummary: {
        independentQueryRuns: 3,
        feedbackEvents: 3,
        evalCases: 0
      }
    });
    await expect(acceptPolicyProposal(root, conflicting.id)).rejects.toThrow(
      /already exists/
    );
    expect((await readPolicyProposal(root, conflicting.id))?.status).toBe(
      "pending"
    );
  });
});
