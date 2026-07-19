import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptMaintenanceProposal,
  installAcceptedSkillProposal,
  rejectMaintenanceProposal,
  showMaintenanceProposal
} from "../src/memory/proposalActions.js";
import { writeMaintenanceProposal } from "../src/memory/proposals.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("proposal actions", () => {
  it("accepts consolidation/update/conflict proposals into knowledge inbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-accept-"));
    tempDirs.push(root);
    await writeMaintenanceProposal(root, {
      version: 1,
      id: "proposal_update",
      type: "update",
      status: "pending",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      domain: "support/refund",
      title: "Refund update",
      observationIds: ["obs-1"],
      targetMemoryIds: ["k_old"],
      reason: "new verified rule",
      proposedSummary: "Refunds now require two reviewers."
    });

    const result = await acceptMaintenanceProposal(root, "proposal_update", {});
    const proposal = await showMaintenanceProposal(root, "proposal_update");

    expect(result.candidatePath).toContain("knowledge/_inbox/");
    await expect(readFile(result.candidatePath!, "utf8")).resolves.toContain("Refunds now require two reviewers.");
    expect(proposal.status).toBe("accepted");
    expect(proposal.candidatePath).toBe(result.candidatePath);
  });

  it("marks duplicate proposals accepted without creating a candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-duplicate-"));
    tempDirs.push(root);
    await writeMaintenanceProposal(root, {
      version: 1,
      id: "proposal_duplicate",
      type: "duplicate",
      status: "pending",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      domain: "support/refund",
      title: "Refund rule",
      observationIds: ["obs-1"],
      targetMemoryIds: ["k_existing"],
      reason: "same content",
      proposedSummary: "Existing content"
    });

    const result = await acceptMaintenanceProposal(root, "proposal_duplicate", {});

    expect(result.candidatePath).toBeUndefined();
    expect((await showMaintenanceProposal(root, "proposal_duplicate")).status).toBe("accepted");
  });

  it("writes Skill proposals to inbox by default and installs only with explicit target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-skill-"));
    const project = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-project-"));
    const userHome = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-user-"));
    tempDirs.push(root, project, userHome);
    const proposal = {
      version: 1 as const,
      id: "proposal_skill",
      type: "skill" as const,
      status: "pending" as const,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      domain: "delivery/release",
      title: "Release validation",
      observationIds: ["obs-1", "obs-2", "obs-3"],
      targetMemoryIds: [],
      reason: "three verified sessions",
      proposedSummary: "Run tests and build.",
      skillDraft: "---\nname: release-validation\ndescription: Validate release\n---\n\n# Release validation\n"
    };
    await writeMaintenanceProposal(root, proposal);

    const inbox = await acceptMaintenanceProposal(root, "proposal_skill", {});
    expect(inbox.skillPath).toContain("knowledge/_inbox-skills/proposal_skill/SKILL.md");

    const projectResult = await installAcceptedSkillProposal(
      root,
      "proposal_skill",
      {
      skillTarget: "project",
      projectRoot: project
      }
    );
    expect(projectResult.skillPath).toBe(path.join(project, ".trae", "skills", "release-validation", "SKILL.md"));

    await writeMaintenanceProposal(root, {
      ...proposal,
      id: "proposal_skill_user",
      status: "pending",
      updatedAt: "2026-07-19T00:02:00.000Z"
    });
    await acceptMaintenanceProposal(root, "proposal_skill_user", {});
    const userResult = await installAcceptedSkillProposal(root, "proposal_skill_user", {
      skillTarget: "user",
      traeHome: userHome
    });
    expect(userResult.skillPath).toBe(path.join(userHome, "skills", "release-validation", "SKILL.md"));
  });

  it("rejects overwrite conflicts and records explicit rejection reasons", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-conflict-"));
    const project = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-conflict-project-"));
    tempDirs.push(root, project);
    await writeMaintenanceProposal(root, {
      version: 1,
      id: "proposal_skill_conflict",
      type: "skill",
      status: "pending",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      domain: "delivery/release",
      title: "Release validation",
      observationIds: ["obs-1", "obs-2", "obs-3"],
      targetMemoryIds: [],
      reason: "verified",
      proposedSummary: "Run tests.",
      skillDraft: "---\nname: release-validation\ndescription: Validate\n---\n"
    });
    const existing = path.join(project, ".trae", "skills", "release-validation", "SKILL.md");
    await writeFile(existing, "existing", { encoding: "utf8", flag: "w" }).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(existing), { recursive: true });
      await writeFile(existing, "existing", "utf8");
    });

    await expect(
      acceptMaintenanceProposal(root, "proposal_skill_conflict", {
        skillTarget: "project",
        projectRoot: project
      })
    ).rejects.toThrow("Refusing to overwrite");
    await rejectMaintenanceProposal(root, "proposal_skill_conflict", "Not reusable");
    const rejected = await showMaintenanceProposal(root, "proposal_skill_conflict");

    expect(rejected.status).toBe("rejected");
    expect(rejected.resolution).toBe("Not reusable");
    await expect(stat(existing)).resolves.toBeDefined();
  });

  it("installs only accepted Skill proposals and still refuses existing targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-install-"));
    const project = await mkdtemp(path.join(tmpdir(), "agent-knowledge-proposal-install-project-"));
    tempDirs.push(root, project);
    await writeMaintenanceProposal(root, {
      version: 1,
      id: "proposal_install",
      type: "skill",
      status: "pending",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      domain: "delivery/release",
      title: "Release validation",
      observationIds: ["obs-1", "obs-2", "obs-3"],
      targetMemoryIds: [],
      reason: "verified",
      proposedSummary: "Run tests.",
      skillDraft: "---\nname: release-validation\ndescription: Validate\n---\n"
    });

    await expect(
      installAcceptedSkillProposal(root, "proposal_install", {
        skillTarget: "project",
        projectRoot: project
      })
    ).rejects.toThrow("must be accepted");

    await acceptMaintenanceProposal(root, "proposal_install", {});
    const target = path.join(
      project,
      ".trae",
      "skills",
      "release-validation",
      "SKILL.md"
    );
    await writeFile(target, "existing", { encoding: "utf8", flag: "w" }).catch(
      async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "existing", "utf8");
      }
    );

    await expect(
      installAcceptedSkillProposal(root, "proposal_install", {
        skillTarget: "project",
        projectRoot: project
      })
    ).rejects.toThrow("Refusing to overwrite");
  });
});
