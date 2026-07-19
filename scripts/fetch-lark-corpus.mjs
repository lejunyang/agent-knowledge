#!/usr/bin/env node
/**
 * 递归导出飞书 Wiki/Doc 内容。
 *
 * 脚本只执行只读 `lark-cli` 命令，将 raw JSON、完整 XML、引用图和失败信息写到指定目录。
 * 默认遍历 wiki/docx/doc 引用；Sheet/Base/Whiteboard 等资源记录到 manifest，交由后续专用流程处理。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT = path.join(REPOSITORY_ROOT, "local_exports", "lark");
const DOCUMENT_TYPES = new Set(["wiki", "docx", "doc"]);

/** 对 XML attribute 做最小实体解码，便于恢复标题和 URL。 */
function decodeXmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** 把 XML 标签中的 attribute 解析成普通对象；只处理 fetch 输出使用的双引号格式。 */
function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([:\w-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

/** 从 URL 提取支持的飞书 Wiki/Doc token。 */
function referenceFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    !/(?:^|\.)(?:feishu\.cn|larksuite\.com|larkoffice\.com|doubao\.com)$/i.test(
      parsed.hostname
    )
  ) {
    return null;
  }
  const match = parsed.pathname.match(
    /^\/(wiki|docx|docs?)\/([A-Za-z0-9_-]+)/i
  );
  if (!match) {
    return null;
  }
  const rawType = match[1].toLowerCase();
  return {
    token: match[2],
    fileType: rawType === "wiki" ? "wiki" : "docx",
    title: undefined,
    source: "url"
  };
}

/**
 * 从完整 DocxXML 中提取可递归文档引用和其他嵌入资源。
 *
 * 同 token/type 只保留一条，避免同一文档多处引用导致队列膨胀。
 */
export function extractLarkReferences(content) {
  const references = new Map();
  const resources = new Map();
  const add = (target, item) => {
    if (!item.token) {
      return;
    }
    const key = `${item.fileType}:${item.token}`;
    if (!target.has(key)) {
      target.set(key, item);
    }
  };

  for (const match of content.matchAll(/<cite\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[1]);
    const fileType = String(attributes["file-type"] ?? "").toLowerCase();
    const item = {
      token: attributes["doc-id"] ?? attributes.token,
      fileType,
      title: attributes.title,
      source: "cite"
    };
    add(DOCUMENT_TYPES.has(fileType) ? references : resources, item);
  }

  for (const match of content.matchAll(/<synced_reference\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[1]);
    add(references, {
      token: attributes["src-token"],
      fileType: "docx",
      title: undefined,
      source: "synced_reference"
    });
  }

  for (const match of content.matchAll(/<(sheet|bitable|whiteboard)\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[2]);
    add(resources, {
      token: attributes.token,
      fileType: match[1],
      title: attributes.title ?? attributes.name,
      source: match[1]
    });
  }

  for (const match of content.matchAll(/<a\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[1]);
    const reference = attributes.href
      ? referenceFromUrl(attributes.href)
      : null;
    if (reference) {
      add(references, reference);
    }
  }

  return {
    documents: [...references.values()],
    resources: [...resources.values()]
  };
}

/** 生成稳定短 hash，用于同 token 不同类型的安全目录名。 */
function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** 将任意标题规范为安全、可读的目录片段。 */
function safeName(value) {
  const normalized = String(value ?? "untitled")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "untitled";
}

/** 原子写 JSON，避免长任务中断留下半写 manifest。 */
async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/** 执行 lark-cli 并校验统一 JSON envelope。 */
async function runLark(args) {
  const { stdout, stderr } = await execFileAsync("lark-cli", args, {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
    },
    maxBuffer: 128 * 1024 * 1024
  });
  const payload = JSON.parse(stdout);
  if (payload.ok !== true) {
    throw new Error(
      `lark-cli ${args.join(" ")} failed: ${stderr || stdout}`
    );
  }
  return payload;
}

