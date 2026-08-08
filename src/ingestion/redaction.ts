/**
 * Evidence redaction 在完整内容进入 Vault 前执行最低安全清洗。
 *
 * secrets 永远遮蔽；PII 是否遮蔽由 Connector 场景决定。该模块不尝试理解业务真伪，
 * 只处理高风险原值并返回计数，不在日志中保存被替换内容。
 */
import type { EvidenceRedactionPolicy } from "./types.js";

/**
 * 脱敏规则版本参与增量 skip 判断。
 *
 * 任何会改变输出或覆盖范围的 RULES 修改都必须递增该值，使上游 revision 未变的 source
 * 也重新抓取并生成新 Vault object/manifest，不能继续沿用旧安全结果。
 */
export const EVIDENCE_REDACTION_PROFILE = "deterministic-redaction-v1";

export type RedactionResult = {
  text: string;
  counts: Record<string, number>;
};

type RedactionRule = {
  kind: string;
  pattern: RegExp;
  replacement: string;
  pii?: boolean;
};

const RULES: RedactionRule[] = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    kind: "authorization_header",
    pattern:
      /(\bAuthorization\s*:\s*)(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi,
    replacement: "$1[REDACTED_SECRET]"
  },
  {
    kind: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    replacement: "Bearer [REDACTED_SECRET]"
  },
  {
    kind: "secret_assignment",
    pattern:
      /(["']?(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|app[_-]?token|password|passwd|pwd|cookie|session[_-]?token)["']?\s*[:=]\s*["']?)[^&"'\s<},]{4,}/gi,
    replacement: "$1[REDACTED_SECRET]"
  },
  {
    kind: "openai_style_key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    kind: "phone",
    pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,
    replacement: "[REDACTED_PHONE]",
    pii: true
  },
  {
    kind: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
    pii: true
  },
  {
    kind: "id_number",
    pattern: /\b\d{17}[\dXx]\b/g,
    replacement: "[REDACTED_ID_NUMBER]",
    pii: true
  }
];

/** 应用单条规则并返回替换数量；RegExp 必须带 global 标志。 */
function applyRule(
  text: string,
  rule: RedactionRule
): { text: string; count: number } {
  let count = 0;
  return {
    text: text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      const groups = args.slice(1, -2);
      return rule.replacement.replace(/\$(\d+)/g, (_match, index: string) => {
        const value = groups[Number(index) - 1];
        return typeof value === "string" ? value : "";
      });
    }),
    count
  };
}

/** 对 UTF-8 evidence 文本执行确定性脱敏。 */
export function redactEvidenceText(
  text: string,
  policy: EvidenceRedactionPolicy
): RedactionResult {
  let redacted = text;
  const counts: Record<string, number> = {};
  for (const rule of RULES) {
    if (rule.pii && policy !== "secrets-and-pii") {
      continue;
    }
    const result = applyRule(redacted, rule);
    redacted = result.text;
    if (result.count > 0) {
      counts[rule.kind] = (counts[rule.kind] ?? 0) + result.count;
    }
  }
  return { text: redacted, counts };
}

/**
 * 脱敏持久化错误摘要。
 *
 * 错误消息属于不可控的外部输入，Connector、HTTP client 或 SDK 可能把凭据拼进 message。
 * 日志层始终采用 secrets-only，不删除定位所需普通文本，也不把错误中的 PII 当作 evidence。
 */
export function redactIngestionError(
  error: unknown,
  policy: EvidenceRedactionPolicy = "secrets-only"
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactEvidenceText(message, policy).text.slice(0, 500);
}
