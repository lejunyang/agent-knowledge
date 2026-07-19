/**
 * Hook relevance 把检索结果和模型上下文注入分离。
 *
 * Query 可以向人类返回诊断和低置信候选；自动 Hook 必须更保守：无结果和弱结果都不产生
 * stdout，也就不会污染模型上下文。
 */
import type { ContextPacket, RankedMemory } from "../core/types.js";
import type { KnowledgeCatalog } from "../storage/catalog.js";
import { cjkNgrams } from "../retrieval/cjk.js";
import { estimateContextPacketTokens } from "../retrieval/contextPacket.js";

export type HookDecision = "none" | "below_threshold" | "context" | "catalog_intent";

export type RelatedCatalog = {
  domains: string[];
  scenarios: string[];
  items: Array<{
    id: string;
    title: string;
    domain: string;
    scenarios: string[];
  }>;
};

const CATALOG_INTENT_PATTERNS = [
  /(?:有哪些|查看|浏览|列出).{0,8}(?:知识|记忆|规则|sop|目录)/i,
  /(?:知识|记忆).{0,8}(?:菜单|目录|清单)/i,
  /\b(?:show|list|browse|view)\b.{0,20}\b(?:knowledge|memory|memories|rules|sop|catalog)\b/i,
  /\b(?:knowledge|memory)\s+catalog\b/i
];

const CATALOG_STOP_TERMS = new Set([
  "有哪",
  "哪些",
  "查看",
  "浏览",
  "列出",
  "知识",
  "记忆",
  "规则",
  "目录",
  "菜单",
  "清单",
  "show",
  "list",
  "browse",
  "view",
  "knowledge",
  "memory",
  "memories",
  "rules",
  "catalog",
  "sop"
]);

/** 提取 catalog 浏览关键词，并移除“查看/知识/catalog”等意图词，减少全库泛匹配。 */
function promptTerms(input: string): string[] {
  const lexical = input
    .toLowerCase()
    .replace(/\p{Script=Han}+/gu, " ")
    .split(/[^\p{L}\p{N}_/-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set([...lexical, ...cjkNgrams(input)])].filter(
    (term) => !CATALOG_STOP_TERMS.has(term)
  );
}

/** 检测用户是否明确要求浏览知识；普通任务不得收到知识菜单。 */
export function isCatalogIntent(prompt: string): boolean {
  return CATALOG_INTENT_PATTERNS.some((pattern) => pattern.test(prompt));
}

/**
 * 只返回与浏览 prompt 共享明确词项的 catalog 条目。
 *
 * 即使用户明确要求查看目录，也不能注入完整 aliases registry；全量词表会影响无关推理并浪费上下文。
 */
export function filterCatalogForPrompt(
  catalog: KnowledgeCatalog,
  prompt: string,
  maxItems: number
): RelatedCatalog {
  const terms = promptTerms(prompt);
  if (terms.length === 0 || maxItems <= 0) {
    return { domains: [], scenarios: [], items: [] };
  }

  const ranked = catalog.items
    .map((item) => {
      const searchable = [
        item.title,
        ...item.aliases,
        item.domain,
        ...item.scenarios,
        ...item.tags,
        item.summary
      ]
        .join("\n")
        .toLowerCase();
      const score = terms.filter((term) => searchable.includes(term)).length;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.item.confidence - left.item.confidence ||
        left.item.id.localeCompare(right.item.id)
    )
    .slice(0, maxItems);

  return {
    domains: [...new Set(ranked.map(({ item }) => item.domain))],
    scenarios: [...new Set(ranked.flatMap(({ item }) => item.scenarios))],
    items: ranked.map(({ item }) => ({
      id: item.id,
      title: item.title,
      domain: item.domain,
      scenarios: item.scenarios
    }))
  };
}

/**
 * 在检索后执行保守的 Hook 注入门控。
 *
 * 空结果和低于阈值的结果刻意返回空上下文，而不是解释性消息，把模型上下文留给用户真实任务。
 */
export function decideHookInjection(input: {
  prompt: string;
  ranked: RankedMemory[];
  packet: ContextPacket;
  minScore: number;
  catalog?: KnowledgeCatalog;
  catalogMaxItems?: number;
}): {
  decision: HookDecision;
  additionalContext: string;
  score?: number;
  packetTokens?: number;
  resultIds: string[];
} {
  if (isCatalogIntent(input.prompt)) {
    const related = input.catalog
      ? filterCatalogForPrompt(input.catalog, input.prompt, input.catalogMaxItems ?? 5)
      : { domains: [], scenarios: [], items: [] };
    if (related.items.length === 0) {
      return { decision: "none", additionalContext: "", resultIds: [] };
    }
    return {
      decision: "catalog_intent",
      additionalContext: JSON.stringify({ knowledge_catalog: related }),
      resultIds: related.items.map((item) => item.id)
    };
  }

  if (input.ranked.length === 0) {
    return { decision: "none", additionalContext: "", resultIds: [] };
  }
  const score = input.ranked[0]?.finalScore ?? 0;
  if (score < input.minScore) {
    return {
      decision: "below_threshold",
      additionalContext: "",
      score,
      resultIds: input.ranked.map((item) => item.document.frontmatter.id)
    };
  }

  const packetTokens = estimateContextPacketTokens(input.packet);
  return {
    decision: "context",
    additionalContext: JSON.stringify({ context_packet: input.packet }),
    score,
    packetTokens,
    resultIds: input.ranked.map((item) => item.document.frontmatter.id)
  };
}
