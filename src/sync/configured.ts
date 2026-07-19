/**
 * 配置驱动的 sync backend factory 负责把非敏感配置与运行时凭据组合起来。
 *
 * 用户配置只记录凭据环境变量名；这里在真正连接远端前读取对应值，避免 secret 落盘。
 */
import type { UserConfig } from "../core/config.js";
import type { SyncBackend } from "./core.js";
import { S3HttpObjectClient, S3SyncBackend } from "./s3.js";
import { WebDavSyncBackend } from "./webdav.js";

export function createConfiguredSyncBackend(
  config: UserConfig["sync"],
  environment: NodeJS.ProcessEnv = process.env
): SyncBackend {
  if (config.provider === "webdav") {
    if (!config.webdav.url) {
      throw new Error("WebDAV sync URL is not configured");
    }
    return new WebDavSyncBackend({
      baseUrl: config.webdav.url,
      username: config.webdav.username || undefined,
      password: environment[config.webdav.passwordEnv]
    });
  }

  if (config.provider === "s3") {
    if (!config.s3.bucket) {
      throw new Error("S3 sync bucket is not configured");
    }
    const accessKeyId = environment[config.s3.accessKeyIdEnv];
    const secretAccessKey = environment[config.s3.secretAccessKeyEnv];
    if (!accessKeyId) {
      throw new Error(`Missing S3 access key environment variable: ${config.s3.accessKeyIdEnv}`);
    }
    if (!secretAccessKey) {
      throw new Error(`Missing S3 secret key environment variable: ${config.s3.secretAccessKeyEnv}`);
    }
    const client = new S3HttpObjectClient({
      bucket: config.s3.bucket,
      region: config.s3.region,
      endpoint: config.s3.endpoint ?? undefined,
      forcePathStyle: config.s3.forcePathStyle,
      accessKeyId,
      secretAccessKey,
      sessionToken: environment[config.s3.sessionTokenEnv]
    });
    return new S3SyncBackend({
      client,
      prefix: config.s3.prefix,
      id: `s3:${config.s3.endpoint ?? "aws"}:${config.s3.region}:${config.s3.bucket}:${config.s3.prefix}`
    });
  }

  throw new Error("Sync provider is not configured; run `agent-knowledge configure` first");
}
