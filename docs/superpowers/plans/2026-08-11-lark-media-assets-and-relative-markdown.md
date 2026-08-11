# Lark Media Assets And Relative Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书离线导出识别并下载图片、附件和画板，把二进制作为独立 attachment evidence 摄入 Vault，并允许经过显式审阅的内容寻址资产在 Knowledge Markdown 中以相对路径稳定引用。

**Architecture:** 飞书导出 manifest 升级为 v2：文档保留有序媒体引用，成功下载的二进制记录 SHA-256、MIME、大小和相对路径，失败项进入独立 inventory。Lark Connector 把文档和每个媒体文件发现为独立 source，文档 evidence 中的飞书 token/临时 URL 被替换为安全 `asset-ref source-id`；二进制只自动进入加密 Vault，不直接进入 Git。审阅者显式执行 `source publish-asset` 后，内容寻址副本才写入 `knowledge/assets/`，候选中的 `asset://asset_sha256_<hash>` 在 Markdown 落盘或移动时根据目标文件目录改写为相对路径。

**Tech Stack:** Node.js ESM、TypeScript、Commander、Zod、Vitest、Node test runner、现有 Evidence Vault / source manifest / KnowledgeDocument Markdown。

---

## 文件结构

- `scripts/fetch-lark-corpus.mjs`：解析飞书媒体标签、限流下载、preview fallback、媒体 hash 与 v2 export manifest。
- `src/ingestion/types.ts`：声明文本 evidence 与 binary Vault-only evidence 的 normalize 契约。
- `src/ingestion/core.ts`：对二进制保存原始 Vault bytes，同时只把安全描述文本写入 source manifest。
- `src/ingestion/larkExport.ts`：从 v2 export 发现文档和 attachment，并把文档媒体句柄替换为 source ID。
- `src/storage/sourceAssets.ts`：显式发布 Vault attachment、维护内容寻址资产和把 `asset://` 改写成相对 Markdown 链接。
- `src/memory/inbox.ts`、`src/memory/organizer.ts`：候选首次落盘、active 落盘和 inbox 晋升时解析或重定位资产引用。
- `src/cli.ts`：增加 `source publish-asset` 安全入口和丰富帮助。
- `tests/larkCorpus.test.mjs`：无网络 fake `lark-cli` 媒体下载、去重、fallback 与失败 inventory。
- `tests/larkExportConnector.test.ts`：文档/attachment 摄入、token 清理、binary Vault 和 parent source 引用。
- `tests/sourceAssets.test.ts`：显式发布、hash 校验、active-content 拒绝和幂等。
- `tests/organizer.test.ts`：`asset://` 到相对路径及 inbox 晋升后的路径重写。
- `.trae/skills/source-distiller/SKILL.md` 与 TRAE/Codex 模板副本：说明媒体审阅、发布和候选写法。
- `README.md`、`AGENTS.md`、`docs/guides/evidence-vault.md`、`docs/guides/memory-governance.md`、`docs/guides/synchronization.md`：说明端到端流程和 Git/WebDAV/S3 边界。

### Task 1: 飞书导出识别并下载媒体

**Files:**
- Modify: `tests/larkCorpus.test.mjs`
- Modify: `scripts/fetch-lark-corpus.mjs`

- [x] **Step 1: 写媒体引用顺序和元数据的失败测试**

在 `tests/larkCorpus.test.mjs` 增加包含 `<img>`、`<source>`、`<whiteboard>` 和重复 token 的 XML，断言：

```js
assert.deepEqual(
  result.media.map(({ kind, token, ordinal }) => ({ kind, token, ordinal })),
  [
    { kind: "image", token: "img-token", ordinal: 0 },
    { kind: "attachment", token: "file-token", ordinal: 1 },
    { kind: "whiteboard", token: "board-token", ordinal: 2 },
    { kind: "image", token: "img-token", ordinal: 3 }
  ]
);
assert.equal(result.media[0].alt, "架构图");
assert.equal(result.media[1].name, "排障手册.pdf");
```

- [x] **Step 2: 运行测试确认当前解析器失败**

Run: `node --test tests/larkCorpus.test.mjs`

Expected: FAIL，`result.media` 尚不存在。

- [x] **Step 3: 实现有序媒体引用类型**

在 `extractLarkReferences()` 中按标签在原 XML 中的 offset 排序，生成：

