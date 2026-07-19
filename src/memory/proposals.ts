/**
 * Maintenance proposal 是机器可读的审阅产物，不是知识事实。
 *
 * 它们位于 `.memory/proposals`，可以重建，且永远不能绕过 inbox 和人工审阅。
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
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  domain: z.string().min(1),
  title: z.string().min(1),
  observationIds: z.array(z.string()).min(1),
  targetMemoryIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
  proposedSummary: z.string().min(1),
  skillDraft: z.string().optional(),
  resolution: z.string().optional(),
  candidatePath: z.string().optional(),
  skillPath: z.string().optional()
});

export type MaintenanceProposal = z.output<typeof MaintenanceProposalSchema>;
export type MaintenanceProposalInput = z.input<typeof MaintenanceProposalSchema>;

/**
 * 根据 proposal 语义身份生成稳定 ID。
 *
 * observation/target 排序后再 hash，使重复 worker 或不同输入顺序不会产生重复 proposal。
 */
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

/**
 * 校验并原子写入单个 proposal，避免读者观察到半写 JSON。
 */
export async function writeMaintenanceProposal(
  rootDir: string,
  rawProposal: MaintenanceProposalInput
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

/**
 * 按文件名稳定顺序读取全部 proposal，并在边界处重新执行 schema 校验。
 */
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
