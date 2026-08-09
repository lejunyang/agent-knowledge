import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAutomationService } from "../src/automation/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("background service templates", () => {
  it("renders launchd with absolute runner/profile paths and no credentials", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "ak-launchd-"));
    tempDirs.push(output);
    const result = await renderAutomationService({
      manager: "launchd",
      label: "business-refresh",
      profilePath: "/secure/agent-knowledge/profile.json",
      runnerPath: "/opt/agent-runners/run-knowledge-agent",
      intervalMinutes: 30,
      outputDir: output
    });

    const plist = await readFile(result.files[0]!, "utf8");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>1800</integer>");
    expect(plist).toContain("/opt/agent-runners/run-knowledge-agent");
    expect(plist).toContain("/secure/agent-knowledge/profile.json");
    expect(plist).toContain("knowledge-automation-system-prompt.md");
    expect(plist).toContain("notifications deliver");
    expect(plist).not.toMatch(/token|password|secret/i);
    expect((await stat(result.files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("renders a systemd oneshot service and persistent timer", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "ak-systemd-"));
    tempDirs.push(output);
    const result = await renderAutomationService({
      manager: "systemd",
      label: "business-refresh",
      profilePath: "/secure/agent-knowledge/profile.json",
      runnerPath: "/opt/agent-runners/run-knowledge-agent",
      intervalMinutes: 15,
      outputDir: output,
      environmentFilePath: "/secure/agent-knowledge/automation.env"
    });

    expect(result.files).toHaveLength(2);
    const service = await readFile(
      result.files.find((file) => file.endsWith(".service"))!,
      "utf8"
    );
    const timer = await readFile(
      result.files.find((file) => file.endsWith(".timer"))!,
      "utf8"
    );
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/opt/agent-runners/run-knowledge-agent");
    expect(service).toContain(
      "AGENT_KNOWLEDGE_AUTOMATION_PROFILE=/secure/agent-knowledge/profile.json"
    );
    expect(service).toContain(
      "EnvironmentFile=-/secure/agent-knowledge/automation.env"
    );
    expect(timer).toContain("OnUnitActiveSec=15min");
    expect(timer).toContain("Persistent=true");
  });

  it("renders Docker Compose with explicit mounts and restart policy", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "ak-docker-service-"));
    tempDirs.push(output);
    const result = await renderAutomationService({
      manager: "docker",
      label: "business-refresh",
      profilePath: "/secure/agent-knowledge/profile.json",
      runnerPath: "/opt/agent-runners/run-knowledge-agent",
      intervalMinutes: 60,
      outputDir: output,
      workspacePath: "/srv/agent-knowledge-data",
      environmentFilePath: "/secure/agent-knowledge/automation.env"
    });

    const compose = await readFile(
      result.files.find((file) => file.endsWith("compose.yaml"))!,
      "utf8"
    );
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain(
      "/secure/agent-knowledge/profile.json:/config/profile.json:ro"
    );
    expect(compose).toContain(
      "/srv/agent-knowledge-data:/data/agent-knowledge"
    );
    expect(compose).toContain("AGENT_KNOWLEDGE_INTERVAL_MINUTES: \"60\"");
    expect(compose).toContain(
      "/secure/agent-knowledge/automation.env"
    );
    expect(compose).not.toContain("Bearer ");
  });

  it("rejects relative runner/profile paths and unsafe labels", async () => {
    await expect(
      renderAutomationService({
        manager: "launchd",
        label: "../unsafe",
        profilePath: "profile.json",
        runnerPath: "runner",
        intervalMinutes: 30,
        outputDir: "/tmp/output"
      })
    ).rejects.toThrow();
  });
});