```js
{
  referenceId: `media_ref_${shortHash(`${kind}\0${token}\0${ordinal}`)}`,
  kind: "image" | "attachment" | "whiteboard",
  token,
  ordinal,
  name,
  alt,
  mime,
  blockId,
  source: "img" | "source" | "whiteboard"
}
```

`sheet`、`bitable` 和不能下载的 cite 仍进入 `resources`；whiteboard 只进入 `media`，不能重复进入普通 resource inventory。

- [x] **Step 4: 写 fake CLI 下载和 manifest v2 的失败测试**

构造 fake `lark-cli`：

```js
if (args[0] === "docs" && args[1] === "+media-download") {
  const token = args[args.indexOf("--token") + 1];
  const output = args[args.indexOf("--output") + 1];
  fs.writeFileSync(output, Buffer.from(`binary:${token}`));
  process.stdout.write(JSON.stringify({ ok: true, data: { output } }));
  return;
}
```

文档正文含图片、PDF 附件和画板，断言：

```js
assert.equal(result.version, 2);
assert.equal(Object.keys(result.media).length, 3);
assert.equal(Object.keys(result.mediaFailures).length, 0);
assert.match(result.media[imageRef].sha256, /^[a-f0-9]{64}$/);
assert.equal(result.documents["wiki:root"].mediaReferences.length, 3);
assert.equal(
  await readFile(path.join(output, result.media[imageRef].relativePath), "utf8"),
  "binary:img-token"
);
```

- [x] **Step 5: 运行测试确认当前导出器失败**

Run: `node --test tests/larkCorpus.test.mjs`

Expected: FAIL，manifest 仍为 v1 且没有执行媒体下载。

- [x] **Step 6: 实现有界媒体下载和失败 inventory**

新增 `downloadMediaReference()`，调用：

```text
lark-cli docs +media-download --as <identity> --token <token> --output <path> --format json
```

whiteboard 额外传 `--type whiteboard`；普通媒体下载失败后仅重试一次：

```text
lark-cli docs +media-preview --as <identity> --token <token> --output <path> --format json
```

下载目标位于 `<document-directory>/media/<reference-id>/<safe-name>.<ext>`。成功后记录 `sha256`、`bytes`、`contentType`、`relativePath`、`downloadMethod`、`parent`、`ordinal`、`name`、`alt`；manifest 不保存临时 `href`。失败写 `mediaFailures[<parent>:<reference-id>]`，包含不含 token 的 `referenceId/kind/parent/message/updatedAt`。同文档重复 token 只下载一次但保留多个有序引用；跨文档按 `kind+token` 复用本轮下载结果并分别记录 parent reference。

manifest 固定为：

```js
{
  version: 2,
  generatedAt,
  roots,
  documents,
  resources,
  media,
  failures,
  mediaFailures,
  complete,
  pending
}
```

`complete` 只表达文档遍历是否完成；Connector 的 inventoryStatus 同时统计 `failures`、`pending` 和 `mediaFailures`，避免一个媒体失败触发文档全量重抓。

- [x] **Step 7: 增加 preview fallback 和媒体失败测试**

fake CLI 对一个 token 让 `+media-download` 失败、`+media-preview` 成功；对另一个 token 两者都失败。断言成功项 `downloadMethod === "preview"`，失败项只出现在 `mediaFailures`，文档正文仍成功导出。

- [x] **Step 8: 运行聚焦测试**

Run: `node --test tests/larkCorpus.test.mjs`

Expected: PASS。

- [x] **Step 9: 提交导出器功能**

```bash
git add scripts/fetch-lark-corpus.mjs tests/larkCorpus.test.mjs
git commit -m "feat: export Lark media assets

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 2: 把媒体作为 attachment evidence 摄入 Vault

**Files:**
- Modify: `tests/larkExportConnector.test.ts`
- Modify: `src/ingestion/types.ts`
- Modify: `src/ingestion/core.ts`
- Modify: `src/ingestion/larkExport.ts`

- [x] **Step 1: 把测试 export fixture 升级到 manifest v2**

fixture 增加：

```ts
media: {},
mediaFailures: {}
```

并把 `version` 改为 `2`，先保持原文档测试行为不变。

- [x] **Step 2: 写 document + attachment 摄入失败测试**

创建图片 bytes，计算 hash，在 export 中增加媒体记录和：

```xml
<img src="img-private-token"
     href="https://internal-api-drive-stream.example/temp"
     name="diagram.png"
     alt="部署拓扑"
     mime="image/png"/>
