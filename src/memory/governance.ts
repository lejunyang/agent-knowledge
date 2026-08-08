/**
 * governance 模块负责候选知识进入 `_inbox` 前的最低限度治理。
 *
 * 它不是完整审核系统，但必须提供两条安全底线：
 * - 拒绝 secret-like 内容。
 * - 根据来源权威性和知识类型决定默认状态。
 */
import type {
  ActorType,
  CaptureMode,
  KnowledgeClaim,
  KnowledgeKind,
  KnowledgeLayer,
  MemoryStatus,
  RelatedKnowledge,
  SourceAuthority,
  WeightedAlias,
  WeightedScenario,
  WeightedTag
} from "../core/types.js";
import type { EpisodeProvenance } from "../core/types.js";

type CandidateWeightedAlias = Omit<
  WeightedAlias,
  "evidence_refs" | "positive_hits" | "negative_hits"
> & {
  evidence_refs?: string[];
  positive_hits?: number;
  negative_hits?: number;
};

export type CandidateMemoryInput = {
  id?: string;
  title: string;
  kind?: KnowledgeKind;
  memory_type?: KnowledgeKind;
  layer?: KnowledgeLayer;
  synopsis?: string;
  explanation?: string;
  aliases?: CandidateWeightedAlias[] | string[];
  domain: string;
  related_domains: string[];
  scenarios?: WeightedScenario[];
  scenario?: string[];
  tags: WeightedTag[] | string[];
  claims?: KnowledgeClaim[];
  confidence: number;
  source_authority: SourceAuthority;
  summary?: string;
  content?: string;
  evidence: string[];
  related_knowledge?: RelatedKnowledge[];
  capture_mode?: CaptureMode;
  actor_type?: ActorType;
  corroboration_count?: number;
  project_keys?: string[];
  project_ids?: string[];
  supersedes?: string[];
  conflicts_with?: string[];
  visibility?: "private" | "project" | "team";
  sensitivity?: "public" | "internal" | "confidential" | "secret";
  episodes?: EpisodeProvenance[];
};

export type NormalizedCandidateMemoryInput = Omit<
  CandidateMemoryInput,
  | "kind"
  | "memory_type"
  | "layer"
  | "synopsis"
  | "explanation"
  | "aliases"
  | "scenarios"
  | "scenario"
  | "tags"
  | "claims"
  | "project_keys"
  | "project_ids"
> & {
  kind: KnowledgeKind;
  layer: KnowledgeLayer;
  synopsis: string;
  explanation: string;
  aliases: WeightedAlias[];
  scenarios: WeightedScenario[];
  tags: WeightedTag[];
  claims: KnowledgeClaim[];
  project_keys: string[];
};

export type GovernanceDecision = {
  status: MemoryStatus;
  review_required: boolean;
  review_reason: string;
};

const SECRET_PATTERNS = [
  /api[_-]?key\s*=\s*["']?[a-z0-9_-]{20,}/i,
  /token\s*=\s*["']?[a-z0-9_.-]{20,}/i,
  /sk-[a-z0-9]{20,}/i,
  /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/
];

/**
 * 防止 hooks 或 writer subagent 把凭证写进 Markdown。
 *
 * 这是启发式扫描，不替代专门 secret scanner；但它能挡住常见 token/API key/私钥格式。
 */
export function assertNoSecretLikeContent(input: CandidateMemoryInput): void {
  const haystack = JSON.stringify(input);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(haystack))) {
    throw new Error("Candidate contains secret-like content");
  }
}

/** 把历史命令输入的字符串 metadata 归一化为 V2 结构，不兼容读取旧 Markdown。 */
function normalizeAliases(input: CandidateMemoryInput): WeightedAlias[] {
  return (input.aliases ?? []).map((alias) =>
    typeof alias === "string"
      ? {
          value: alias,
          kind: "user_phrase",
          weight: 0.5,
          source:
            input.source_authority === "user_confirmed"
              ? "user_confirmed"
              : input.source_authority === "documented"
                ? "documented"
                : "query_observed",
          evidence_refs: [],
          positive_hits: 0,
          negative_hits: 0
        }
      : {
          ...alias,
          evidence_refs: alias.evidence_refs ?? [],
          positive_hits: alias.positive_hits ?? 0,
          negative_hits: alias.negative_hits ?? 0
        }
  );
}

