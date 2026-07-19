/**
 * 检索模型缓存管理是唯一刻意下载模型的代码路径。
 *
 * status 只通过 Transformers.js registry 做本地检查；download 必须由显式命令触发并上报进度。
 * query、Hook 和 embed-index 继续保持 local-only。
 */
import type { UserConfig } from "../core/config.js";
import { EMBEDDING_PROFILES } from "./embeddings.js";

export type RetrievalModelKind = "embedding" | "reranker";

export type RetrievalModelDescriptor = {
  kind: RetrievalModelKind;
  task: "feature-extraction" | "text-classification";
  model: string;
  cacheDir: string;
  dtype: "q8";
};

export type ModelCacheFile = {
  path: string;
  cached: boolean;
};

export type RetrievalModelStatus = RetrievalModelDescriptor & {
  cached: boolean;
  files: ModelCacheFile[];
  missingFiles: string[];
};

export type ModelProgressEvent = {
  status?: string;
  file?: string;
  progress?: number;
};

export type ModelCacheAdapter = {
  status(options: RetrievalModelDescriptor): Promise<{
    cached: boolean;
    files: ModelCacheFile[];
  }>;
  download(options: RetrievalModelDescriptor & {
    onProgress?: (event: ModelProgressEvent) => void;
  }): Promise<void>;
};

/** 把 Transformers.js ModelRegistry 适配为可注入、可测试的缓存管理接口。 */
export class TransformersModelCacheAdapter implements ModelCacheAdapter {
  /** 只查询本地 registry 文件状态，不触发网络请求。 */
  async status(options: RetrievalModelDescriptor): Promise<{
    cached: boolean;
    files: ModelCacheFile[];
  }> {
    const transformers = (await import("@huggingface/transformers")) as {
      ModelRegistry: {
        is_pipeline_cached_files(
          task: string,
          model: string,
          options: Record<string, unknown>
        ): Promise<unknown>;
      };
    };
    const result = (await transformers.ModelRegistry.is_pipeline_cached_files(
      options.task,
      options.model,
      {
        cache_dir: options.cacheDir,
        dtype: options.dtype,
        local_files_only: true
      }
    )) as unknown;
    return normalizeRegistryStatus(result);
  }

  /** 显式开放远程模型并下载到 Agent Knowledge 专用缓存目录。 */
  async download(
    options: RetrievalModelDescriptor & {
      onProgress?: (event: ModelProgressEvent) => void;
    }
  ): Promise<void> {
    const transformers = (await import("@huggingface/transformers")) as {
      env: {
        allowRemoteModels?: boolean;
        allowLocalModels?: boolean;
        cacheDir?: string;
      };
      pipeline(task: string, model: string, options: Record<string, unknown>): Promise<unknown>;
    };
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = true;
    transformers.env.cacheDir = options.cacheDir;
    await transformers.pipeline(options.task, options.model, {
      cache_dir: options.cacheDir,
      local_files_only: false,
      dtype: options.dtype,
      progress_callback: options.onProgress
    });
  }
}

/** 从用户配置解析 embedding/reranker 的模型、任务、dtype 和专用缓存目录。 */
export function resolveRetrievalModelDescriptor(
  config: UserConfig["embeddings"],
  kind: RetrievalModelKind
): RetrievalModelDescriptor {
  if (kind === "embedding") {
    const profile = EMBEDDING_PROFILES[config.profile];
    return {
      kind,
      task: "feature-extraction",
      model: config.model ?? profile.model,
      cacheDir: config.cacheDir,
      dtype: "q8"
    };
  }
  return {
    kind,
    task: "text-classification",
    model: config.rerankerModel ?? "Xenova/bge-reranker-large",
    cacheDir: config.cacheDir,
    dtype: "q8"
  };
}

/** 只检查本地缓存状态，不联网，也不隐式下载缺失文件。 */
export async function getRetrievalModelStatus(
  descriptor: RetrievalModelDescriptor,
  adapter: ModelCacheAdapter = new TransformersModelCacheAdapter()
): Promise<RetrievalModelStatus> {
  const status = await adapter.status(descriptor);
  return {
    ...descriptor,
    cached: status.cached,
    files: status.files,
    missingFiles: status.files.filter((file) => !file.cached).map((file) => file.path)
  };
}

/** 通过显式模型下载入口填充缓存，并在完成后重新读取真实本地状态。 */
export async function downloadRetrievalModel(
  descriptor: RetrievalModelDescriptor,
  adapter: ModelCacheAdapter = new TransformersModelCacheAdapter(),
  onProgress?: (event: ModelProgressEvent) => void
): Promise<RetrievalModelStatus> {
  await adapter.download({ ...descriptor, onProgress });
  return getRetrievalModelStatus(descriptor, adapter);
}

/** 兼容 Transformers.js registry 的多种返回形状，并归一化为文件级缓存状态。 */
function normalizeRegistryStatus(input: unknown): {
  cached: boolean;
  files: ModelCacheFile[];
} {
  if (typeof input === "boolean") {
    return { cached: input, files: [] };
  }
  if (!input || typeof input !== "object") {
    return { cached: false, files: [] };
  }
  const object = input as Record<string, unknown>;
  const rawFiles = Array.isArray(object.files)
    ? object.files
    : Array.isArray(object.file_statuses)
      ? object.file_statuses
      : [];
  const files = rawFiles
    .map((file): ModelCacheFile | null => {
      if (!file || typeof file !== "object") {
        return null;
      }
      const record = file as Record<string, unknown>;
      const path =
        typeof record.path === "string"
          ? record.path
          : typeof record.file === "string"
            ? record.file
            : typeof record.name === "string"
              ? record.name
              : null;
      if (!path) {
        return null;
      }
      return {
        path,
        cached:
          record.cached === true ||
          record.exists === true ||
          record.is_cached === true
      };
    })
    .filter((file): file is ModelCacheFile => file !== null);
  const cached =
    object.cached === true ||
    object.is_cached === true ||
    (files.length > 0 && files.every((file) => file.cached));
  return { cached, files };
}