```

断言：

```ts
expect(result.discovered).toBe(2);
expect(attachmentManifest.artifact_kind).toBe("attachment");
expect(attachmentManifest.content_type).toBe("image/png");
expect(attachmentEvidence.bytes).toEqual(imageBytes);
expect(documentEvidence).toContain(
  `<asset-ref source-id="${attachmentManifest.source_id}"`
);
expect(documentEvidence).not.toContain("img-private-token");
expect(documentEvidence).not.toContain("internal-api-drive-stream");
```

- [x] **Step 3: 运行测试确认现有单文本契约失败**

Run: `pnpm vitest run tests/larkExportConnector.test.ts`

Expected: FAIL，Connector 只发现一个 document，core 拒绝二进制 bytes。

- [x] **Step 4: 扩展 normalize 契约**

把 `NormalizedArtifact` 改为判别联合：

```ts
export type NormalizedArtifact =
  | {
      encoding: "utf8";
      bytes: Buffer;
      textForManifest: string;
      contentType: string;
    }
  | {
      encoding: "binary-vault-only";
      bytes: Buffer;
      textForManifest: string;
      contentType: string;
    };
```

所有现有文本 Connector 显式返回 `encoding: "utf8"`。

- [x] **Step 5: 让 ingestion core 安全处理二进制**

文本继续要求 `bytes === utf8(textForManifest)` 并执行通用 redaction。二进制则：

- 原始 `bytes` 只写加密 Vault；
- `textForManifest` 必须是不含 token/路径的 Connector 安全描述；
- source manifest 的 section 来自安全描述；
- `content_bytes` 和 version `content_hash` 基于二进制；
- `redaction_policy` 记录 `connector-specific`，表示没有宣称对像素/附件正文完成文本 DLP；
- 不允许 binary artifact 不是 `attachment`。

为 `buildSourceManifest()` 增加可选 `contentHash`，保证 source version 指向真实附件 bytes 而不是描述文本。

- [x] **Step 6: 实现 Lark v2 snapshot 和 attachment descriptor**

`LarkExportConnector`：

- processing profile 升为 `lark-export-xml-media-v2`；
- 校验 media 路径 realpath 仍在 export root；
- 校验 bytes、大小和 SHA-256 与 manifest 一致；
- attachment `externalKey` 使用 `<document-key>#media:<reference-id>`，绝不使用飞书 token；
- attachment source ID 仍由 connector ID + external key 决定；
- 先为每个媒体记录计算 source ID，再规范化 document XML；
- `<img>`、`<source>`、`<whiteboard>` 按 occurrence 替换成只含 `source-id/kind/name/alt/mime` 的 `<asset-ref/>`；
- 删除所有临时 href、原始 token、用户 cite 和 block handle。

- [x] **Step 7: 增加 hash 撕裂和媒体失败 inventory 测试**

修改媒体 bytes 后不更新 manifest，断言该 attachment job 失败且 document 仍可摄入。设置 `mediaFailures` 后断言 inventory `complete=false`、`unresolved` 增加且不执行删除对账。

- [x] **Step 8: 运行聚焦测试和类型检查**

Run:

```bash
pnpm vitest run tests/larkExportConnector.test.ts tests/ingestionCore.test.ts
pnpm typecheck
```

Expected: PASS。

- [x] **Step 9: 提交 attachment ingestion**

