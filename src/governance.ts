/**
 * governance 模块负责候选知识进入 `_inbox` 前的最低限度治理。
 *
 * 它不是完整审核系统，但必须提供两条安全底线：
 * - 拒绝 secret-like 内容。
 * - 根据来源权威性和知识类型决定默认状态。
 */
import type { MemoryStatus, MemoryType, SourceAuthority } from "./types.js";

export type CandidateMemoryInput = {
  title: string;
  memory_type: MemoryType;
  domain: string;
  related_domains: string[];
  scenario: string[];
  tags: string[];
  confidence: number;
  source_authority: SourceAuthority;
  summary: string;
  evidence: string[];
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

/**
 * 决定候选知识的默认治理状态。
 *
 * 用户显式确认和已验证流程可以更积极；模型推断默认 proposed，等待人类审阅。
 */
export function decideCandidateStatus(input: CandidateMemoryInput): GovernanceDecision {
  assertNoSecretLikeContent(input);

  if (input.source_authority === "user_confirmed") {
    return {
      status: "active",
      review_required: false,
      review_reason: "user_confirmed"
    };
  }

  if (input.source_authority === "verified_task" && input.memory_type === "procedural" && input.confidence >= 0.75) {
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
