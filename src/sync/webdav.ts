import type { RemoteSyncManifest, SyncBackend } from "./core.js";

export type WebDavSyncBackendOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
};

/**
 * 使用标准 WebDAV HTTP 方法实现知识同步 backend。
 *
 * Basic 凭据只保存在实例内存中；调用方必须从环境变量注入，不能写入知识或同步 manifest。
 */
export class WebDavSyncBackend implements SyncBackend {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authorization?: string;

  /** 规范化 base URL、构造可选 Basic header，并保留可注入 fetch 供测试。 */
  constructor(options: WebDavSyncBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.id = `webdav:${this.baseUrl}`;
    if (options.username !== undefined || options.password !== undefined) {
      this.authorization = `Basic ${Buffer.from(`${options.username ?? ""}:${options.password ?? ""}`).toString("base64")}`;
    }
  }

  /** 对每个路径段做 URL 编码，避免知识文件名破坏 WebDAV URL。 */
  private url(filePath: string): string {
    return `${this.baseUrl}/${filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }

  /** 构造包含可选 Basic 认证和 content-type 的请求 header。 */
  private headers(contentType?: string): Headers {
    const headers = new Headers();
    if (this.authorization) {
      headers.set("authorization", this.authorization);
    }
    if (contentType) {
      headers.set("content-type", contentType);
    }
    return headers;
  }

  /** 合并默认认证 header 与单次请求 header，并调用底层 fetch。 */
  private async request(filePath: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(this.url(filePath), {
      ...init,
      headers: new Headers({
        ...Object.fromEntries(this.headers(init.body === undefined ? undefined : "application/octet-stream")),
        ...Object.fromEntries(new Headers(init.headers))
      })
    });
  }

  /** 读取远端同步 manifest；404 表示首次同步。 */
  async readManifest(): Promise<RemoteSyncManifest | null> {
    const response = await this.request(".agent-knowledge-manifest.json", {
      method: "GET",
      headers: this.headers("application/json")
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`WebDAV manifest GET failed: ${response.status}`);
    }
    return (await response.json()) as RemoteSyncManifest;
  }

  /** 通过 PUT 写入远端同步 manifest。 */
  async writeManifest(manifest: RemoteSyncManifest): Promise<void> {
    const response = await this.request(".agent-knowledge-manifest.json", {
      method: "PUT",
      headers: this.headers("application/json"),
      body: `${JSON.stringify(manifest, null, 2)}\n`
    });
    if (!response.ok) {
      throw new Error(`WebDAV manifest PUT failed: ${response.status}`);
    }
  }

  /** 读取正式 Markdown；任意非成功状态明确失败。 */
  async readFile(filePath: string): Promise<string> {
    const response = await this.request(filePath, { method: "GET", headers: this.headers() });
    if (!response.ok) {
      throw new Error(`WebDAV file GET failed for ${filePath}: ${response.status}`);
    }
    return response.text();
  }

  /** 写入 Markdown；父 collection 缺失时创建后只重试一次。 */
  async writeFile(filePath: string, content: string): Promise<void> {
    let response = await this.request(filePath, {
      method: "PUT",
      headers: this.headers("text/markdown; charset=utf-8"),
      body: content
    });
    if (response.status === 409) {
      await this.createParentCollections(filePath);
      response = await this.request(filePath, {
        method: "PUT",
        headers: this.headers("text/markdown; charset=utf-8"),
        body: content
      });
    }
    if (!response.ok) {
      throw new Error(`WebDAV file PUT failed for ${filePath}: ${response.status}`);
    }
  }

  /** 删除 Markdown；404 视为幂等成功。 */
  async deleteFile(filePath: string): Promise<void> {
    const response = await this.request(filePath, { method: "DELETE", headers: this.headers() });
    if (!response.ok && response.status !== 404) {
      throw new Error(`WebDAV file DELETE failed for ${filePath}: ${response.status}`);
    }
  }

  /** 从根到叶逐级 MKCOL；405 表示 collection 已存在，可安全忽略。 */
  private async createParentCollections(filePath: string): Promise<void> {
    const segments = filePath.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const collection = segments.slice(0, index).join("/");
      const response = await this.request(collection, { method: "MKCOL", headers: this.headers() });
      if (!response.ok && response.status !== 405) {
        throw new Error(`WebDAV MKCOL failed for ${collection}: ${response.status}`);
      }
    }
  }
}