/** 尝试解析 Wiki node 元数据；普通 docx 不在 Wiki 时允许返回 null。 */
async function resolveNode(reference, identity) {
  const args = [
    "wiki",
    "+node-get",
    "--as",
    identity,
    "--node-token",
    reference.token,
    "--format",
    "json"
  ];
  if (reference.fileType !== "wiki") {
    args.push(
      "--obj-type",
      reference.fileType === "doc" ? "doc" : "docx"
    );
  }
  try {
    return await runLark(args);
  } catch (error) {
    if (reference.fileType === "wiki") {
      throw error;
    }
    return null;
  }
}

/** 拉取完整 XML，保留 block ID、cite 和内嵌资源元数据。 */
async function fetchDocument(reference, identity) {
  return runLark([
    "docs",
    "+fetch",
    "--as",
    identity,
    "--doc",
    reference.token,
    "--detail",
    "full",
    "--doc-format",
    "xml",
    "--format",
    "json"
  ]);
}

/** 从 URL 或 raw token 构造首层 queue item。 */
function rootReference(input) {
  const urlReference = referenceFromUrl(input);
  if (urlReference) {
    return { ...urlReference, original: input };
  }
  return {
    token: input,
    fileType: "wiki",
    title: undefined,
    source: "root",
    original: input
  };
}

/** 解析简单 CLI 参数；`--root-url` 可重复。 */
function parseArguments(argv) {
  const roots = [];
  let output = DEFAULT_OUTPUT;
  let identity = "user";
  let maxDocuments = 500;
  let retryFailures = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root-url") {
      roots.push(argv[++index]);
    } else if (argument === "--output") {
      output = path.resolve(argv[++index]);
    } else if (argument === "--as") {
      identity = argv[++index];
    } else if (argument === "--max-documents") {
      maxDocuments = Number.parseInt(argv[++index], 10);
    } else if (argument === "--retry-failures") {
      retryFailures = true;
    } else if (argument === "--help") {
      return {
        help: true,
        roots,
        output,
        identity,
        maxDocuments,
        retryFailures
      };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (roots.length === 0) {
    throw new Error("At least one --root-url is required");
  }
  if (identity !== "user" && identity !== "bot") {
    throw new Error("--as must be user or bot");
  }
  if (!Number.isInteger(maxDocuments) || maxDocuments <= 0) {
    throw new Error("--max-documents must be a positive integer");
  }
  return {
    help: false,
    roots,
    output,
    identity,
    maxDocuments,
    retryFailures
  };
}

/** 打印脚本用法。 */
function printHelp() {
  console.log(`Usage:
  node scripts/fetch-lark-corpus.mjs \\
    --root-url <wiki-or-doc-url> [--root-url <url> ...] \\
    [--output local_exports/lark] [--as user] [--max-documents 500] \\
    [--retry-failures]`);
}

/**
 * 执行递归导出。
 *
 * Queue 使用 type+token 去重；失败节点写入 manifest 后继续，便于长任务最终集中处理权限或格式问题。
 */
