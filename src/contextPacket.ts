/**
 * contextPacket 模块把检索结果转换成主 agent 可注入的稳定协议。
 *
 * 这样做的原因是：主 agent 不应该直接消费原始 Markdown 或排序结果。
 * 它需要的是按用途分区的上下文：稳定规则、相关事实、流程、案例、风险和来源。
 */
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

function clonePacket(packet: ContextPacket): ContextPacket {
  return {
    ...packet,
    scene: { ...packet.scene, domains: [...packet.scene.domains], scenarios: [...packet.scene.scenarios] },
    always_apply: [...packet.always_apply],
    relevant_facts: [...packet.relevant_facts],
    procedures: [...packet.procedures],
    examples: [...packet.examples],
    warnings: [...packet.warnings],
    sources: [...packet.sources]
  };
}

function addWithinBudget(
  packet: ContextPacket,
  section: "always_apply" | "relevant_facts" | "procedures" | "examples",
  item: ContextPacketItem,
  maxTokens: number
): boolean {
  const candidate = clonePacket(packet);
  candidate[section].push(item);
  candidate.sources = [...new Set([...candidate.sources, ...item.source])].slice(0, 10);
  if (estimateContextPacketTokens(candidate) > maxTokens) {
    return false;
  }
  packet[section].push(item);
  packet.sources = candidate.sources;
  return true;
}

/**
 * 对中英文混合上下文做保守 token 估算。
 *
 * 中文字符按一个 token、其他文本按约四字符一个 token 估算。该函数不替代模型 tokenizer，
 * 但适合在无模型热路径中执行预算和评测，且宁可少装包也不突破调用方预算。
 */
export function estimateTextTokens(text: string): number {
  const cjkCount = [...text].filter((character) => /\p{Script=Han}/u.test(character)).length;
  const otherCount = Math.max(0, text.length - cjkCount);
  return cjkCount + Math.ceil(otherCount / 4);
}

export function estimateContextPacketTokens(packet: ContextPacket): number {
  return estimateTextTokens(JSON.stringify(packet));
}

/**
 * 构建 context packet。
 *
 * MVP 用知识类型决定注入区域，并做简单数量截断。后续可以在这里加入 token 估算、
 * 更细粒度预算和来源展开策略，而不影响 query 模块。
 */
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
      addWithinBudget(packet, "always_apply", item, input.request.maxTokens);
    }
    if (type === "semantic") {
      addWithinBudget(packet, "relevant_facts", item, input.request.maxTokens);
    }
    if (type === "procedural") {
      addWithinBudget(packet, "procedures", item, input.request.maxTokens);
    }
    if (type === "episodic") {
      addWithinBudget(packet, "examples", item, input.request.maxTokens);
    }

    for (const conflict of ranked.document.frontmatter.conflicts_with) {
      const warning = {
        type: "conflict",
        message: `${ranked.document.frontmatter.title} 与 ${conflict} 存在冲突，需要人工确认。`,
        source: ranked.document.frontmatter.id
      };
      const candidate = clonePacket(packet);
      candidate.warnings.push(warning);
      if (estimateContextPacketTokens(candidate) <= input.request.maxTokens) {
        packet.warnings.push(warning);
      }
    }
  }

  if (estimateContextPacketTokens(packet) > input.request.maxTokens) {
    packet.scene.domains = [];
    packet.scene.scenarios = [];
  }
  if (estimateContextPacketTokens(packet) > input.request.maxTokens) {
    throw new Error(`maxTokens=${input.request.maxTokens} is too small for the context packet envelope`);
  }

  return packet;
}