```bash
git add src/ingestion/types.ts src/ingestion/core.ts src/ingestion/larkExport.ts src/storage/sourceManifest.ts tests/larkExportConnector.test.ts tests/ingestionCore.test.ts
git commit -m "feat: ingest Lark media into evidence vault

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 3: 显式发布 Git 可跟踪的内容寻址资产

**Files:**
- Create: `src/storage/sourceAssets.ts`
- Create: `tests/sourceAssets.test.ts`
- Modify: `src/index.ts`
- Modify: `src/cli.ts`

- [x] **Step 1: 写发布成功和幂等失败测试**

使用现有 Vault helper 创建 attachment source manifest，调用：

```ts
const published = await publishSourceAsset(rootDir, {
  sourceId,
  expectedFingerprint,
  reviewed: true,
  vault: { key, actor: "test" }
});
```

断言：

```ts
expect(published.assetId).toMatch(/^asset_sha256_[a-f0-9]{64}$/);
expect(published.uri).toBe(`asset://${published.assetId}`);
expect(published.relativePath).toMatch(
  /^knowledge\/assets\/objects\/[a-f0-9]{2}\/asset_sha256_/
);
expect(await readFile(path.join(rootDir, published.relativePath))).toEqual(bytes);
expect(second.deduplicated).toBe(true);
```

- [x] **Step 2: 运行测试确认模块不存在**

Run: `pnpm vitest run tests/sourceAssets.test.ts`

Expected: FAIL，`sourceAssets.ts` 尚不存在。

- [x] **Step 3: 实现 asset schema 和发布流程**

资产 ID：

```ts
asset_sha256_<binary-sha256>
```

目录：

```text
knowledge/assets/objects/<hash-prefix>/<asset-id>.<safe-extension>
knowledge/assets/manifests/<asset-id>.json
```

manifest：

```ts
{
  schema_version: 1,
  asset_id,
  source_id,
  source_fingerprint,
  content_hash,
  content_type,
  content_bytes,
  title,
  relative_path,
  published_at
}
```

发布前必须：

- `reviewed === true`；
- source 为 available attachment；
- fingerprint 与调用方记录一致；
- Vault object 存在且解密后的 hash/bytes 与 source manifest 一致；
- 输出路径解析后仍位于 `knowledge/assets/objects`；
- 拒绝 `text/html`、`image/svg+xml`、JavaScript、可执行文件和未知二进制直接发布；
- 同 asset ID/manifest 内容幂等，任何不一致都拒绝覆盖。

- [x] **Step 4: 写 active-content、错误 fingerprint 和缺失确认测试**

断言三种情况在创建任何 Git asset 前失败：

```ts
await expect(publishSourceAsset(root, { reviewed: false, ...input }))
  .rejects.toThrow(/reviewed/);
await expect(publishSourceAsset(root, { expectedFingerprint: "sha256:...", ...input }))
  .rejects.toThrow(/fingerprint/);
await expect(publishHtmlAsset()).rejects.toThrow(/not safe to publish/);
```

- [x] **Step 5: 增加 CLI**

命令：

```text
agent-knowledge source publish-asset <source-id>
  --fingerprint <sha256:...>
  --confirm-reviewed
  [--root <dir>]
```

帮助明确：该命令会把 Vault attachment 的副本写进 Git 事实层；调用者必须先检查媒体授权、PII 和内容安全。JSON 输出包含 `assetId/uri/relativePath/manifestPath/deduplicated`，不输出 bytes。

- [x] **Step 6: 运行聚焦测试、CLI help 和类型检查**

Run:

```bash
pnpm vitest run tests/sourceAssets.test.ts
pnpm typecheck
pnpm build
node dist/cli.js source publish-asset --help
```

Expected: PASS，帮助包含 `--fingerprint`、`--confirm-reviewed` 和安全边界。

- [x] **Step 7: 提交显式发布能力**

```bash
git add src/storage/sourceAssets.ts src/index.ts src/cli.ts tests/sourceAssets.test.ts
git commit -m "feat: publish reviewed knowledge assets

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 4: Markdown 落盘和移动时使用相对资产路径

**Files:**
- Modify: `tests/organizer.test.ts`
- Modify: `src/storage/sourceAssets.ts`
- Modify: `src/memory/inbox.ts`
- Modify: `src/memory/organizer.ts`

- [x] **Step 1: 写 active capture 相对路径失败测试**

先创建合法 asset manifest/object，候选 explanation 使用：

```md
![部署拓扑](asset://asset_sha256_<hash>)

[排障手册](asset://asset_sha256_<other-hash>)
```

写入 `knowledge/procedural/bytedance/business/...md` 后断言：

```ts
expect(markdown).toContain(
  "![部署拓扑](../../../assets/objects/ab/asset_sha256_<hash>.png)"
);
expect(markdown).not.toContain("asset://");
```

- [x] **Step 2: 写 inbox 晋升重定位失败测试**

候选先写 `knowledge/_inbox/...md`，断言路径为 `../assets/...`；随后 `organizeInbox --apply`，断言新 active Markdown 的链接重新计算为 `../../../assets/...`，旧路径没有原样复制。

