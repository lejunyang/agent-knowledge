/**
 * The maintenance worker converts bounded observations into review proposals.
 *
 * It is deterministic and deliberately does not call an LLM or modify active Markdown. Semantic
 * extraction may happen before this boundary; after this boundary every action is auditable JSON.
 */
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../core/paths.js";
import type { EpisodeProvenance } from "../core/types.js";
import { catalogKnowledge } from "../storage/catalog.js";
import {
  maintenanceProposalId,
  readMaintenanceProposals,
  writeMaintenanceProposal,
  type MaintenanceProposal
} from "./proposals.js";

export type MaintenanceObservation = {
  id: string;
  title: string;
  domain: string;
  summary: string;
  sessionHash: string;
  sourceAuthority: "user_confirmed" | "model_inferred" | "documented" | "verified_task";
  supersedes?: string;
  conflictsWith?: string;
  memoryType?: "profile" | "semantic" | "episodic" | "procedural";
  usefulFeedback?: number;
  episode?: EpisodeProvenance;
};

export type MaintenanceResult = {
  processed: number;
  watermarkBefore: number;
  watermarkAfter: number;
  proposalIds: string[];
};

type MaintenanceState = {
  watermark: number;
  updatedAt: string;
};

export async function generateMaintenanceProposals(
  rootDir: string,
  observations: MaintenanceObservation[],
  options: { limit: number; lockStaleMs?: number }
): Promise<MaintenanceResult> {
  const release = await acquireMaintenanceLock(
    rootDir,
    options.lockStaleMs ?? 10 * 60 * 1000
  );
  try {
    const state = await readState(rootDir);
    const watermarkBefore = Math.min(state.watermark, observations.length);
    const selected = observations.slice(
      watermarkBefore,
      watermarkBefore + Math.max(0, options.limit)
    );
    if (selected.length === 0) {
      return {
        processed: 0,
        watermarkBefore,
        watermarkAfter: watermarkBefore,
        proposalIds: []
      };
    }

    const catalog = await catalogKnowledge(rootDir, { write: false });
    const proposals: MaintenanceProposal[] = [];
    for (const observation of selected) {
      const target = findRelatedMemory(catalog.items, observation);
      const proposal = proposalForObservation(observation, target);
      proposals.push(proposal);
      await writeMaintenanceProposal(rootDir, proposal);
    }

    const watermarkAfter = watermarkBefore + selected.length;
    for (const skillProposal of skillProposalsForObservations(
      observations.slice(0, watermarkAfter)
    )) {
      proposals.push(skillProposal);
      await writeMaintenanceProposal(rootDir, skillProposal);
    }

    await writeState(rootDir, {
      watermark: watermarkAfter,
      updatedAt: new Date().toISOString()
    });
    return {
      processed: selected.length,
      watermarkBefore,
      watermarkAfter,
      proposalIds: proposals.map((proposal) => proposal.id)
    };
  } finally {
    await release();
  }
}

export { readMaintenanceProposals };

export function getMaintenanceLockPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "maintenance.lock");
}

function proposalForObservation(
  observation: MaintenanceObservation,
  relatedMemory:
    | Awaited<ReturnType<typeof catalogKnowledge>>["items"][number]
    | undefined
): MaintenanceProposal {
  let type: MaintenanceProposal["type"] = "consolidation";
  let reason = relatedMemory
    ? "Observation overlaps an existing memory and should be reviewed for consolidation."
    : "Observation is reusable but has no exact active target; review before creating a candidate.";
  const targetMemoryIds = relatedMemory ? [relatedMemory.id] : [];

  if (observation.supersedes) {
    type = "update";
    reason = "Observation explicitly proposes replacing an existing memory.";
    targetMemoryIds.splice(0, targetMemoryIds.length, observation.supersedes);
  } else if (observation.conflictsWith) {
    type = "conflict";
    reason = "Observation explicitly conflicts with an existing memory.";
    targetMemoryIds.splice(0, targetMemoryIds.length, observation.conflictsWith);
  } else if (relatedMemory) {
    const observationSummary = normalize(observation.summary);
    const memorySummary = normalize(relatedMemory.summary);
    type =
      observationSummary === memorySummary ||
      memorySummary.includes(observationSummary) ||
      observationSummary.includes(memorySummary)
        ? "duplicate"
        : "consolidation";
    if (type === "duplicate") {
      reason = "Observation matches an existing memory title and summary.";
    }
  }

  const id = maintenanceProposalId({
    type,
    domain: observation.domain,
    observationIds: [observation.id],
    targetMemoryIds
  });
  return {
    version: 1,
    id,
    type,
    createdAt: new Date().toISOString(),
    domain: observation.domain,
    title: observation.title,
    observationIds: [observation.id],
    targetMemoryIds,
    reason,
    proposedSummary: observation.summary
  };
}

