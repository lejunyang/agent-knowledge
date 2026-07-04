import { extractSummary } from "./markdown.js";
import type { ContextPacket, ContextPacketItem, MemoryQueryRequest, RankedMemory } from "./types.js";

type BuildContextPacketInput = {
  request: MemoryQueryRequest;
  ranked: RankedMemory[];
};

function toItem(memory: RankedMemory): ContextPacketItem {
  const document = memory.document;

  return {
    id: document.frontmatter.id,
    title: document.frontmatter.title,
    content: extractSummary(document.body, 360),
    confidence: document.frontmatter.confidence,
    source: document.frontmatter.source
  };
}

export function buildContextPacket(input: BuildContextPacketInput): ContextPacket {
  const packet: ContextPacket = {
    context_version: "1.0",
    scene: {
      task_type: input.request.agentRole,
      domains: input.request.domains,
      scenarios: input.request.scenarios
    },
    always_apply: [],
    relevant_facts: [],
    procedures: [],
    examples: [],
    warnings: [],
    sources: []
  };

  for (const ranked of input.ranked) {
    const type = ranked.document.frontmatter.type;
    const item = toItem(ranked);

    if (type === "profile") {
      packet.always_apply.push(item);
    }
    if (type === "semantic") {
      packet.relevant_facts.push(item);
    }
    if (type === "procedural") {
      packet.procedures.push(item);
    }
    if (type === "episodic") {
      packet.examples.push(item);
    }

    for (const conflict of ranked.document.frontmatter.conflicts_with) {
      packet.warnings.push({
        type: "conflict",
        message: `${ranked.document.frontmatter.title} 与 ${conflict} 存在冲突，需要人工确认。`,
        source: ranked.document.frontmatter.id
      });
    }

    packet.sources.push(...ranked.document.frontmatter.source);
  }

  packet.always_apply = packet.always_apply.slice(0, 5);
  packet.relevant_facts = packet.relevant_facts.slice(0, 8);
  packet.procedures = packet.procedures.slice(0, 5);
  packet.examples = packet.examples.slice(0, 2);
  packet.sources = [...new Set(packet.sources)].slice(0, 10);

  return packet;
}
