/**
 * Hook relevance separates retrieval from model-context injection.
 *
 * Query can return diagnostics and low-confidence candidates for humans, while automatic hooks must
 * remain conservative: no result and weak result both produce no stdout, which means no model context.
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

export function isCatalogIntent(prompt: string): boolean {
  return CATALOG_INTENT_PATTERNS.some((pattern) => pattern.test(prompt));
}

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
