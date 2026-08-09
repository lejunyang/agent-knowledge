/**
 * Policy proposal 是 `.memory` 中的机器审阅产物，不是 Git 事实源。
 *
 * 后台 mining 只能创建 pending proposal；accept 必须由用户显式调用，且先成功写入 shadow
 * Policy 后才更新 proposal，避免出现“已接受但没有 Policy 文件”的半状态。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";
import { MemoryUsePolicySchema } from "./types.js";
import { writePolicy } from "./store.js";

const PolicyProposalSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^policy_proposal_[a-f0-9]{24}$/),
    status: z.enum(["pending", "accepted", "rejected"]),
    source: z.enum(["manual", "feedback_mining", "eval_mining"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    candidate: MemoryUsePolicySchema,
    evidenceSummary: z
      .object({
        independentQueryRuns: z.number().int().nonnegative(),
        feedbackEvents: z.number().int().nonnegative(),
        evalCases: z.number().int().nonnegative()
      })
      .strict(),
    resolution: z.string().max(1_000).optional(),
    policyPath: z.string().min(1).optional()
  })
  .strict();

export type PolicyProposal = z.output<typeof PolicyProposalSchema>;
export type PolicyProposalHandle = PolicyProposal & { path: string };
export type PolicyProposalInput = {
  candidate: z.input<typeof MemoryUsePolicySchema>;
  source: PolicyProposal["source"];
  evidenceSummary: PolicyProposal["evidenceSummary"];
  now?: Date;
};

/** 返回 proposal 目录；该目录由 `.gitignore` 中的 `.memory/` 统一排除。 */
function proposalDirectory(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "policies", "proposals");
}

/** 按 candidate 和证据身份生成稳定 ID，重复 mining 不产生重复待办。 */
function proposalId(input: {
  candidate: PolicyProposal["candidate"];
  source: PolicyProposal["source"];
  evidenceSummary: PolicyProposal["evidenceSummary"];
}): string {
  return `policy_proposal_${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24)}`;
}

/** 返回单个 proposal 路径，并用 schema 校验 ID 阻断路径越界。 */
export function getPolicyProposalPath(rootDir: string, id: string): string {
  const parsed = PolicyProposalSchema.shape.id.parse(id);
  return path.join(proposalDirectory(rootDir), `${parsed}.json`);
}

/** 原子写 owner-only proposal。 */
async function writePolicyProposal(
  rootDir: string,
  proposal: PolicyProposal
): Promise<PolicyProposalHandle> {
  const parsed = PolicyProposalSchema.parse(proposal);
  const target = getPolicyProposalPath(rootDir, parsed.id);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return { ...parsed, path: target };
}

/** 创建或返回幂等 pending proposal；不会覆盖已有人工决议。 */
export async function createPolicyProposal(
  rootDir: string,
  input: PolicyProposalInput
): Promise<PolicyProposalHandle> {
  const candidate = MemoryUsePolicySchema.parse(input.candidate);
  const evidenceSummary = PolicyProposalSchema.shape.evidenceSummary.parse(
    input.evidenceSummary
  );
  const id = proposalId({
    candidate,
    source: input.source,
    evidenceSummary
  });
  const existing = await readPolicyProposal(rootDir, id);
  if (existing) {
    return { ...existing, path: getPolicyProposalPath(rootDir, id) };
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  return writePolicyProposal(rootDir, {
    version: 1,
    id,
    status: "pending",
    source: input.source,
    createdAt: timestamp,
    updatedAt: timestamp,
    candidate,
    evidenceSummary
  });
}

/** 读取 proposal；缺失返回 null。 */
export async function readPolicyProposal(
  rootDir: string,
  id: string
): Promise<PolicyProposal | null> {
  const target = getPolicyProposalPath(rootDir, id);
  if (!existsSync(target)) {
    return null;
  }
  return PolicyProposalSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
}

/** 按创建时间和 ID 稳定列出 proposal。 */
export async function listPolicyProposals(
  rootDir: string
): Promise<PolicyProposal[]> {
  const directory = proposalDirectory(rootDir);
  if (!existsSync(directory)) {
    return [];
  }
  const proposals: PolicyProposal[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    proposals.push(
      PolicyProposalSchema.parse(
        JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
      )
    );
  }
  return proposals.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
  );
}

/** 显式接受 pending proposal，并写入 shadow-only Git Policy。 */
export async function acceptPolicyProposal(
  rootDir: string,
  id: string,
  options: { now?: Date } = {}
): Promise<PolicyProposalHandle> {
  const proposal = await readPolicyProposal(rootDir, id);
  if (!proposal) {
    throw new Error(`Policy proposal not found: ${id}`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`Only pending policy proposals can be accepted: ${id}`);
  }
  const policyPath = await writePolicy(rootDir, proposal.candidate);
  return writePolicyProposal(rootDir, {
    ...proposal,
    status: "accepted",
    updatedAt: (options.now ?? new Date()).toISOString(),
    resolution: "Accepted into the Git shadow policy store.",
    policyPath
  });
}

/** 显式拒绝 pending proposal；保留候选和原因用于后续审计。 */
export async function rejectPolicyProposal(
  rootDir: string,
  id: string,
  reason: string,
  options: { now?: Date } = {}
): Promise<PolicyProposalHandle> {
  const proposal = await readPolicyProposal(rootDir, id);
  if (!proposal) {
    throw new Error(`Policy proposal not found: ${id}`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`Only pending policy proposals can be rejected: ${id}`);
  }
  return writePolicyProposal(rootDir, {
    ...proposal,
    status: "rejected",
    updatedAt: (options.now ?? new Date()).toISOString(),
    resolution: z.string().min(1).max(1_000).parse(reason)
  });
}
