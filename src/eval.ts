import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { queryMemories } from "./query.js";

export type EvalCase = {
  task: string;
  domains: string[];
  scenarios: string[];
  expected_memories: string[];
  forbidden_memories: string[];
};

export type EvalResult = {
  passed: boolean;
  matchedIds: string[];
  missingExpected: string[];
  presentForbidden: string[];
};

export async function loadEvalCase(filePath: string): Promise<EvalCase> {
  return yaml.load(await readFile(filePath, "utf8")) as EvalCase;
}

export async function runEvalCase(rootDir: string, evalCase: EvalCase): Promise<EvalResult> {
  const ranked = queryMemories(rootDir, {
    task: evalCase.task,
    agentRole: "main",
    domains: evalCase.domains,
    scenarios: evalCase.scenarios,
    paths: [],
    maxTokens: 4500,
    includeTypes: ["profile", "semantic", "episodic", "procedural"]
  });
  const matchedIds = ranked.map((item) => item.document.frontmatter.id);
  const missingExpected = evalCase.expected_memories.filter((id) => !matchedIds.includes(id));
  const presentForbidden = evalCase.forbidden_memories.filter((id) => matchedIds.includes(id));

  return {
    passed: missingExpected.length === 0 && presentForbidden.length === 0,
    matchedIds,
    missingExpected,
    presentForbidden
  };
}