/** 把旧 scenario 字符串按第一个 primary、其余 secondary 转成显式权重。 */
function normalizeScenarios(input: CandidateMemoryInput): WeightedScenario[] {
  if (input.scenarios) {
    return input.scenarios;
  }
  return (input.scenario ?? []).map((id, index) => ({
    id,
    role: index === 0 ? "primary" : "secondary",
    weight: index === 0 ? 0.8 : 0.5
  }));
}

/** 把旧 tag 字符串转成中性检索 tag；新调用方应显式传权重和 retrieval。 */
function normalizeTags(input: CandidateMemoryInput): WeightedTag[] {
  return input.tags.map((tag) =>
    typeof tag === "string"
      ? {
          value: tag,
          weight: 0.5,
          source:
            input.source_authority === "documented" ? "documented" : "observed",
          retrieval: tag !== "internal-doc"
        }
      : tag
  );
}

/** 把旧不可读 project ID 限制到显式 local namespace，避免写入裸 hash。 */
function normalizeProjectKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.startsWith("local/") ||
    /^[a-z0-9.-]+\/[a-z0-9._/-]+$/.test(normalized)
  ) {
    return normalized;
  }
  return `local/${normalized.replace(/[^a-z0-9._/-]+/g, "-")}`;
}

/**
 * 在 CLI/Skill 输入边界生成完整 V2 candidate。
 *
 * 该函数允许现有 JSON 命令字段继续工作，目的是给接入方平滑升级；输出始终是 V2，
 * 不提供任何 V1 Markdown parser 或 migration。
 */
export function normalizeCandidateInput(
  input: CandidateMemoryInput
): NormalizedCandidateMemoryInput {
  const kind = input.kind ?? input.memory_type;
  if (!kind) {
    throw new Error("Candidate requires kind");
  }
  const synopsis = input.synopsis ?? input.summary;
  if (!synopsis) {
    throw new Error("Candidate requires synopsis");
  }
  const scenarios = normalizeScenarios(input);
  if (scenarios.length === 0) {
    throw new Error("Candidate requires at least one scenario");
  }
  const explanation =
    input.explanation ??
    input.content ??
    `# ${input.title}

## 结论

${synopsis}
`;

  return {
    ...input,
    kind,
    layer: input.layer ?? (kind === "source" ? "evidence" : "knowledge"),
    synopsis,
    explanation,
    aliases: normalizeAliases(input),
    scenarios,
    tags: normalizeTags(input),
    claims: input.claims ?? [],
    project_keys: [...(input.project_keys ?? input.project_ids ?? [])].map(
      normalizeProjectKey
    )
  };
}

/**
 * 决定候选知识的默认治理状态。
 *
 * 用户显式确认和已验证流程可以更积极；模型推断默认 proposed，等待人类审阅。
 */
export function decideCandidateStatus(input: CandidateMemoryInput): GovernanceDecision {
  assertNoSecretLikeContent(input);
  const normalized = normalizeCandidateInput(input);

  if (input.capture_mode === "automated_session" || input.actor_type === "customer") {
    return {
      status: "proposed",
      review_required: true,
      review_reason:
        input.actor_type === "customer" ? "untrusted_customer_observation" : "automated_session_requires_review"
    };
  }

  if (input.source_authority === "user_confirmed") {
    return {
      status: "active",
      review_required: false,
      review_reason: "user_confirmed"
    };
  }

  if (
    input.source_authority === "documented" &&
    (input.actor_type ?? "owner") === "owner" &&
    (input.capture_mode ?? "direct_material") === "direct_material" &&
    input.confidence >= 0.8
  ) {
    return {
      status: "active",
      review_required: false,
      review_reason: "trusted_documented_direct_material"
    };
  }

  if (
    input.source_authority === "verified_task" &&
    normalized.kind === "procedural" &&
    input.confidence >= 0.75
  ) {
    return {
      status: "active",
      review_required: false,
      review_reason: "verified_task_procedural_memory"
    };
  }

  return {
    status: "proposed",
    review_required: true,
    review_reason: "model_or_document_inferred_memory"
  };
}
