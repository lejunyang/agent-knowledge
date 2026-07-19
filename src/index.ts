/**
 * 公共库入口。
 *
 * CLI 和外部 TypeScript 调用方都从这里导入能力。保持这个文件只做 re-export，
 * 可以避免入口层承载业务逻辑，也方便后续拆包。
 */
export * from "./core/types.js";
export * from "./core/schema.js";
export * from "./core/paths.js";
export * from "./core/logging.js";
export * from "./storage/markdown.js";
export * from "./storage/workspace.js";
export * from "./storage/indexer.js";
export * from "./storage/catalog.js";
export * from "./retrieval/query.js";
export * from "./retrieval/contextPacket.js";
export * from "./retrieval/eval.js";
export * from "./retrieval/scoring.js";
export * from "./retrieval/feedback.js";
export * from "./retrieval/embeddings.js";
export * from "./memory/governance.js";
export * from "./memory/inbox.js";
export * from "./memory/organizer.js";
export * from "./integration/templates.js";
export * from "./integration/manager.js";
export * from "./integration/projects.js";
export * from "./sync/core.js";
export * from "./sync/webdav.js";
export * from "./sync/s3.js";
export * from "./hooks/staging.js";
