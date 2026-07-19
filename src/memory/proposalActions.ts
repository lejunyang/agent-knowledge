/**
 * Proposal action 是机器审阅产物通向 inbox/Skill 文件的唯一桥梁。
 *
 * 接受 proposal 永远不会激活知识；知识变更先成为 `_inbox` candidate。Skill 安装必须显式指定
 * target，并拒绝覆盖已有文件。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { resolveWorkspacePath } from "../core/paths.js";
import { writeCandidateMemory } from "./inbox.js";
import {
  readMaintenanceProposals,
  writeMaintenanceProposal,
  type MaintenanceProposal
} from "./proposals.js";

export type ProposalActionResult = {
  proposalId: string;
  status: "accepted" | "rejected";
  candidatePath?: string;
  skillPath?: string;
};

/** 按 ID 返回 proposal；不存在时抛出明确错误，避免操作错误对象。 */
export async function showMaintenanceProposal(
  rootDir: string,
  proposalId: string
): Promise<MaintenanceProposal> {
  const proposal = (await readMaintenanceProposals(rootDir)).find(
    (item) => item.id === proposalId
  );
  if (!proposal) {
    throw new Error(`Maintenance proposal not found: ${proposalId}`);
  }
  return proposal;
}

/**
 * 接受一个 pending proposal。
 *
 * duplicate 只更新审计状态；知识变更成为保守的 model-inferred inbox candidate；Skill 草稿默认留在
 * inbox，除非调用方显式选择 project/user。
 */
export async function acceptMaintenanceProposal(
  rootDir: string,
  proposalId: string,
  options: {
    skillTarget?: "project" | "user";
    projectRoot?: string;
    traeHome?: string;
  }
): Promise<ProposalActionResult> {
  const proposal = await showMaintenanceProposal(rootDir, proposalId);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}: ${proposalId}`);
  }

  let candidatePath: string | undefined;
  let skillPath: string | undefined;
  if (proposal.type === "skill") {
    if (!proposal.skillDraft) {
      throw new Error(`Skill proposal has no draft: ${proposalId}`);
    }
    skillPath = await writeSkillDraft(rootDir, proposal, options);
  } else if (proposal.type !== "duplicate") {
    const result = await writeCandidateMemory(rootDir, {
      title: proposal.title,
      memory_type: proposal.type === "consolidation" ? "semantic" : "semantic",
      domain: proposal.domain,
      related_domains: [],
      scenario: ["maintenance-review"],
      tags: ["maintenance", proposal.type],
      confidence: 0.6,
      source_authority: "model_inferred",
      summary: proposal.proposedSummary,
      evidence: proposal.observationIds.map((id) => `observation:${id}`),
      capture_mode: "automated_session",
      actor_type: "agent",
      corroboration_count: proposal.observationIds.length,
      supersedes: proposal.type === "update" ? proposal.targetMemoryIds : [],
      conflicts_with: proposal.type === "conflict" ? proposal.targetMemoryIds : []
    });
    candidatePath = result.filePath;
  }

  const updated: MaintenanceProposal = {
    ...proposal,
    status: "accepted",
    updatedAt: new Date().toISOString(),
    resolution: "accepted",
    candidatePath,
    skillPath
  };
  await writeMaintenanceProposal(rootDir, updated);
  return { proposalId, status: "accepted", candidatePath, skillPath };
}

/**
 * 用户审阅 inbox 草稿后，安装已接受的 Skill proposal。
 *
 * 第二阶段把 proposal 接受和外部 Skill 写入分开；安装 target 始终显式，并复用一步式接受的
 * no-overwrite 边界。
 */
export async function installAcceptedSkillProposal(
  rootDir: string,
  proposalId: string,
  options: {
    skillTarget: "project" | "user";
    projectRoot?: string;
    traeHome?: string;
  }
): Promise<ProposalActionResult> {
  const proposal = await showMaintenanceProposal(rootDir, proposalId);
  if (proposal.type !== "skill") {
    throw new Error(`Proposal is not a Skill proposal: ${proposalId}`);
  }
  if (proposal.status !== "accepted") {
    throw new Error(`Skill proposal must be accepted before installation: ${proposalId}`);
  }
  if (!proposal.skillDraft) {
    throw new Error(`Skill proposal has no draft: ${proposalId}`);
  }
  const skillPath = await writeSkillDraft(rootDir, proposal, options);
  await writeMaintenanceProposal(rootDir, {
    ...proposal,
    updatedAt: new Date().toISOString(),
    resolution: "accepted_and_installed",
    skillPath
  });
  return { proposalId, status: "accepted", skillPath };
}

/** 拒绝 pending proposal，同时保留证据和草稿用于审计。 */
export async function rejectMaintenanceProposal(
  rootDir: string,
  proposalId: string,
  reason: string
): Promise<ProposalActionResult> {
  const proposal = await showMaintenanceProposal(rootDir, proposalId);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}: ${proposalId}`);
  }
  await writeMaintenanceProposal(rootDir, {
    ...proposal,
    status: "rejected",
    updatedAt: new Date().toISOString(),
    resolution: reason
  });
  return { proposalId, status: "rejected" };
}

/**
 * 把 Skill 草稿写入审阅 inbox 或显式安装根目录。
 * Proposal 无法证明外部 Skill 的所有权，因此已有文件永远不能替换。
 */
async function writeSkillDraft(
  rootDir: string,
  proposal: MaintenanceProposal,
  options: {
    skillTarget?: "project" | "user";
    projectRoot?: string;
    traeHome?: string;
  }
): Promise<string> {
  const skillName = parseSkillName(proposal.skillDraft!);
  let target: string;
  if (options.skillTarget === "project") {
    target = path.join(
      path.resolve(options.projectRoot ?? process.cwd()),
      ".trae",
      "skills",
      skillName,
      "SKILL.md"
    );
  } else if (options.skillTarget === "user") {
    target = path.join(
      path.resolve(options.traeHome ?? process.env.TRAE_HOME ?? path.join(process.env.HOME ?? "", ".trae")),
      "skills",
      skillName,
      "SKILL.md"
    );
  } else {
    target = resolveWorkspacePath(
      rootDir,
      "knowledge",
      "_inbox-skills",
      proposal.id,
      "SKILL.md"
    );
  }
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite existing Skill: ${target}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, proposal.skillDraft!, "utf8");
  return target;
}

/** 从 Skill Markdown frontmatter 解析必需的 `name`，并限制为安全目录名。 */
function parseSkillName(skillDraft: string): string {
  const match = skillDraft.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("Skill draft is missing YAML frontmatter");
  }
  const metadata = yaml.load(match[1]!) as { name?: unknown };
  if (
    typeof metadata.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name)
  ) {
    throw new Error("Skill draft has an invalid name");
  }
  return metadata.name;
}
