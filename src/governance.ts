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

export function assertNoSecretLikeContent(input: CandidateMemoryInput): void {
  const haystack = JSON.stringify(input);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(haystack))) {
    throw new Error("Candidate contains secret-like content");
  }
}

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
