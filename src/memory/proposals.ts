/**
 * Maintenance proposals are machine-readable review artifacts, not knowledge facts.
 *
 * They live under `.memory/proposals`, can be regenerated, and never bypass inbox/human review.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";

export const MaintenanceProposalTypeSchema = z.enum([
  "duplicate",
  "consolidation",
  "update",
  "conflict",
  "skill"
]);

export const MaintenanceProposalSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  type: MaintenanceProposalTypeSchema,
  createdAt: z.string().datetime(),
  domain: z.string().min(1),
  title: z.string().min(1),
  observationIds: z.array(z.string()).min(1),
  targetMemoryIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
  proposedSummary: z.string().min(1),
  skillDraft: z.string().optional()
});

export type MaintenanceProposal = z.output<typeof MaintenanceProposalSchema>;

export function maintenanceProposalId(input: {
  type: string;
  domain: string;
  observationIds: string[];
  targetMemoryIds: string[];
}): string {
  return `proposal_${createHash("sha256")
    .update(
      JSON.stringify({
        type: input.type,
        domain: input.domain,
        observationIds: [...input.observationIds].sort(),
        targetMemoryIds: [...input.targetMemoryIds].sort()
      })
    )
    .digest("hex")
    .slice(0, 20)}`;
}

export async function writeMaintenanceProposal(
  rootDir: string,
  rawProposal: MaintenanceProposal
): Promise<string> {
  const proposal = MaintenanceProposalSchema.parse(rawProposal);
  const directory = resolveWorkspacePath(rootDir, ".memory", "proposals");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${proposal.id}.json`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return target;
}

export async function readMaintenanceProposals(rootDir: string): Promise<MaintenanceProposal[]> {
  const directory = resolveWorkspacePath(rootDir, ".memory", "proposals");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const proposals: MaintenanceProposal[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      proposals.push(
        MaintenanceProposalSchema.parse(
          JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
        )
      );
    }
    return proposals;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
