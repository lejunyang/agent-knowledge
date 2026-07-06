import type { KnowledgeCatalog } from "./catalog.js";

export function coarseCatalogForHook(catalog: KnowledgeCatalog): Record<string, unknown> {
  return {
    total: catalog.total,
    byStatus: catalog.byStatus,
    byType: catalog.byType,
    domains: catalog.registry.domains,
    scenarios: catalog.registry.scenarios
  };
}

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
