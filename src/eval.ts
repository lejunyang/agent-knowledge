/**
 * eval 模块提供检索质量回归测试。
 *
 * 每个 eval case 定义“应该召回”和“不应该召回”的知识 ID。
 * 当 query 策略、排序权重或 schema 变化时，用它判断是否造成召回退化。
 */
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

/**
 * 从 YAML 读取评估用例。YAML 方便人类维护，比 JSON 更适合手写测试集。
 */
export async function loadEvalCase(filePath: string): Promise<EvalCase> {
  return yaml.load(await readFile(filePath, "utf8")) as EvalCase;
}

/**
 * 执行单个评估用例。
 *
 * 这里复用真实 query pipeline，而不是 mock 检索结果，确保评估覆盖实际索引和过滤逻辑。
 */
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
