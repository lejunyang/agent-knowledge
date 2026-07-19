import type { RemoteSyncManifest, SyncBackend } from "./sync.js";

export type WebDavSyncBackendOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
};

export class WebDavSyncBackend implements SyncBackend {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authorization?: string;

  constructor(options: WebDavSyncBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.id = `webdav:${this.baseUrl}`;
    if (options.username !== undefined || options.password !== undefined) {
      this.authorization = `Basic ${Buffer.from(`${options.username ?? ""}:${options.password ?? ""}`).toString("base64")}`;
    }
  }

  private url(filePath: string): string {
    return `${this.baseUrl}/${filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }

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

  private async request(filePath: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(this.url(filePath), {
      ...init,
      headers: new Headers({
        ...Object.fromEntries(this.headers(init.body === undefined ? undefined : "application/octet-stream")),
        ...Object.fromEntries(new Headers(init.headers))
      })
    });
  }

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

  async readFile(filePath: string): Promise<string> {
    const response = await this.request(filePath, { method: "GET", headers: this.headers() });
    if (!response.ok) {
      throw new Error(`WebDAV file GET failed for ${filePath}: ${response.status}`);
    }
    return response.text();
  }

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

  async deleteFile(filePath: string): Promise<void> {
    const response = await this.request(filePath, { method: "DELETE", headers: this.headers() });
    if (!response.ok && response.status !== 404) {
      throw new Error(`WebDAV file DELETE failed for ${filePath}: ${response.status}`);
    }
  }

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