function findRelatedMemory(
  items: Awaited<ReturnType<typeof catalogKnowledge>>["items"],
  observation: MaintenanceObservation
): (typeof items)[number] | undefined {
  const normalizedTitle = normalize(observation.title);
  return items.find(
    (item) =>
      item.status === "active" &&
      item.domain === observation.domain &&
      (normalize(item.title) === normalizedTitle ||
        item.aliases.some((alias) => normalize(alias) === normalizedTitle))
  );
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function skillProposalsForObservations(
  observations: MaintenanceObservation[]
): MaintenanceProposal[] {
  const groups = new Map<string, MaintenanceObservation[]>();
  for (const observation of observations) {
    if (observation.memoryType !== "procedural") {
      continue;
    }
    const key = [
      normalize(observation.domain),
      normalize(observation.title),
      normalize(observation.summary)
    ].join("\u0000");
    const bucket = groups.get(key) ?? [];
    bucket.push(observation);
    groups.set(key, bucket);
  }

  const proposals: MaintenanceProposal[] = [];
  for (const group of groups.values()) {
    const sessions = new Set(group.map((observation) => observation.sessionHash));
    const trusted = group.every(
      (observation) =>
        observation.sourceAuthority === "verified_task" ||
        observation.sourceAuthority === "user_confirmed"
    );
    const positiveFeedback = group.every(
      (observation) => (observation.usefulFeedback ?? 0) > 0
    );
    const hasConflict = group.some((observation) => Boolean(observation.conflictsWith));
    if (sessions.size < 3 || !trusted || !positiveFeedback || hasConflict) {
      continue;
    }
    const first = group[0]!;
    const observationIds = group.map((observation) => observation.id).sort();
    const id = maintenanceProposalId({
      type: "skill",
      domain: first.domain,
      observationIds,
      targetMemoryIds: []
    });
    proposals.push({
      version: 1,
      id,
      type: "skill",
      createdAt: new Date().toISOString(),
      domain: first.domain,
      title: first.title,
      observationIds,
      targetMemoryIds: [],
      reason:
        "The procedure succeeded in at least three independent sessions with trusted evidence and positive feedback.",
      proposedSummary: first.summary,
      skillDraft: renderSkillDraft(first)
    });
  }
  return proposals;
}

function renderSkillDraft(observation: MaintenanceObservation): string {
  const name = observation.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "proposed-procedure";
  return `---
name: ${name}
description: ${observation.summary}
---

# ${observation.title}

${observation.summary}
`;
}

async function readState(rootDir: string): Promise<MaintenanceState> {
  const target = resolveWorkspacePath(rootDir, ".memory", "maintenance-state.json");
  if (!existsSync(target)) {
    return { watermark: 0, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<MaintenanceState>;
  return {
    watermark:
      typeof parsed.watermark === "number" && Number.isInteger(parsed.watermark)
        ? parsed.watermark
        : 0,
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
  };
}

async function writeState(rootDir: string, state: MaintenanceState): Promise<void> {
  const target = resolveWorkspacePath(rootDir, ".memory", "maintenance-state.json");
  await mkdir(resolveWorkspacePath(rootDir, ".memory"), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function acquireMaintenanceLock(
  rootDir: string,
  staleMs: number
): Promise<() => Promise<void>> {
  const target = getMaintenanceLockPath(rootDir);
  await mkdir(resolveWorkspacePath(rootDir, ".memory"), { recursive: true });
  if (existsSync(target)) {
    const lockStat = await stat(target);
    if (Date.now() - lockStat.mtimeMs > staleMs) {
      await rm(target, { force: true });
    } else {
      throw new Error("Maintenance is already in progress");
    }
  }
  try {
    const handle = await open(target, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    await handle.close();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Maintenance is already in progress");
    }
    throw error;
  }
  return async () => {
    await rm(target, { force: true });
  };
}