- [x] **Step 3: 运行测试确认当前代码保留 asset URI**

Run: `pnpm vitest run tests/organizer.test.ts`

Expected: FAIL，Markdown 仍含 `asset://` 或移动后路径错误。

- [x] **Step 4: 实现严格 URI 解析和路径重定位**

在 `sourceAssets.ts` 导出：

```ts
resolveAssetUris(rootDir, markdownRelativePath, markdownBody)
relocateAssetLinks(rootDir, fromMarkdownPath, toMarkdownPath, markdownBody)
```

规则：

- 只接受 `asset://asset_sha256_<64hex>`；
- manifest 和 object 均必须存在且 hash 匹配；
- 生成 POSIX 相对路径并强制以 `./` 或 `../` 开头；
- URL 编码空格、括号等 Markdown 特殊字符；
- 不修改代码块中的示例 URI；
- 相对链接只能指向 `knowledge/assets/objects`；
- 未知 asset、越界 path、manifest/object 撕裂时在任何 KnowledgeDocument 写入前失败。

- [x] **Step 5: 接入所有知识写入路径**

- `writeCandidateMemory()` 在序列化前按 inbox 路径解析 URI；
- `captureMaterial()` active、新 source replacement 和 dedupe 比较都使用目标文件对应的解析结果；
- `organizeInbox()` 在写 active 文件前把旧 Markdown 相对 asset 链接重定位；
- 普通外链和非 asset 相对链接保持不变。

- [x] **Step 6: 增加未知 asset 原子失败测试**

批次中第二条引用未知 asset，断言当前批次没有新增 Markdown。若现有 captureMaterial 不能满足批次原子性，先预解析全部目标和 asset 引用，再开始写文件。

- [x] **Step 7: 运行聚焦测试和类型检查**

Run:

```bash
pnpm vitest run tests/organizer.test.ts tests/inbox.test.ts tests/sourceAssets.test.ts
pnpm typecheck
```

Expected: PASS。

- [x] **Step 8: 提交 Markdown 相对引用**

```bash
git add src/storage/sourceAssets.ts src/memory/inbox.ts src/memory/organizer.ts tests/organizer.test.ts tests/inbox.test.ts tests/sourceAssets.test.ts
git commit -m "feat: write relative knowledge asset links

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 5: 更新 Skill、模板和运维边界

**Files:**
- Modify: `.trae/skills/source-distiller/SKILL.md`
- Modify: `templates/trae/plugin/skills/source-distiller/SKILL.md`
- Modify: `templates/codex/marketplace/plugins/agent-knowledge/skills/source-distiller/SKILL.md`
- Modify: `.trae/skills/agent-knowledge-guide/SKILL.md`
- Modify: `templates/trae/plugin/skills/agent-knowledge-guide/SKILL.md`
- Modify: `templates/codex/marketplace/plugins/agent-knowledge/skills/agent-knowledge-guide/SKILL.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/evidence-vault.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `docs/guides/synchronization.md`
- Modify: `src/storage/workspace.ts`
- Modify: `src/storage/gitWorkspace.ts`

- [x] **Step 1: 更新 source-distiller 媒体流程**

明确要求：

1. 在 document evidence 中识别 `<asset-ref source-id="...">`。
2. 对 attachment 执行 `source show`，记录 fingerprint。
3. 把媒体 export 到 owner-only 临时文件，人工/受控视觉工具检查授权、PII、恶意内容和业务相关性。
4. 只有需要进入长期知识的媒体才执行：

```bash
agent-knowledge source publish-asset "$ASSET_SOURCE_ID" \
  --fingerprint "$ASSET_FINGERPRINT" \
  --confirm-reviewed
```

5. candidate explanation 使用命令返回的 `asset://...`，不能手写飞书 token、临时 URL、绝对路径或猜测相对层级。
6. `capture-material` 落盘后检查 Markdown 已转换成相对路径。
7. 不相关、含未处理 PII 或授权不明的媒体保留 Vault evidence，不发布到 Git。

- [x] **Step 2: 同步教程 Skill 和安装模板**

