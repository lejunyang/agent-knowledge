/**
 * contextPacket 模块把检索结果转换成主 agent 可注入的稳定协议。
 *
 * 这样做的原因是：主 agent 不应该直接消费原始 Markdown 或排序结果。
 * 它需要的是按用途分区的上下文：稳定规则、相关事实、流程、案例、风险和来源。
 */
import type { ContextPacket, ContextPacketItem, MemoryQueryRequest, RankedMemory } from "../core/types.js";

type BuildContextPacketInput = {
  request: MemoryQueryRequest;
  ranked: RankedMemory[];
};

const MIN_DIRECT_SCORE = 0.35;
const MIN_RELATIVE_DIRECT_SCORE = 0.65;

/**
 * 过滤只因偶然词项进入候选池的直接长尾。
 *
 * 明确关系扩展代表人类声明的依赖，不受相对门槛影响；普通 direct candidate 必须同时达到绝对
 * 分数和首条分数比例，避免 token 预算宽裕时把低相关知识塞满 packet。
 */
function relevantForPacket(memory: RankedMemory, topScore: number): boolean {
  if (memory.relationScore > 0) {
    return memory.finalScore >= MIN_DIRECT_SCORE;
  }
  return (
    memory.finalScore >= MIN_DIRECT_SCORE &&
    memory.finalScore >= topScore * MIN_RELATIVE_DIRECT_SCORE
  );
}

/** 把排序结果裁剪为可注入 context packet 的稳定字段集合。 */
function toItem(memory: RankedMemory): ContextPacketItem {
  const document = memory.document;

  return {
    id: document.frontmatter.id,
    title: document.frontmatter.title,
    content: document.frontmatter.synopsis,
    confidence: document.frontmatter.confidence,
    projectKeys: document.frontmatter.project_keys,
    source: document.frontmatter.source
  };
}

/** 深复制 packet 分区数组，供预算试装时回滚而不修改已接受结果。 */
function clonePacket(packet: ContextPacket): ContextPacket {
  return {
    ...packet,
    scene: {
      ...packet.scene,
      domains: [...packet.scene.domains],
      scenarios: [...packet.scene.scenarios],
      project_keys: [...packet.scene.project_keys]
    },
    route: [...packet.route],
    claims: [...packet.claims],
    procedures: [...packet.procedures],
    principles: [...packet.principles],
    episodes: [...packet.episodes],
    evidence_handles: [...packet.evidence_handles],
    warnings: [...packet.warnings],
    sources: [...packet.sources],
    expansion: {
      available: packet.expansion.available,
      commands: [...packet.expansion.commands]
    }
  };
}

/** 试装一个条目，只有估算 token 未超预算时才提交到目标分区。 */
function addWithinBudget(
  packet: ContextPacket,
  section: "route" | "claims" | "procedures" | "principles" | "episodes",
  item: ContextPacketItem,
  maxTokens: number,
  evidenceHandles: ContextPacket["evidence_handles"],
  commands: string[]
): boolean {
  const candidate = clonePacket(packet);
  candidate[section].push(item);
  candidate.sources = [...new Set([...candidate.sources, ...item.source])].slice(0, 10);
  candidate.evidence_handles.push(...evidenceHandles);
  candidate.expansion.commands = [
    ...new Set([...candidate.expansion.commands, ...commands])
  ];
  candidate.expansion.available = candidate.expansion.commands.length > 0;
  if (estimateContextPacketTokens(candidate) > maxTokens) {
    return false;
  }
  packet[section].push(item);
  packet.sources = candidate.sources;
  packet.evidence_handles = candidate.evidence_handles;
  packet.expansion = candidate.expansion;
  return true;
}

/** 从知识 claims 构建可显式展开的 evidence handles，不包含原始正文。 */
function evidenceHandlesFor(memory: RankedMemory): ContextPacket["evidence_handles"] {
  return memory.document.frontmatter.claims.flatMap((claim) =>
    claim.evidence.map((anchor) => ({
      knowledgeId: memory.document.frontmatter.id,
      claimId: claim.id,
      sourceId: anchor.source_id,
      sectionId: anchor.section_id,
      quoteHash: anchor.quote_hash
    }))
  );
}

/** 为已装入 packet 的知识生成显式展开命令。 */
function expansionCommandsFor(memory: RankedMemory): string[] {
  const commands = [
    `agent-knowledge knowledge show ${memory.document.frontmatter.id} --layer knowledge`
  ];
  for (const claim of memory.document.frontmatter.claims) {
    if (claim.evidence.length > 0) {
      commands.push(`agent-knowledge knowledge evidence ${claim.id}`);
    }
  }
  return commands;
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

/** 使用与装包逻辑相同的保守估算计算完整 context packet token 数。 */
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
    context_version: "2.0",
    scene: {
      task_type: input.request.agentRole,
      domains: input.request.domains,
      scenarios: input.request.scenarios,
      project_keys: input.request.projectKeys
    },
    route: [],
    claims: [],
    procedures: [],
    principles: [],
    episodes: [],
    evidence_handles: [],
    warnings: [],
    sources: [],
    expansion: {
      available: false,
      commands: []
    }
  };

  const topScore = input.ranked[0]?.finalScore ?? 0;
  for (const ranked of input.ranked.filter((memory) =>
    relevantForPacket(memory, topScore)
  )) {
    const type = ranked.document.frontmatter.kind;
    const item = toItem(ranked);
    const evidenceHandles = evidenceHandlesFor(ranked);
    const commands = expansionCommandsFor(ranked);

    if (type === "profile") {
      addWithinBudget(
        packet,
        "route",
        item,
        input.request.maxTokens,
        evidenceHandles,
        commands
      );
    }
    if (type === "semantic") {
      addWithinBudget(
        packet,
        "claims",
        item,
        input.request.maxTokens,
        evidenceHandles,
        commands
      );
    }
    if (type === "procedural") {
      addWithinBudget(
        packet,
        "procedures",
        item,
        input.request.maxTokens,
        evidenceHandles,
        commands
      );
    }
    if (type === "principle") {
      addWithinBudget(
        packet,
        "principles",
        item,
        input.request.maxTokens,
        evidenceHandles,
        commands
      );
    }
    if (type === "episodic") {
      addWithinBudget(
        packet,
        "episodes",
        item,
        input.request.maxTokens,
        evidenceHandles,
        commands
      );
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
    packet.scene.project_keys = [];
  }
  if (estimateContextPacketTokens(packet) > input.request.maxTokens) {
    throw new Error(`maxTokens=${input.request.maxTokens} is too small for the context packet envelope`);
  }

  return packet;
}
