/**
 * Proposal actions are the only bridge from machine review artifacts to inbox/Skill files.
 *
 * Accepting a proposal never activates knowledge. Knowledge changes become `_inbox` candidates;
 * Skill installation requires an explicit target and refuses to overwrite existing files.
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

/** Returns one proposal by ID or throws a clear lookup error. */
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
 * Accepts one pending proposal.
 *
 * Duplicate proposals only update audit status. Knowledge changes become conservative model-inferred
 * inbox candidates. Skill drafts stay in an inbox unless the caller explicitly selects project/user.
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

/** Marks a pending proposal rejected while preserving its evidence and draft. */
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
 * Writes a Skill draft to the review inbox or an explicitly selected installation root.
 * Existing files are never replaced because a proposal cannot prove ownership of external Skills.
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

/** Parses the required `name` field from a Skill Markdown frontmatter block. */
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
