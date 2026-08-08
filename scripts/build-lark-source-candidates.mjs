#!/usr/bin/env node
/**
 * 把递归 Lark corpus 转换为可交给 `capture-material` 的 source candidate 批次。
 *
 * 原始响应继续保存在 local_exports；知识正文保留完整文本、表格、cite 和结构，但移除短期
 * authcode URL、资源 token 和 block id，避免把临时访问句柄当作长期事实。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** 生成稳定知识 ID 片段。 */
function stableId(key) {
  return `k_lark_source_${createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 20)}`;
}

/** 返回 source manifest 使用的标准 SHA-256 hex。 */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 去除 XML 标签并归一化空白；调用前必须完成 source 脱敏。 */
function stripXml(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 以固定字段顺序计算版本 fingerprint，保持与 TypeScript runtime 一致。 */
function sourceVersionFingerprint(upstream, contentHash) {
  return `sha256:${sha256(
    JSON.stringify({
      revision: upstream.revision ?? null,
      updated_at: upstream.updated_at ?? null,
      etag: upstream.etag ?? null,
      commit_sha: upstream.commit_sha?.toLowerCase() ?? null,
      opaque_version: upstream.opaque_version ?? null,
      content_hash: contentHash
    })
  )}`;
}

/** 生成只受当前 section 标题路径和正文影响的稳定 section ID。 */
function sourceSectionId(sourceId, headingPath, text) {
  return `sec_${sha256(
    JSON.stringify([sourceId, headingPath, sha256(text.trim())])
  ).slice(0, 20)}`;
}

/** 从已经脱敏的飞书 XML 构建版本化 source manifest。 */
export function buildLarkSourceManifest(input) {
  const headings = [
    ...input.content.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)
  ].flatMap((match) => {
    const title = stripXml(match[2] ?? "");
    return title
      ? [
          {
            level: Number.parseInt(match[1] ?? "1", 10),
            title,
            start: match.index ?? 0,
            contentStart: (match.index ?? 0) + match[0].length
          }
        ]
      : [];
  });
  let headingPath = [];
  const sections = headings.map((heading, index) => {
    headingPath = [
      ...headingPath.slice(0, heading.level - 1),
      heading.title
    ];
    const end = headings[index + 1]?.start ?? input.content.length;
    const text =
      stripXml(input.content.slice(heading.contentStart, end)) || heading.title;
    return {
      section_id: sourceSectionId(input.sourceId, headingPath, text),
      heading_path: headingPath,
      text_hash: `sha256:${sha256(text)}`,
      char_start: heading.start,
      char_end: Math.max(heading.start + 1, end),
      preview: text.slice(0, 500)
    };
  });
  if (sections.length === 0) {
    const text = stripXml(input.content) || input.title;
    sections.push({
      section_id: sourceSectionId(input.sourceId, ["正文"], text),
      heading_path: ["正文"],
      text_hash: `sha256:${sha256(text)}`,
      char_start: 0,
      char_end: Math.max(1, input.content.length),
      preview: text.slice(0, 500)
    });
  }
  const contentHash = `sha256:${sha256(input.content)}`;
  const upstream = {
    ...(input.revision === undefined
      ? {}
      : { revision: String(input.revision) }),
    ...(input.updatedAt ? { updated_at: input.updatedAt } : {})
  };
  return {
    schema_version: 1,
    source_id: input.sourceId,
    connector: "lark",
    external_key: input.externalKey,
    title: input.title,
    version: {
      observed_at: input.observedAt,
      upstream,
      content_hash: contentHash,
      fingerprint: sourceVersionFingerprint(upstream, contentHash)
    },
    processing_status: "pending",
    sections
  };
}

/** 从 XML 标题或 manifest 标题生成短摘要。 */
function sourceSummary(title, content) {
  const text = content
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const excerpt = text.slice(0, 300);
  return `${title} 的飞书完整来源证据。${excerpt ? ` 内容摘要：${excerpt}` : ""}`;
}