在 agent-knowledge-guide 增加“飞书图文知识”教程，覆盖 export、ingest、source review、publish、candidate、capture、Git review。将项目 `.trae/skills` 内容同步到 TRAE plugin 与 Codex marketplace 对应模板，逐文件比较避免再次漂移。

- [x] **Step 3: 更新 README/指南/初始化说明**

写清：

- `local_exports/` 是离线抓取缓存，不进入 Git；
- `.vault/` 保存完整文本和媒体 L3 evidence，默认加密且不进入 Git/同步；
- `knowledge/assets/` 只保存显式审阅发布的内容寻址副本，是人类可读 Git 事实层的一部分；
- Markdown 只保存相对链接，不保存飞书 token、临时 URL 或本机绝对路径；
- 图片/附件变化会改变 attachment source fingerprint 和 asset ID，旧 Git asset 不自动删除，防止历史 Markdown 断链；
- 未完成媒体 inventory 会让 Connector 停止 removed reconciliation；
- WebDAV/S3 现阶段仍只同步 KnowledgeDocument Markdown，不同步 `knowledge/assets`，因此远端恢复和跨机器使用必须配合 private Git 或独立备份；不能宣称现有 sync 已覆盖媒体。

- [x] **Step 4: 更新数据 Git 安全模板**

`knowledge/README.md` 增加 `assets/` 说明；`DATA_SECURITY` 增加“发布媒体会进入 Git history，必须先确认权限和 PII”。不要把 `knowledge/assets` 加入 `.gitignore`。

- [x] **Step 5: 流程联动审视**

检查但仅在确有变化时修改：

- `docs/guides/configuration.md`
- `docs/guides/retrieval.md`
- `docs/guides/integrations.md`
- `templates/trae/agents/*.md`
- `templates/claude-code/agents/*.md`
- `templates/trae/plugin/agents/*.md`
- `.trae/skills/knowledge-organizer/SKILL.md` 及模板副本
- integration merge/uninstall 测试

媒体不改变 Hook、检索、Agent 工具权限或 integration ownership 时，保持对应文件不动，并在提交说明记录“已检查、无需变化”。

- [x] **Step 6: 运行模板一致性和帮助测试**

Run:

```bash
diff -u .trae/skills/source-distiller/SKILL.md templates/trae/plugin/skills/source-distiller/SKILL.md
diff -u .trae/skills/source-distiller/SKILL.md templates/codex/marketplace/plugins/agent-knowledge/skills/source-distiller/SKILL.md
diff -u .trae/skills/agent-knowledge-guide/SKILL.md templates/trae/plugin/skills/agent-knowledge-guide/SKILL.md
diff -u .trae/skills/agent-knowledge-guide/SKILL.md templates/codex/marketplace/plugins/agent-knowledge/skills/agent-knowledge-guide/SKILL.md
pnpm vitest run tests/integration.test.ts tests/cliHelp.test.ts
```

Expected: diff 无输出，测试 PASS。

- [x] **Step 7: 提交文档和 Skill**

```bash
git add .trae/skills templates README.md AGENTS.md docs/guides src/storage/workspace.ts src/storage/gitWorkspace.ts
git commit -m "docs: document Lark media knowledge workflow

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 6: 完整验证和实施证据

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-lark-media-assets-and-relative-markdown.md`
- Modify: `docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md` only if its four-stage evidence checklist has a directly applicable ingestion item

- [x] **Step 1: 运行完整静态和测试验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
```

Expected: 全部 PASS。

- [x] **Step 2: 运行端到端本地 smoke**

使用 fake Lark export 或现有 `local_exports/lark-probe` 的副本：

```bash
node scripts/fetch-lark-corpus.mjs --root-url root --output "$TEMP_EXPORT"
node dist/cli.js ingest lark-export --connector-id lark-media-smoke --export-dir "$TEMP_EXPORT" --root "$TEMP_KB"
node dist/cli.js source list --root "$TEMP_KB" --needs-review
node dist/cli.js source publish-asset "$ATTACHMENT_SOURCE_ID" \
  --root "$TEMP_KB" \
  --fingerprint "$ATTACHMENT_FINGERPRINT" \
  --confirm-reviewed
node dist/cli.js capture-material \
  --root "$TEMP_KB" \
  --input "$CANDIDATE_JSON" \
  --target inbox
