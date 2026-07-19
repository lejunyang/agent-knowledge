import type { KnowledgeCatalog } from "../storage/catalog.js";

/** 返回宿主要求的上下文 envelope；空内容返回 null，保证静默 Hook 不产生 stdout。 */
export function hookContextJson(
  hookEventName: "SessionStart" | "UserPromptSubmit",
  additionalContext: string
): Record<string, unknown> | null {
  if (additionalContext.length === 0) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext
    }
  };
}

/** 生成只含聚合统计的 catalog，刻意省略词表和具体知识条目。 */
export function coarseCatalogForHook(catalog: KnowledgeCatalog): Record<string, unknown> {
  return {
    total: catalog.total,
    byStatus: catalog.byStatus,
    byType: catalog.byType,
    domains: catalog.registry.domains,
    scenarios: catalog.registry.scenarios
  };
}

/** 生成有数量上限的详细 catalog，只供显式浏览和诊断使用。 */
export function compactCatalogForHook(catalog: KnowledgeCatalog): Record<string, unknown> {
  return {
    ...coarseCatalogForHook(catalog),
    aliases: catalog.registry.aliases,
    items: catalog.items.slice(0, 20).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      status: item.status,
      aliases: item.aliases,
      domain: item.domain,
      scenarios: item.scenarios
    }))
  };
}
