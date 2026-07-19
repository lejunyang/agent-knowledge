import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateMaintenanceProposals,
  getMaintenanceLockPath,
  readMaintenanceProposals,
  type MaintenanceObservation
} from "../src/memory/maintenance.js";
import { initKnowledgeWorkspace } from "../src/storage/workspace.js";
import { captureMaterial } from "../src/memory/organizer.js";
import { logMemoryFeedback } from "../src/retrieval/feedback.js";
import { writeMaintenanceProposal } from "../src/memory/proposals.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-maintenance-"));
  tempDirs.push(root);
  await initKnowledgeWorkspace(root);
  return root;
}

describe("maintenance proposals", () => {
  it("generates duplicate, consolidation, update, and conflict proposals without changing active Markdown", async () => {
    const root = await createRoot();
    const active = await captureMaterial(
      root,
      [
        {
          title: "Refund approval",
          aliases: ["refund review"],
          memory_type: "semantic",
          domain: "support/refund",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["refund"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "High-value refunds require one reviewer.",
          evidence: ["owner:confirmed"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const activePath = active.written[0]!.filePath;
    const before = await readFile(activePath, "utf8");
    const observations: MaintenanceObservation[] = [
      {
        id: "obs-duplicate",
        title: "Refund approval",
        domain: "support/refund",
        summary: "High-value refunds require one reviewer.",
        sessionHash: "session-a",
        sourceAuthority: "model_inferred"
      },
      {
        id: "obs-consolidate",
        title: "Refund review rule",
        domain: "support/refund",
        summary: "Refunds above the threshold require an authorized reviewer.",
        sessionHash: "session-b",
        sourceAuthority: "documented"
      },
      {
        id: "obs-update",
        title: "Refund approval",
        domain: "support/refund",
        summary: "The new policy requires two reviewers.",
        sessionHash: "session-c",
        sourceAuthority: "user_confirmed",
        supersedes: active.written[0]!.id
      },
      {
        id: "obs-conflict",
        title: "Refund approval exception",
        domain: "support/refund",
        summary: "Customer claims never require review.",
        sessionHash: "session-d",
        sourceAuthority: "model_inferred",
        conflictsWith: active.written[0]!.id
      }
    ];

    const result = await generateMaintenanceProposals(root, observations, { limit: 10 });
    const after = await readFile(activePath, "utf8");
    const proposals = await readMaintenanceProposals(root);

    expect(result.processed).toBe(4);
    expect(proposals.map((proposal) => proposal.type).sort()).toEqual([
      "conflict",
      "consolidation",
      "duplicate",
      "update"
    ]);
    expect(after).toBe(before);
  });

  it("uses a watermark and remains idempotent across repeated runs", async () => {
    const root = await createRoot();
    const observations: MaintenanceObservation[] = [
      {
        id: "obs-1",
        title: "Project rule",
        domain: "project/rule",
        summary: "A stable project rule.",
        sessionHash: "session-a",
        sourceAuthority: "documented"
      },
      {
        id: "obs-2",
        title: "Project rule detail",
        domain: "project/rule",
        summary: "Another stable project rule.",
        sessionHash: "session-b",
        sourceAuthority: "documented"
      }
    ];

    const first = await generateMaintenanceProposals(root, observations, { limit: 1 });
    const second = await generateMaintenanceProposals(root, observations, { limit: 10 });
    const third = await generateMaintenanceProposals(root, observations, { limit: 10 });

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(1);
    expect(third.processed).toBe(0);
    expect(third.watermarkBefore).toBe(2);
    const proposalFiles = await readdir(path.join(root, ".memory", "proposals"));
    expect(new Set(proposalFiles).size).toBe(proposalFiles.length);
  });

  it("recovers stale locks and rejects concurrent maintenance runs", async () => {
    const root = await createRoot();
    const lockPath = getMaintenanceLockPath(root);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "locked", "utf8");
    const observations: MaintenanceObservation[] = [
      {
        id: "locked-1",
        title: "Locked rule",
        domain: "project/rule",
        summary: "Rule summary",
        sessionHash: "session-a",
        sourceAuthority: "documented"
      }
    ];

    await expect(
      generateMaintenanceProposals(root, observations, {
        limit: 10,
        lockStaleMs: 60_000
      })
    ).rejects.toThrow("already in progress");

    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    const result = await generateMaintenanceProposals(root, observations, {
      limit: 10,
      lockStaleMs: 60_000
    });

    expect(result.processed).toBe(1);
  });

  it("writes proposal files and state under .memory only", async () => {
    const root = await createRoot();
    await generateMaintenanceProposals(
      root,
      [
        {
          id: "obs-1",
          title: "Rule",
          domain: "project/rule",
          summary: "Rule summary",
          sessionHash: "session-a",
          sourceAuthority: "documented"
        }
      ],
      { limit: 10 }
    );

    await expect(stat(path.join(root, ".memory", "proposals"))).resolves.toBeDefined();
    await expect(stat(path.join(root, ".memory", "maintenance-state.json"))).resolves.toBeDefined();
    const semanticEntries = await readdir(path.join(root, "knowledge", "semantic"));
    expect(semanticEntries).toEqual([]);
  });

  it("proposes a reusable Skill only after three independent verified episodes", async () => {
    const root = await createRoot();
    const observations: MaintenanceObservation[] = [
      {
        id: "proc-1",
        title: "Release validation",
        domain: "delivery/release",
        summary: "Run tests, typecheck, build, and smoke verification.",
        sessionHash: "session-a",
        sourceAuthority: "verified_task",
        memoryType: "procedural",
        usefulFeedback: 1
      },
      {
        id: "proc-2",
        title: "Release validation",
        domain: "delivery/release",
        summary: "Run tests, typecheck, build, and smoke verification.",
        sessionHash: "session-b",
        sourceAuthority: "verified_task",
        memoryType: "procedural",
        usefulFeedback: 1
      },
      {
        id: "proc-3",
        title: "Release validation",
        domain: "delivery/release",
        summary: "Run tests, typecheck, build, and smoke verification.",
        sessionHash: "session-c",
        sourceAuthority: "verified_task",
        memoryType: "procedural",
        usefulFeedback: 1
      }
    ];

    await generateMaintenanceProposals(root, observations, { limit: 10 });
    const proposals = await readMaintenanceProposals(root);
    const skill = proposals.find((proposal) => proposal.type === "skill");

    expect(skill?.observationIds).toHaveLength(3);
    expect(skill?.skillDraft).toContain("name: release-validation");
    await expect(stat(path.join(root, ".trae", "skills"))).rejects.toThrow();
  });

  it("aggregates Skill eligibility across bounded maintenance batches", async () => {
    const root = await createRoot();
    const observations: MaintenanceObservation[] = ["a", "b", "c"].map((session, index) => ({
      id: `batch-${index + 1}`,
      title: "Deploy checklist",
      domain: "delivery/deploy",
      summary: "Validate tests, build, rollout, and rollback.",
      sessionHash: `session-${session}`,
      sourceAuthority: "verified_task" as const,
      memoryType: "procedural" as const,
      usefulFeedback: 1
    }));

    await generateMaintenanceProposals(root, observations, { limit: 1 });
    await generateMaintenanceProposals(root, observations, { limit: 1 });
    await generateMaintenanceProposals(root, observations, { limit: 1 });
    const proposals = await readMaintenanceProposals(root);

    expect(proposals.some((proposal) => proposal.type === "skill")).toBe(true);
  });

  it("does not propose a Skill for repeated events from the same session or unresolved conflict", async () => {
    const root = await createRoot();
    const observations: MaintenanceObservation[] = [
      {
        id: "same-1",
        title: "Unsafe process",
        domain: "delivery/release",
        summary: "Do the same thing.",
        sessionHash: "same-session",
        sourceAuthority: "verified_task",
        memoryType: "procedural",
        usefulFeedback: 1
      },
      {
        id: "same-2",
        title: "Unsafe process",
        domain: "delivery/release",
        summary: "Do the same thing.",
        sessionHash: "same-session",
        sourceAuthority: "verified_task",
        memoryType: "procedural",
        usefulFeedback: 1
      },
      {
        id: "same-3",
        title: "Unsafe process",
        domain: "delivery/release",
        summary: "Do the same thing.",
        sessionHash: "same-session",
        sourceAuthority: "verified_task",
        memoryType: "procedural",
        usefulFeedback: 1,
        conflictsWith: "k_existing"
      }
    ];

    await generateMaintenanceProposals(root, observations, { limit: 10 });
    const proposals = await readMaintenanceProposals(root);

    expect(proposals.some((proposal) => proposal.type === "skill")).toBe(false);
  });

  it("uses persisted retrieval feedback to qualify repeated verified procedures", async () => {
    const root = await createRoot();
    const active = await captureMaterial(
      root,
      [
        {
          title: "Release validation",
          memory_type: "procedural",
          domain: "delivery/release",
          related_domains: [],
          scenario: ["release"],
          tags: ["validation"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Run tests, typecheck, build, and smoke verification.",
          evidence: ["owner:confirmed"]
        }
      ],
      { target: "active", rebuild: false }
    );
    for (const queryRunId of ["query-release-1", "query-release-2", "query-release-3"]) {
      logMemoryFeedback(root, {
        memoryId: active.written[0]!.id,
        usefulness: "useful",
        queryRunId
      });
    }
    const observations: MaintenanceObservation[] = ["a", "b", "c"].map(
      (session, index) => ({
        id: `feedback-${index + 1}`,
        title: "Release validation",
        domain: "delivery/release",
        summary: "Run tests, typecheck, build, and smoke verification.",
        sessionHash: `session-${session}`,
        sourceAuthority: "verified_task" as const,
        memoryType: "procedural" as const
      })
    );

    await generateMaintenanceProposals(root, observations, { limit: 10 });
    const proposals = await readMaintenanceProposals(root);

    expect(proposals.some((proposal) => proposal.type === "skill")).toBe(true);
  });

  it("rechecks consumed observations when useful feedback arrives later", async () => {
    const root = await createRoot();
    const active = await captureMaterial(
      root,
      [
        {
          title: "Deploy checklist",
          memory_type: "procedural",
          domain: "delivery/deploy",
          related_domains: [],
          scenario: ["deploy"],
          tags: ["checklist"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Validate tests, build, rollout, and rollback.",
          evidence: ["owner:confirmed"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const observations: MaintenanceObservation[] = ["a", "b", "c"].map(
      (session, index) => ({
        id: `late-${index + 1}`,
        title: "Deploy checklist",
        domain: "delivery/deploy",
        summary: "Validate tests, build, rollout, and rollback.",
        sessionHash: `session-${session}`,
        sourceAuthority: "verified_task" as const,
        memoryType: "procedural" as const
      })
    );

    const first = await generateMaintenanceProposals(root, observations, {
      limit: 10
    });
    expect(first.processed).toBe(3);
    expect(
      (await readMaintenanceProposals(root)).some(
        (proposal) => proposal.type === "skill"
      )
    ).toBe(false);

    for (const queryRunId of ["query-deploy-1", "query-deploy-2", "query-deploy-3"]) {
      logMemoryFeedback(root, {
        memoryId: active.written[0]!.id,
        usefulness: "useful",
        queryRunId
      });
    }
    const second = await generateMaintenanceProposals(root, observations, {
      limit: 10
    });

    expect(second.processed).toBe(0);
    expect(second.proposalIds).toHaveLength(1);
    expect(
      (await readMaintenanceProposals(root)).some(
        (proposal) => proposal.type === "skill"
      )
    ).toBe(true);
  });

  it("does not reset an existing resolved proposal to pending", async () => {
    const root = await createRoot();
    const observation: MaintenanceObservation = {
      id: "resolved-1",
      title: "Resolved rule",
      domain: "project/rule",
      summary: "A stable project rule.",
      sessionHash: "session-a",
      sourceAuthority: "documented"
    };
    await generateMaintenanceProposals(root, [observation], { limit: 10 });
    const [proposal] = await readMaintenanceProposals(root);
    await writeMaintenanceProposal(root, {
      ...proposal!,
      status: "rejected",
      resolution: "Reviewed and rejected",
      updatedAt: "2026-07-19T12:00:00.000Z"
    });
    await rm(path.join(root, ".memory", "maintenance-state.json"));

    await generateMaintenanceProposals(root, [observation], { limit: 10 });
    const [after] = await readMaintenanceProposals(root);

    expect(after?.status).toBe("rejected");
    expect(after?.resolution).toBe("Reviewed and rejected");
  });

  it("does not count repeated feedback for the same query as independent positive evidence", async () => {
    const root = await createRoot();
    const active = await captureMaterial(
      root,
      [
        {
          title: "Rollback checklist",
          memory_type: "procedural",
          domain: "delivery/rollback",
          related_domains: [],
          scenario: ["rollback"],
          tags: ["checklist"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Validate rollback state and service recovery.",
          evidence: ["owner:confirmed"]
        }
      ],
      { target: "active", rebuild: false }
    );
    for (let index = 0; index < 3; index += 1) {
      logMemoryFeedback(root, {
        memoryId: active.written[0]!.id,
        usefulness: "useful",
        queryRunId: "same-query"
      });
    }
    logMemoryFeedback(root, {
      memoryId: active.written[0]!.id,
      usefulness: "not_useful",
      queryRunId: "same-query"
    });
    for (const queryRunId of ["other-query-1", "other-query-2", "other-query-3"]) {
      logMemoryFeedback(root, {
        memoryId: active.written[0]!.id,
        usefulness: "useful",
        queryRunId
      });
    }
    const observations: MaintenanceObservation[] = ["a", "b", "c"].map(
      (session, index) => ({
        id: `dedupe-${index + 1}`,
        title: "Rollback checklist",
        domain: "delivery/rollback",
        summary: "Validate rollback state and service recovery.",
        sessionHash: `session-${session}`,
        sourceAuthority: "verified_task" as const,
        memoryType: "procedural" as const
      })
    );

    await generateMaintenanceProposals(root, observations, { limit: 10 });

    expect(
      (await readMaintenanceProposals(root)).some(
        (proposal) => proposal.type === "skill"
      )
    ).toBe(false);
  });
});