/** 移除临时资源句柄，同时保留图片 alt、引用标题和正文结构。 */
export function sanitizeLarkSourceXml(content) {
  return content
    .replace(/\s+id="[^"]*"/g, "")
    .replace(/\s+href="https:\/\/internal-api-drive-stream\.[^"]*"/g, "")
    .replace(/\s+src="[^"]*"/g, "")
    .replace(/\s+token="[^"]*"/g, "")
    .replace(
      /<cite\b[^>]*\btype="user"[^>]*>[\s\S]*?<\/cite>/gi,
      "[REDACTED_PERSON]"
    )
    .replace(/\s+doc-id="([^"]*)"/g, ' doc-ref="$1"')
    .replace(/\s+src-token="([^"]*)"/g, ' doc-ref="$1"')
    .replace(/\s+src-block-id="[^"]*"/g, "");
}

/** 遮蔽常见凭据值，保留字段名和周边说明供知识审阅。 */
export function redactSecretLikeContent(content) {
  return content
    .replace(
      /<cite\b[^>]*\btype="user"[^>]*>[\s\S]*?<\/cite>/gi,
      "[REDACTED_PERSON]"
    )
    .replace(
      /<table\b[^>]*>[\s\S]*?<\/table>/gi,
      (table) =>
        /(?:账号|手机号)[^<\d]{0,20}\d{11}[\s\S]{0,80}(?:验证码|密码|\/|\s)\s*[A-Za-z0-9!@#$%^&*._+-]{4,}/i.test(
          table.replace(/<[^>]+>/g, " ")
        )
          ? "[REDACTED_CREDENTIAL_TABLE]"
          : table
    )
    .replace(
      /<p\b[^>]*>[\s\S]*?<\/p>/gi,
      (paragraph) =>
        /(?:(?:测试)?(?:账号|手机号)\s*[:：]?\s*\d{11}|(?:验证码|密码)\s*[:：]\s*[A-Za-z0-9!@#$%^&*._+-]{4,})/i.test(
          paragraph
        )
          ? "[REDACTED_CREDENTIAL_ROW]"
          : paragraph
    )
    .replace(
      /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]"
    )
    .replace(
      /(api[_-]?key\s*=\s*["']?)[a-z0-9_-]{20,}/gi,
      "$1[REDACTED_SECRET]"
    )
    .replace(
      /(token\s*=\s*["']?)[a-z0-9_.-]{20,}/gi,
      "$1[REDACTED_SECRET]"
    )
    .replace(
      /(token\s*[:=]\s*["']?)[a-z0-9+/_=.-]{20,}/gi,
      "$1[REDACTED_SECRET]"
    )
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|app[_-]?token|msToken|password|passwd|pwd)\s*[:=]\s*["']?)[^&"'\s<]{4,}/gi,
      "$1[REDACTED_SECRET]"
    )
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|app[_-]?token|msToken|token|password|passwd|pwd|mobile|phone)=)[^&"<\s]+/gi,
      "$1[REDACTED_SECRET]"
    )
    .replace(/sk-[a-z0-9]{20,}/gi, "[REDACTED_SECRET]")
    .replace(/\b\d{17}[\dXx]\b/g, "[REDACTED_ID_NUMBER]")
    .replace(/\b\d{11}\b/g, "[REDACTED_PHONE]")
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[REDACTED_EMAIL]"
    );
}

/**
 * 检查脱敏后的 source 是否仍含明确凭据或个人标识。
 *
 * 这里只检查实际值，不把“密码重置”“测试账号流程”等普通业务术语当成敏感内容。
 */
export function auditLarkSourceContent(content) {
  const checks = [
    ["temporary_download_url", /https:\/\/internal-api-drive-stream\./i],
    ["lark_user_identity", /(?:user-id|user-name)="|<cite\b[^>]*\btype="user"/i],
    [
      "secret_assignment",
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?token|msToken|password|passwd|pwd)\s*[:=]\s*(?!["']?\[REDACTED_SECRET\])["']?[^&"'\s<]{4,}|token\s*[:=]\s*["']?[a-z0-9+/_=.-]{20,}/i
    ],
    ["private_key", /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/i],
    ["phone_number", /\b\d{11}\b/],
    ["id_number", /\b\d{17}[\dXx]\b/],
    [
      "email_address",
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
    ]
  ];
  return checks
    .filter(([, pattern]) => pattern.test(content))
    .map(([kind]) => kind);
}

/** 解析 CLI 参数。 */
function parseArguments(argv) {
  let input;
  let output = path.join(
    REPOSITORY_ROOT,
    "local_exports",
    "organizer",
    "lark-source-batches"
  );
  let batchSize = 20;
  let projectKey;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      input = path.resolve(argv[++index]);
    } else if (argument === "--output") {
      output = path.resolve(argv[++index]);
    } else if (argument === "--batch-size") {
      batchSize = Number.parseInt(argv[++index], 10);
    } else if (argument === "--project-key") {
      projectKey = argv[++index];
    } else if (argument === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!input) {
    throw new Error("--input manifest path is required");
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("--batch-size must be a positive integer");
  }
  return { help: false, input, output, batchSize, projectKey };
}

/** 生成 source candidate batches 和可审计映射表。 */
export async function buildLarkSourceCandidates(options) {
  const manifest = JSON.parse(await readFile(options.input, "utf8"));
  const corpusRoot = path.dirname(options.input);
  const documents = Object.values(manifest.documents).sort((left, right) =>
    left.key.localeCompare(right.key)
  );
  await rm(options.output, { recursive: true, force: true });
  await mkdir(options.output, { recursive: true });
  const manifestsDirectory = path.join(options.output, "source-manifests");
  await mkdir(manifestsDirectory, { recursive: true });
  const candidates = [];
  const mappings = [];
  for (const document of documents) {
    const raw = await readFile(
      path.join(corpusRoot, document.directory, "content.xml"),
      "utf8"
    );
    const content = redactSecretLikeContent(sanitizeLarkSourceXml(raw));
    const privacyFindings = auditLarkSourceContent(content);
    if (privacyFindings.length > 0) {
      throw new Error(
        `Source privacy audit failed for ${document.key}: ${privacyFindings.join(", ")}`
      );
    }
    const id = stableId(document.key);
    const sourceId = `src_${id.slice(2)}`;
    const sourceManifest = buildLarkSourceManifest({
      sourceId,
      externalKey: document.key,
      title: document.title,
      content,
      observedAt:
        document.observedAt ?? manifest.generatedAt ?? new Date().toISOString(),
      revision: document.revisionId,
      updatedAt: document.upstreamUpdatedAt
    });
    const manifestRelativePath = path.posix.join(
      "source-manifests",
      `${sourceId}.json`
    );
    await writeFile(
      path.join(options.output, manifestRelativePath),
      `${JSON.stringify(sourceManifest, null, 2)}\n`,
      "utf8"
    );
    candidates.push({
      id,
      title: document.title,
      memory_type: "source",
      domain: "bytedance/business/source/lark",
      related_domains: ["bytedance/business"],
      scenario: ["business-source", "lark-document"],
      tags: ["lark", "source", String(document.objType ?? "docx")],
      confidence: 0.95,
      source_authority: "documented",
      summary: sourceSummary(document.title, content),
      content,
      evidence: [
        `lark:${document.key}`,
        `source:${sourceId}`,
        `manifest:${manifestRelativePath}`
      ],
      capture_mode: "direct_material",
      actor_type: "owner",
      project_keys: options.projectKey ? [options.projectKey] : []
    });
    mappings.push({
      id,
      key: document.key,
      title: document.title,
      directory: document.directory,
      contentHash: document.contentHash,
      sourceId,
      sourceManifest: manifestRelativePath,
      sourceVersion: sourceManifest.version
    });
  }
  const batchPaths = [];
  for (let index = 0; index < candidates.length; index += options.batchSize) {
    const number = String(index / options.batchSize + 1).padStart(4, "0");
    const target = path.join(options.output, `batch-${number}.json`);
    await writeFile(
      target,
      `${JSON.stringify(candidates.slice(index, index + options.batchSize), null, 2)}\n`,
      "utf8"
    );
    batchPaths.push(target);
  }
  await writeFile(
    path.join(options.output, "mapping.json"),
    `${JSON.stringify(mappings, null, 2)}\n`,
    "utf8"
  );
  return {
    documents: candidates.length,
    batches: batchPaths.length,
    output: options.output,
    batchPaths
  };
}

/** 打印脚本用法。 */
function printHelp() {
  console.log(`Usage:
  node scripts/build-lark-source-candidates.mjs \
    --input local_exports/lark-business/manifest.json \
    [--output local_exports/organizer/lark-source-batches] \
    [--batch-size 20] [--project-key github.com/owner/repo]`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    console.log(
      JSON.stringify(await buildLarkSourceCandidates(options), null, 2)
    );
  }
}
