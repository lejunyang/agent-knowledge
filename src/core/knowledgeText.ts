/**
 * V2 metadata 的文本投影集中放在这里。
 *
 * weighted metadata 是事实源的一部分，但 FTS、embedding、catalog 和 graph 只需要稳定
 * 字符串视图。统一投影可避免各模块遗漏 retrieval=false 或把对象隐式转成 `[object Object]`。
 */
import type {
  KnowledgeFrontmatter,
  WeightedAlias,
  WeightedScenario,
  WeightedTag
} from "./knowledgeV2.js";

/** 返回 alias 的人类可读值，保留全部条目供 catalog 和人工审阅。 */
export function aliasValues(
  input: Pick<KnowledgeFrontmatter, "aliases"> | WeightedAlias[]
): string[] {
  const aliases = Array.isArray(input) ? input : input.aliases;
  return aliases.map((alias) => alias.value);
}

/** 返回 scenario ID；primary/secondary 和 weight 仍保留在 frontmatter 中。 */
export function scenarioIds(
  input: Pick<KnowledgeFrontmatter, "scenarios"> | WeightedScenario[]
): string[] {
  const scenarios = Array.isArray(input) ? input : input.scenarios;
  return scenarios.map((scenario) => scenario.id);
}

/** 返回所有 tag 值，供 catalog 和图谱展示。 */
export function tagValues(
  input: Pick<KnowledgeFrontmatter, "tags"> | WeightedTag[]
): string[] {
  const tags = Array.isArray(input) ? input : input.tags;
  return tags.map((tag) => tag.value);
}

/** 返回允许参与检索且达到最低权重的 tag。 */
export function searchableTagValues(
  input: Pick<KnowledgeFrontmatter, "tags"> | WeightedTag[],
  minimumWeight = 0.35
): string[] {
  const tags = Array.isArray(input) ? input : input.tags;
  return tags
    .filter((tag) => tag.retrieval && tag.weight >= minimumWeight)
    .map((tag) => tag.value);
}

/** 返回达到最低权重的 alias，避免弱别名污染 FTS 和 embedding。 */
export function searchableAliasValues(
  input: Pick<KnowledgeFrontmatter, "aliases"> | WeightedAlias[],
  minimumWeight = 0.35
): string[] {
  const aliases = Array.isArray(input) ? input : input.aliases;
  return aliases
    .filter((alias) => alias.weight >= minimumWeight)
    .map((alias) => alias.value);
}

/** 返回达到最低权重的 scenario ID。 */
export function searchableScenarioIds(
  input: Pick<KnowledgeFrontmatter, "scenarios"> | WeightedScenario[],
  minimumWeight = 0.35
): string[] {
  const scenarios = Array.isArray(input) ? input : input.scenarios;
  return scenarios
    .filter((scenario) => scenario.weight >= minimumWeight)
    .map((scenario) => scenario.id);
}
