import { createHash, createHmac } from "node:crypto";
import type { RemoteSyncManifest, SyncBackend } from "./sync.js";

export type S3ObjectClient = {
  getObject(key: string): Promise<string | null>;
  putObject(key: string, content: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
};

export type S3SyncBackendOptions = {
  client: S3ObjectClient;
  prefix?: string;
  id?: string;
};

export type S3HttpObjectClientOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  fetch?: typeof fetch;
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key: Buffer | string, input: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

function encodeS3Path(input: string): string {
  return input
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * 使用原生 fetch 和 AWS Signature V4 访问 S3，避免把重量级 SDK放进 CLI 热路径。
 *
 * 凭据只保存在实例内存中；调用方应从环境变量或标准凭据代理传入。
 */
export class S3HttpObjectClient implements S3ObjectClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: URL;

  constructor(private readonly options: S3HttpObjectClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = new URL(
      options.endpoint ??
        (options.region === "us-east-1"
          ? "https://s3.amazonaws.com"
          : `https://s3.${options.region}.amazonaws.com`)
    );
  }

  async getObject(key: string): Promise<string | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`S3 GET failed for ${key}: ${response.status}`);
    }
    return response.text();
  }

  async putObject(key: string, content: string): Promise<void> {
    const response = await this.request("PUT", key, content);
    if (!response.ok) {
      throw new Error(`S3 PUT failed for ${key}: ${response.status}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 DELETE failed for ${key}: ${response.status}`);
    }
  }

  private objectUrl(key: string): URL {
    const forcePathStyle = this.options.forcePathStyle ?? this.options.endpoint !== undefined;
    const encodedKey = encodeS3Path(key);
    if (forcePathStyle) {
      const url = new URL(this.endpoint);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(this.options.bucket)}/${encodedKey}`;
      return url;
    }
    const url = new URL(this.endpoint);
    url.hostname = `${this.options.bucket}.${url.hostname}`;
    url.pathname = `/${encodedKey}`;
    return url;
  }

  private async request(method: "GET" | "PUT" | "DELETE", key: string, body = ""): Promise<Response> {
    const url = this.objectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers = new Headers({
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    });
    if (this.options.sessionToken) {
      headers.set("x-amz-security-token", this.options.sessionToken);
    }
    if (method === "PUT") {
      headers.set("content-type", "text/plain; charset=utf-8");
    }

    const signedHeaderNames = [...headers.keys()]
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${headers.get(name)?.trim().replace(/\s+/g, " ") ?? ""}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaderNames.join(";"),
      payloadHash
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256(canonicalRequest)
    ].join("\n");
    const dateKey = hmac(`AWS4${this.options.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.options.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`
    );

    return this.fetchImpl(url, {
      method,
      headers,
      ...(method === "PUT" ? { body } : {})
    });
  }
}

export class S3SyncBackend implements SyncBackend {
  readonly id: string;
  private readonly prefix: string;

  constructor(private readonly options: S3SyncBackendOptions) {
    const normalizedPrefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.prefix = normalizedPrefix.length > 0 ? `${normalizedPrefix}/` : "";
    this.id = options.id ?? `s3:${this.prefix}`;
  }

  private key(filePath: string): string {
    return `${this.prefix}${filePath}`;
  }

  async readManifest(): Promise<RemoteSyncManifest | null> {
    const content = await this.options.client.getObject(this.key(".agent-knowledge-manifest.json"));
    return content === null ? null : (JSON.parse(content) as RemoteSyncManifest);
  }

  async writeManifest(manifest: RemoteSyncManifest): Promise<void> {
    await this.options.client.putObject(
      this.key(".agent-knowledge-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  async readFile(filePath: string): Promise<string> {
    const content = await this.options.client.getObject(this.key(filePath));
    if (content === null) {
      throw new Error(`Missing S3 object: ${this.key(filePath)}`);
    }
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.options.client.putObject(this.key(filePath), content);
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.options.client.deleteObject(this.key(filePath));
  }
}