```

检查：

- export manifest 不含临时 URL；
- source manifest 不含飞书 token；
- attachment bytes 只自动存在于 `.vault`；
- publish 后 `knowledge/assets` 中对象 hash 正确；
- Markdown 链接是相对路径并可从文件位置解析到对象；
- `git status` 能看到 asset object、asset manifest 和 Knowledge Markdown；
- `sync run` 的预览/测试仍只包含 Markdown，并明确不包含 asset。

- [x] **Step 3: 勾选本计划完成项并记录验证结果**

把本计划中已完成 checkbox 改为 `[x]`，在文末追加实际执行命令、通过数量和未覆盖的真实在线飞书限制。不得把 fake CLI 结果描述成在线飞书验证。

- [x] **Step 4: 检查工作树和提交边界**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: 没有未提交实现文件；提交按导出、摄入、发布、Markdown、文档边界拆分。

- [x] **Step 5: 提交验证证据**

```bash
git add docs/superpowers/plans/2026-08-11-lark-media-assets-and-relative-markdown.md docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md
git commit -m "docs: record Lark media validation

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

## 失败策略与非目标

- 飞书媒体下载失败不能删除已成功的文档或旧 attachment；失败进入 `mediaFailures` 并阻止完整 inventory 删除对账。
- 任何自动流程都不能把二进制直接发布到 Git；自动 ingestion 的终点是加密 Vault + source manifest。
- `source publish-asset` 不是图片 OCR、附件内容理解、病毒扫描或 DLP 引擎；它要求调用方已经完成显式审阅，并额外拒绝明显 active content。
- 不把飞书 token 当 asset ID；稳定身份只来自下载后二进制 SHA-256。
- 不自动删除不再引用的 `knowledge/assets`。历史 Markdown 和 Git commit 可能仍依赖旧对象，清理必须是未来独立的可达性审计功能。
- 本次不扩展 WebDAV/S3 上传二进制，避免在没有冲突、配额、加密和断点续传设计时误同步私域媒体。
- 本次不实现 Sheet/Base 数据导出；它们继续作为 unsupported resource inventory，后续由专用 Connector 处理。

## 实际验证结果

验证日期：2026-08-11。

完整门禁：

```text
pnpm test            PASS：68 个测试文件，354 个测试
pnpm typecheck       PASS
pnpm build           PASS
pnpm check:comments  PASS：98 个 TypeScript 文件
```

聚焦回归覆盖：

- 飞书媒体标签顺序、图片/附件/画板下载、重复引用、preview fallback 和失败 inventory。
- document + binary attachment 摄入、Vault 原始 bytes、source manifest 二进制 hash、token/临时 URL 清理。
- `source publish-asset` fingerprint 锁、显式审阅门、MIME allowlist、幂等和 Git 内容寻址对象。
- active/inbox Markdown 相对链接、inbox 晋升重定位、代码块示例保留、未知 asset 批次原子失败。
- `knowledge/assets` 从 index、embedding、catalog、graph、list、WebDAV/S3 push/pull 中硬排除。
- TRAE/Codex 的 `knowledge-organizer`、`source-distiller`、`agent-knowledge-guide` 及工作流 reference 与项目 Skill 零差异。

端到端 smoke 使用临时 fake `lark-cli`，实际运行：

```text
fetch-lark-corpus -> ingest lark-export -> source list/show
-> source publish-asset -> capture-material --target inbox
```

结果：

- export manifest 为 v2，识别 1 个媒体且 `mediaFailures=0`。
- document 与 attachment 共 2 个 source 摄入成功。
- export/source manifest 均未泄漏飞书媒体 token 或临时下载 URL。
- 发布对象为 `knowledge/assets/objects/7f/asset_sha256_7f47b756761a46e6d4a4d96f0d8a4448f8449235009d1f3ad1493f5c773c19e8.png`。
- inbox Markdown 链接为可解析的相对路径
  `../assets/objects/7f/asset_sha256_7f47b756761a46e6d4a4d96f0d8a4448f8449235009d1f3ad1493f5c773c19e8.png`。

该 smoke 证明本地命令链和安全契约，不代表真实在线飞书权限、下载限额、Content-Type、
超大附件或不同企业租户行为已经验证。正式上线前仍应对用户自己的飞书 allowlist 运行一次
小批量真实导出，检查 `mediaFailures`、下载方法、MIME 和权限错误；无需重新蒸馏现有验证知识库。
