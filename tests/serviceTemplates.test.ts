import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";
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
    expect(plist).toContain(path.join(output, "system-prompt.md"));
    expect(plist).toContain("notifications deliver");
    expect(plist).not.toMatch(/token|password|secret/i);
    expect((await stat(result.files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("exports KEY=value credentials from a launchd environment file", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "ak-launchd-env-"));
    tempDirs.push(output);
    const result = await renderAutomationService({
      manager: "launchd",
      label: "business-refresh",
      profilePath: "/secure/agent-knowledge/profile.json",
      runnerPath: "/opt/agent-runners/run-knowledge-agent",
      intervalMinutes: 30,
      outputDir: output,
      environmentFilePath: "/secure/agent-knowledge/automation.env"
    });

    const plist = await readFile(result.files[0]!, "utf8");
    expect(plist).toContain("Invalid environment variable name");
    expect(plist).toContain("export &quot;$line&quot;");
    expect(plist).toContain("<string>/secure/agent-knowledge/automation.env</string>");
    expect(plist).toContain("<string>/opt/agent-runners/run-knowledge-agent</string>");
    expect(plist).not.toContain("set -a");
  });

  it("resolves the default system prompt from the installed module instead of cwd", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "ak-launchd-cwd-"));
    tempDirs.push(output);
    const previousCwd = process.cwd();
    try {
      process.chdir(output);
      const result = await renderAutomationService({
        manager: "launchd",
        label: "business-refresh",
        profilePath: "/secure/agent-knowledge/profile.json",
        runnerPath: "/opt/agent-runners/run-knowledge-agent",
        intervalMinutes: 30,
        outputDir: output
      });
      const plist = await readFile(result.files[0]!, "utf8");
      const promptSnapshot = path.join(output, "system-prompt.md");
      const repositoryRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        ".."
      );
      expect(plist).toContain(promptSnapshot);
      expect(await readFile(promptSnapshot, "utf8")).toBe(
        await readFile(
          path.join(
          repositoryRoot,
          "templates",
          "automation",
          "knowledge-automation-system-prompt.md"
          ),
          "utf8"
        )
      );
      expect(plist).not.toContain(
        path.join(
          output,
          "templates",
          "automation",
          "knowledge-automation-system-prompt.md"
        )
      );
    } finally {
      process.chdir(previousCwd);
    }
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

    expect(result.files).toHaveLength(3);
    const service = await readFile(
      result.files.find((file) => file.endsWith(".service"))!,
      "utf8"
    );
    const timer = await readFile(
      result.files.find((file) => file.endsWith(".timer"))!,
      "utf8"
    );
    expect(service).toContain("Type=oneshot");
    expect(service).toContain(
      'ExecStart="/opt/agent-runners/run-knowledge-agent"'
    );
    expect(service).toContain(
      "AGENT_KNOWLEDGE_AUTOMATION_PROFILE=/secure/agent-knowledge/profile.json"
    );
    expect(service).toContain(
      'EnvironmentFile="/secure/agent-knowledge/automation.env"'
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
      environmentFilePath: "/secure/agent-knowledge/automation.env",
      containerImage: "registry.example.com/agent-knowledge:v1.2.3",
      containerReadOnlyMountPaths: ["/secure/eval", "/secure/sidecars"],
      containerReadWriteMountPaths: [
        "/projects/business",
        "/secure/exports",
        "/secure/reports"
      ]
    });

    const compose = await readFile(
      result.files.find((file) => file.endsWith("compose.yaml"))!,
      "utf8"
    );
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain(
      'image: "registry.example.com/agent-knowledge:v1.2.3"'
    );
    expect(compose).toContain(
      'source: "/secure/agent-knowledge/profile.json"'
    );
    expect(compose).toContain(
      'target: "/secure/agent-knowledge/profile.json"'
    );
    expect(compose).toContain(
      'source: "/srv/agent-knowledge-data"'
    );
    expect(compose).toContain('target: "/srv/agent-knowledge-data"');
    expect(compose).toContain('source: "/projects/business"');
    expect(compose).toContain('target: "/projects/business"');
    expect(compose).toContain("AGENT_KNOWLEDGE_INTERVAL_MINUTES: \"60\"");
    expect(compose).toContain(
      "/secure/agent-knowledge/automation.env"
    );
    expect(compose).not.toContain("Bearer ");
    expect(compose).not.toContain("node:22");
    const parsedCompose = load(compose) as {
      services: {
        "knowledge-automation": {
          image: string;
          volumes: Array<{
            type: string;
            source: string;
            target: string;
            read_only?: boolean;
          }>;
        };
      };
    };
    expect(parsedCompose.services["knowledge-automation"].image).toBe(
      "registry.example.com/agent-knowledge:v1.2.3"
    );
    expect(parsedCompose.services["knowledge-automation"].volumes).toContainEqual({
      type: "bind",
      source: "/projects/business",
      target: "/projects/business"
    });
    expect(parsedCompose.services["knowledge-automation"].volumes).toContainEqual({
      type: "bind",
      source: "/secure/eval",
      target: "/secure/eval",
      read_only: true
    });
    const entrypoint = await readFile(
      result.files.find((file) => file.endsWith("entrypoint.sh"))!,
      "utf8"
    );
    expect(entrypoint).toContain(
      "'/opt/agent-runners/run-knowledge-agent' &"
    );
    expect(entrypoint).toContain("trap stop TERM INT");
  });

  it("rejects Docker without a pinned runtime image before writing files", async () => {
    const output = path.join(
      await mkdtemp(path.join(tmpdir(), "ak-docker-invalid-")),
      "generated"
    );
    tempDirs.push(path.dirname(output));

    await expect(
      renderAutomationService({
        manager: "docker",
        label: "business-refresh",
        profilePath: "/secure/agent-knowledge/profile.json",
        runnerPath: "/opt/agent-runners/run-knowledge-agent",
        intervalMinutes: 60,
        outputDir: output,
        workspacePath: "/srv/agent-knowledge-data",
        containerImage: "registry.example.com/agent-knowledge:latest"
      })
    ).rejects.toThrow(/pinned container image/);
    await expect(stat(output)).rejects.toThrow();
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
