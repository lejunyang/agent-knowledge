import { describe, expect, it } from "vitest";
import {
  formatIntegrationInstallResult,
  promptForIntegrationInstall,
  type IntegrationPrompter
} from "../src/cli/integration.js";
import type { InstallIntegrationResult } from "../src/integration/manager.js";
import { DEFAULT_USER_CONFIG } from "../src/core/config.js";

class AnswerPrompter implements IntegrationPrompter {
  private index = 0;

  constructor(private readonly answers: string[]) {}

  async ask(): Promise<string> {
    const answer = this.answers[this.index];
    this.index += 1;
    if (answer === undefined) {
      throw new Error("Missing answer");
    }
    return answer;
  }
}

describe("integration CLI helpers", () => {
  it("prompts for missing product, scope, components, target, and write mode", async () => {
    const selected = await promptForIntegrationInstall({
      defaults: DEFAULT_USER_CONFIG.integration,
      prompter: new AnswerPrompter([
        "trae-cn",
        "project",
        "hooks,agents",
        "/tmp/project/.trae-cn",
        "overwrite"
      ])
    });

    expect(selected).toEqual({
      product: "trae-cn",
      scope: "project",
      components: ["hooks", "agents"],
      targetDir: "/tmp/project/.trae-cn",
      mode: "overwrite"
    });
  });

  it("formats install results for humans and keeps JSON for debug output", () => {
    const result: InstallIntegrationResult = {
      product: "trae",
      scope: "user",
      roots: {
        hooks: "/tmp/.trae/cli",
        resources: "/tmp/.trae"
      },
      manifestPath: "/tmp/.trae/.agent-knowledge-integration.json",
      managed: [
        {
          path: "/tmp/.trae/hooks.json",
          kind: "hooks",
          hash: "hash",
          status: "installed"
        }
      ],
      conflicts: []
    };

    const human = formatIntegrationInstallResult(result);

    expect(human).toContain("Installed Agent Knowledge for TRAE");
    expect(human).toContain("/tmp/.trae/hooks.json");
    expect(human).not.toContain('"manifestPath"');
  });
});