export async function fetchLarkCorpus(options) {
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const manifestPath = path.join(output, "manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots: [],
        documents: {},
        resources: {},
        failures: {}
      };
  manifest.roots = [
    ...new Set([...manifest.roots, ...options.roots])
  ];
  // Parser 升级后从已保存 XML 重建引用图，避免旧误判永久污染恢复队列。
  manifest.resources = {};
  for (const document of Object.values(manifest.documents)) {
    const contentPath = path.join(
      output,
      document.directory,
      "content.xml"
    );
    if (!existsSync(contentPath)) {
      continue;
    }
    const references = extractLarkReferences(
      await readFile(contentPath, "utf8")
    );
    document.documentReferences = references.documents;
    document.resourceReferences = references.resources;
    for (const resource of references.resources) {
      manifest.resources[`${resource.fileType}:${resource.token}`] = {
        ...resource,
        parent: document.key
      };
    }
  }
  const stillReferenced = new Set(
    options.roots.map((root) => {
      const reference = rootReference(root);
      return `${reference.fileType}:${reference.token}`;
    })
  );
  for (const document of Object.values(manifest.documents)) {
    for (const child of document.documentReferences ?? []) {
      stillReferenced.add(`${child.fileType}:${child.token}`);
    }
  }
  for (const key of Object.keys(manifest.failures)) {
    if (!stillReferenced.has(key)) {
      delete manifest.failures[key];
    }
  }
  const visited = new Set(Object.keys(manifest.documents));
  if (!options.retryFailures) {
    for (const key of Object.keys(manifest.failures)) {
      visited.add(key);
    }
  }
  const queue = [];
  const queued = new Set();
  /** 只把尚未成功导出且本轮未排队的引用加入 queue。 */
  const enqueue = (reference) => {
    const key = `${reference.fileType}:${reference.token}`;
    if (visited.has(key) || queued.has(key)) {
      return;
    }
    queued.add(key);
    queue.push(reference);
  };
  for (const root of options.roots) {
    enqueue(rootReference(root));
  }
  // 恢复长任务时从已抓文档的引用图重建 pending queue，不能只重新处理 root。
  for (const document of Object.values(manifest.documents)) {
    for (const child of document.documentReferences ?? []) {
      enqueue({
        ...child,
        original: document.original,
        parent: document.key
      });
    }
  }
  let attempted = 0;

  while (queue.length > 0) {
    if (attempted >= options.maxDocuments) {
      break;
    }
    const reference = queue.shift();
    const key = `${reference.fileType}:${reference.token}`;
    queued.delete(key);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    attempted += 1;
    const directory = path.join(
      output,
      `${safeName(reference.title ?? reference.token)}-${shortHash(key)}`
    );
    try {
      const node = await resolveNode(reference, options.identity);
      const resolved = node?.data ?? {};
      const fetchToken =
        resolved.obj_token ??
        resolved.node_token ??
        reference.token;
      const fetchReference = {
        ...reference,
        token: fetchToken,
        fileType: resolved.obj_type ?? reference.fileType,
        title: resolved.title ?? reference.title
      };
      const document = await fetchDocument(fetchReference, options.identity);
      const documentData = document.data?.document;
      if (!documentData?.content) {
        throw new Error(`Document content missing for ${key}`);
      }
      const references = extractLarkReferences(documentData.content);
      await mkdir(directory, { recursive: true });
      await writeJson(path.join(directory, "node.json"), node);
      await writeJson(path.join(directory, "document.json"), document);
      await writeFile(
        path.join(directory, "content.xml"),
        documentData.content,
        "utf8"
      );
      const record = {
        key,
        requestedToken: reference.token,
        fetchToken,
        nodeToken: resolved.node_token,
        objToken: resolved.obj_token ?? documentData.document_id,
        objType: resolved.obj_type ?? reference.fileType,
        title:
          resolved.title ??
          reference.title ??
          documentData.title ??
          reference.token,
        spaceId: resolved.space_id,
        parentNodeToken: resolved.parent_node_token,
        revisionId: documentData.revision_id,
        source: reference.source,
        original: reference.original,
        directory: path.relative(output, directory),
        contentHash: createHash("sha256")
          .update(documentData.content)
          .digest("hex"),
        documentReferences: references.documents,
        resourceReferences: references.resources
      };
      manifest.documents[key] = record;
      delete manifest.failures[key];
      for (const child of references.documents) {
        enqueue({
          ...child,
          original: reference.original,
          parent: key
        });
      }
      for (const resource of references.resources) {
        manifest.resources[`${resource.fileType}:${resource.token}`] = {
          ...resource,
          parent: key
        };
      }
    } catch (error) {
      manifest.failures[key] = {
        key,
        token: reference.token,
        fileType: reference.fileType,
        title: reference.title,
        parent: reference.parent,
        message: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
    }
    manifest.generatedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.error(
      `[${attempted}] ${key} documents=${Object.keys(manifest.documents).length} failures=${Object.keys(manifest.failures).length}`
    );
  }
  manifest.complete = queue.length === 0;
  manifest.pending = queue.map((reference) => ({
    token: reference.token,
    fileType: reference.fileType,
    title: reference.title,
    parent: reference.parent
  }));
  manifest.generatedAt = new Date().toISOString();
  await writeJson(manifestPath, manifest);
  return manifest;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    const manifest = await fetchLarkCorpus(options);
    console.log(
      JSON.stringify(
        {
          output: path.resolve(options.output),
          documents: Object.keys(manifest.documents).length,
          resources: Object.keys(manifest.resources).length,
          failures: Object.keys(manifest.failures).length,
          complete: manifest.complete,
          pending: manifest.pending?.length ?? 0
        },
        null,
        2
      )
    );
  }
}
