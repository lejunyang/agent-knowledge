/**
 * Connector 类型定义统一文档、仓库、会话和工具轨迹的增量摄入契约。
 *
 * Connector 只负责发现、抓取和规范化；治理、加密、manifest、job 和 checkpoint 由
 * ingestion core 统一处理，避免每个来源重新实现安全边界。
 */
import { z } from "zod";
import { ProjectKeySchema } from "../core/knowledgeV2.js";
import {
  SourceVersionProbeSchema,
  type SourceVersionProbe
} from "../storage/sourceManifest.js";

export const ConnectorIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const ConnectorProcessingProfileSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const ConnectorInventoryIdentitySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const ArtifactKindSchema = z.enum([
  "document",
  "transcript",
  "tool_trace",
  "attachment",
  "repository"
]);

export const EvidenceRedactionPolicySchema = z.enum([
  "secrets-only",
  "secrets-and-pii"
]);

export type ArtifactKind = z.output<typeof ArtifactKindSchema>;
export type EvidenceRedactionPolicy = z.output<
  typeof EvidenceRedactionPolicySchema
>;

/**
 * Runtime descriptor schema 在任何 fetch/Vault 写入前验证 Connector 输出。
 *
 * Connector 是可插拔不可信边界，不能只依赖 TypeScript；特别是 source ID、项目 key 和
 * probe 会进入 Git manifest 与 checkpoint，必须先拒绝绝对路径或非规范项目身份。
 */
export const ConnectorSourceDescriptorSchema = z.object({
  sourceId: z.string().regex(/^src_[A-Za-z0-9_.-]+$/),
  connectorId: ConnectorIdSchema,
  externalKey: z.string().min(1),
  title: z.string().min(1),
  artifactKind: ArtifactKindSchema,
  contentType: z.string().min(1),
  projectKeys: z.array(ProjectKeySchema),
  probe: SourceVersionProbeSchema,
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
});

export type ConnectorSourceDescriptor = z.output<
  typeof ConnectorSourceDescriptorSchema
>;

export type NormalizedArtifact = {
  bytes: Buffer;
  textForManifest: string;
  contentType: string;
};

export type ConnectorCursor = {
  version: 1;
  connectorId: string;
  inventoryIdentity?: string;
  updatedAt: string;
  sources: Record<
    string,
    {
      sourceId: string;
      versionFingerprint: string;
      lastCheckedAt: string;
      lastClassification: string;
    }
  >;
};

/**
 * Connector 实现必须保持只读；checkpoint 由 ingestion core 在完整 job 成功后原子推进。
 */
export interface KnowledgeConnector {
  readonly id: string;
  readonly processingProfile: string;
  readonly inventoryMode?: "partial" | "complete";
  discover(cursor: ConnectorCursor | null): AsyncIterable<ConnectorSourceDescriptor>;
  inventoryIdentity?(): Promise<string | null>;
  inventoryVersion?(): Promise<SourceVersionProbe | null>;
  fetch(descriptor: ConnectorSourceDescriptor): Promise<Buffer>;
  normalize(
    descriptor: ConnectorSourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact>;
}

export type IngestionJobStatus = "completed" | "skipped" | "failed";

export type IngestionJob = {
  version: 1;
  id: string;
  connectorId: string;
  sourceId: string;
  externalKey: string;
  status: IngestionJobStatus;
  startedAt: string;
  finishedAt: string;
  classification?:
    | "new"
    | "unchanged"
    | "metadata_only"
    | "content_changed"
    | "removed"
    | "restored";
  skipReason?: string;
  vaultObject?: string;
  sourceManifestPath?: string;
  redactions?: Record<string, number>;
  error?: string;
};

export type IngestionRunResult = {
  connectorId: string;
  discovered: number;
  completed: number;
  skipped: number;
  failed: number;
  jobs: IngestionJob[];
  checkpointPath: string;
};
