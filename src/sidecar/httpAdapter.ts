/**
 * HTTP sidecar adapter 统一认证、timeout/retry、payload preset 和 response extraction。
 *
 * 外部 API 版本可能变化，因此 endpoint 可配置；doctor 必须先通过，生产部署还应固定上游版本。
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { redactEvidenceText } from "../ingestion/redaction.js";
import {
  SidecarConfigSchema,
  type SidecarConfig,
  type SidecarConfigInput,
  type SidecarItem,
  type SidecarSearchResponse,
  type SidecarSearchResult
} from "./types.js";
import { writeSidecarRun } from "./store.js";

type SidecarDependencies = {
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  rootDir?: string;
};

/** 将 scope/task ID 安全替换进 endpoint path。 */
function endpoint(
  config: SidecarConfig,
  template: string,
  values: Record<string, string> = {}
): string {
  let path = template.replaceAll("{scope}", encodeURIComponent(config.scope));
  for (const [key, value] of Object.entries(values)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return `${config.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** 生成认证 headers；凭据缺失明确失败，不允许匿名降级。 */
function headers(
  config: SidecarConfig,
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  const output: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (config.auth) {
    const token = environment[config.auth.tokenEnv];
    if (!token) {
      throw new Error(
        `Sidecar auth environment variable is missing: ${config.auth.tokenEnv}`
      );
    }
    output[config.auth.headerName] = `${config.auth.prefix}${token}`;
  }
  return output;
}

/** 只对 timeout/network/408/429/5xx 重试；其他 4xx 是契约/权限问题。 */
function retryable(status: number | null): boolean {
  return status === null || status === 408 || status === 429 || status >= 500;
}

/** 执行有界 JSON HTTP 请求。 */
async function requestJson(
  config: SidecarConfig,
  method: string,
  url: string,
  body: unknown,
  dependencies: SidecarDependencies
): Promise<{ status: number; value: unknown }> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const environment = dependencies.environment ?? process.env;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError = new Error(`Sidecar request failed: ${method} ${url}`);
  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
    let response: Response | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        response = await fetchImpl(url, {
          method,
          headers: headers(config, environment),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 512_000) {
        throw new Error("Sidecar response exceeds 512KB");
      }
      const contentType = response.headers.get("content-type") ?? "";
      const trimmed = text.trim();
      const value =
        !trimmed
          ? {}
          : contentType.includes("json") ||
              trimmed.startsWith("{") ||
              trimmed.startsWith("[")
            ? JSON.parse(trimmed)
            : {
                contentType,
                bytes: Buffer.byteLength(text, "utf8"),
                contentHash: `sha256:${createHash("sha256")
                  .update(text)
                  .digest("hex")}`
              };
      if (response.ok) {
        return { status: response.status, value };
      }
      lastError = new Error(`sidecar_http_${response.status}`);
    } catch (error) {
      lastError = new Error(
        redactEvidenceText(
          error instanceof Error ? error.message : String(error),
          "secrets-only"
        ).text.slice(0, 500)
      );
    }
    if (!retryable(response?.status ?? null) || attempt >= config.retry.maxAttempts) {
      break;
    }
    await sleep(
      Math.min(
        config.retry.maxDelayMs,
        config.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1)
      )
    );
  }
  throw lastError;
}

/** 构造 provider-specific shadow ingest payload。 */
function ingestPayload(config: SidecarConfig, items: SidecarItem[]): unknown {
  switch (config.provider) {
    case "hindsight":
      return {
        items: items.map((item) => ({
          content: item.text,
          context: JSON.stringify({
            native_memory_id: item.id,
            ...item.metadata
          }),
          tags: ["agent-knowledge-shadow"]
        }))
      };
    case "memu":
      return {
        user_id: config.scope,
        agent_id: config.id,
        conversation: items.flatMap((item) => [
          {
            role: "system",
            content: `native_memory_id=${item.id}; metadata=${JSON.stringify(item.metadata)}`
          },
          { role: "user", content: item.text }
        ])
      };
    case "mem0":
      return {
        messages: items.map((item) => ({
          role: "user",
          content: item.text
        })),
        user_id: config.scope,
        agent_id: config.id,
        metadata: {
          source: "agent-knowledge-shadow",
          native_memory_ids: items.map((item) => item.id)
        }
      };
  }
}

/** 构造 provider-specific search payload。 */
function searchPayload(config: SidecarConfig, query: string): unknown {
  switch (config.provider) {
    case "hindsight":
      return { query };
    case "memu":
      return {
        queries: [{ query }],
        where: { user_id: config.scope, agent_id: config.id },
        method: "rag"
      };
    case "mem0":
      return {
        query,
        user_id: config.scope,
        agent_id: config.id
      };
  }
}

/** 从外部响应中提取常见结果形状；未知字段保留在 metadata 便于调试。 */
function extractResults(
  config: SidecarConfig,
  value: unknown
): SidecarSearchResult[] {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  let rawResults: unknown[] = [];
  if (Array.isArray(root.results)) {
    rawResults = root.results;
  } else if (Array.isArray(root.items)) {
    rawResults = root.items;
  } else if (root.data && typeof root.data === "object") {
    const nestedResults = (root.data as Record<string, unknown>).results;
    if (Array.isArray(nestedResults)) {
      rawResults = nestedResults;
    }
  }
  return rawResults.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const item = raw as Record<string, unknown>;
    const textValue =
      item.text ?? item.memory ?? item.content ?? item.summary;
    if (typeof textValue !== "string" || !textValue.trim()) {
      return [];
    }
    const metadata =
      item.metadata && typeof item.metadata === "object"
        ? (item.metadata as Record<string, unknown>)
        : {};
    const nativeMemoryId =
      typeof metadata.native_memory_id === "string"
        ? metadata.native_memory_id
        : typeof item.native_memory_id === "string"
          ? item.native_memory_id
          : undefined;
    const rawScore =
      item.score ?? item.similarity ?? item.relevance ?? item.distance;
    const score =
      typeof rawScore === "number" && Number.isFinite(rawScore)
        ? rawScore
        : 0;
    return [
      {
        text: textValue.trim(),
        score,
        ...(nativeMemoryId ? { nativeMemoryId } : {}),
        metadata: { provider: config.provider, ...metadata }
      }
    ];
  });
}

/** Health probe 接受 2xx/3xx；失败时返回诊断对象而不是写 active state。 */
export async function doctorSidecar(
  rawConfig: SidecarConfigInput,
  dependencies: SidecarDependencies = {}
): Promise<{
  provider: SidecarConfig["provider"];
  sidecarId: string;
  healthy: boolean;
  status?: number;
  error?: string;
}> {
  const config = SidecarConfigSchema.parse(rawConfig);
  try {
    const result = await requestJson(
      config,
      "GET",
      endpoint(config, config.endpoints.health),
      undefined,
      dependencies
    );
    return {
      provider: config.provider,
      sidecarId: config.id,
      healthy: true,
      status: result.status
    };
  } catch (error) {
    return {
      provider: config.provider,
      sidecarId: config.id,
      healthy: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 轮询 memU 异步 task；其他 provider 直接完成。 */
async function pollAsyncTask(
  config: SidecarConfig,
  taskId: string,
  dependencies: SidecarDependencies
): Promise<void> {
  if (!config.endpoints.status) {
    return;
  }
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= config.polling.maxAttempts; attempt += 1) {
    const result = await requestJson(
      config,
      "GET",
      endpoint(config, config.endpoints.status, { task_id: taskId }),
      undefined,
      dependencies
    );
    const status =
      result.value && typeof result.value === "object"
        ? String((result.value as Record<string, unknown>).status ?? "")
            .toLowerCase()
        : "";
    if (["completed", "succeeded", "success", "done"].includes(status)) {
      return;
    }
    if (["failed", "error", "cancelled"].includes(status)) {
      throw new Error(`Sidecar async task failed: ${taskId}`);
    }
    if (attempt < config.polling.maxAttempts) {
      await sleep(config.polling.intervalMs);
    }
  }
  throw new Error(`Sidecar async task timed out: ${taskId}`);
}

/** Shadow ingest 不改变 native knowledge；可选保存有界本地 run artifact。 */
export async function ingestSidecarItems(
  rawConfig: SidecarConfigInput,
  items: SidecarItem[],
  dependencies: SidecarDependencies = {}
): Promise<{ accepted: number; completed: number; runId?: string }> {
  const config = SidecarConfigSchema.parse(rawConfig);
  const startedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const started = performance.now();
  const result = await requestJson(
    config,
    "POST",
    endpoint(config, config.endpoints.ingest),
    ingestPayload(config, items),
    dependencies
  );
  let completed = items.length;
  if (config.provider === "memu") {
    const taskId =
      result.value && typeof result.value === "object"
        ? (result.value as Record<string, unknown>).task_id
        : undefined;
    if (typeof taskId !== "string" || !taskId) {
      throw new Error("memU memorize response is missing task_id");
    }
    await pollAsyncTask(config, taskId, dependencies);
  }
  const output: { accepted: number; completed: number; runId?: string } = {
    accepted: items.length,
    completed
  };
  if (dependencies.rootDir) {
    const completedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const run = await writeSidecarRun(dependencies.rootDir, {
      sidecarId: config.id,
      provider: config.provider,
      operation: "ingest",
      status: "succeeded",
      startedAt,
      completedAt,
      latencyMs: performance.now() - started,
      artifact: {
        provider: config.provider,
        sidecarId: config.id,
        operation: "ingest",
        accepted: items.length,
        completed,
        itemIds: items.map((item) => item.id),
        responseHash: `sha256:${createHash("sha256")
          .update(JSON.stringify(result.value))
          .digest("hex")}`
      }
    });
    output.runId = run.id;
  }
  return output;
}

/** Shadow search 统一返回 text/score/nativeMemoryId，并可保存本地 artifact。 */
export async function searchSidecar(
  rawConfig: SidecarConfigInput,
  query: string,
  dependencies: SidecarDependencies = {}
): Promise<SidecarSearchResponse> {
  const config = SidecarConfigSchema.parse(rawConfig);
  const startedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const started = performance.now();
  const response = await requestJson(
    config,
    "POST",
    endpoint(config, config.endpoints.search),
    searchPayload(config, query),
    dependencies
  );
  const result: SidecarSearchResponse = {
    provider: config.provider,
    sidecarId: config.id,
    query,
    latencyMs: performance.now() - started,
    results: extractResults(config, response.value)
  };
  if (dependencies.rootDir) {
    const completedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const run = await writeSidecarRun(dependencies.rootDir, {
      sidecarId: config.id,
      provider: config.provider,
      operation: "search",
      status: "succeeded",
      startedAt,
      completedAt,
      latencyMs: result.latencyMs,
      artifact: {
        provider: config.provider,
        sidecarId: config.id,
        operation: "search",
        queryHash: `sha256:${createHash("sha256")
          .update(query)
          .digest("hex")}`,
        results: result.results.map((item) => ({
          textHash: `sha256:${createHash("sha256")
            .update(item.text)
            .digest("hex")}`,
          score: item.score,
          nativeMemoryId: item.nativeMemoryId,
          metadataKeys: Object.keys(item.metadata).sort()
        })),
        responseHash: `sha256:${createHash("sha256")
          .update(JSON.stringify(response.value))
          .digest("hex")}`
      }
    });
    result.runId = run.id;
  }
  return result;
}
