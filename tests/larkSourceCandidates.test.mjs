import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditLarkSourceContent,
  buildLarkSourceCandidates,
  buildLarkSourceManifest,
  redactSecretLikeContent,
  sanitizeLarkSourceXml
} from "../scripts/build-lark-source-candidates.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildSourceManifest } from "../src/storage/sourceManifest.ts";

const execFileAsync = promisify(execFile);

test("removes temporary Lark resource handles while preserving readable evidence", () => {
  const input = `<p id="block1">正文</p>
<img id="img1" src="imageToken" token="fileToken" href="https://internal-api-drive-stream.feishu.cn/path?code=temporary" alt="关键截图"/>
<cite doc-id="doc123" file-type="docx" title="关联文档"></cite>
<synced_reference src-token="sync123" src-block-id="block2"></synced_reference>`;

  const output = sanitizeLarkSourceXml(input);

  assert.doesNotMatch(output, /temporary|imageToken|fileToken|block1|block2/);
  assert.match(output, /正文/);
  assert.match(output, /关键截图/);
  assert.match(output, /doc-ref="doc123"/);
  assert.match(output, /doc-ref="sync123"/);
});

test("redacts credential values while preserving surrounding source context", () => {
  const input = `
    token=abcdefghijklmnopqrstuvwxyz123456
    api_key="abcdefghijklmnopqrstuvwxyz123456"
    Authorization example: sk-abcdefghijklmnopqrstuvwxyz
    -----BEGIN PRIVATE KEY-----
    private-key-material
    -----END PRIVATE KEY-----
  `;

  const output = redactSecretLikeContent(input);

  assert.match(output, /token=\[REDACTED_SECRET\]/);
  assert.match(output, /api_key="\[REDACTED_SECRET\]/);
  assert.match(output, /Authorization example: \[REDACTED_SECRET\]/);
  assert.match(output, /\[REDACTED_PRIVATE_KEY\]/);
  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz|private-key-material/);
});

test("redacts credential tables, account rows, and user identities from source XML", () => {
  const input = `
    <h1>测试账号</h1>
    <table>
      <tr><th><p>账号+验证码</p></th><th><p>可看场景</p></th></tr>
      <tr><td><p>12345678901 4811</p></td><td><p>有电商账号</p></td></tr>
      <tr><td><p>12345678902/Ceshi123!</p></td><td><p>旧版场景</p></td></tr>
    </table>
    <p>普通操作步骤应继续保留。</p>
    <p>测试手机号：12345678903，验证码：123456</p>
    <p>负责人：<cite type="user" user-id="ou_private" user-name="张三"></cite></p>
  `;

  const output = redactSecretLikeContent(input);

  assert.match(output, /\[REDACTED_CREDENTIAL_TABLE\]/);
  assert.match(output, /\[REDACTED_CREDENTIAL_ROW\]/);
  assert.match(output, /\[REDACTED_PERSON\]/);
  assert.match(output, /普通操作步骤应继续保留/);
  assert.doesNotMatch(
    output,
    /12345678901|12345678902|12345678903|4811|123456|Ceshi123|ou_private|张三/
  );
});

test("keeps conceptual account guidance while auditing actual private values", () => {
  const safeConcepts = `
    <p>测试账号需要按流程申请。</p>
    <p>密码重置页面支持发送验证码。</p>
    <code>const token = sign(payload)</code>
  `;
  const unsafeValues = `
    <p>手机号：12345678901</p>
    <p>password=actual-password</p>
    <cite type="user" user-id="ou_private" user-name="张三"></cite>
  `;

  assert.deepEqual(auditLarkSourceContent(safeConcepts), []);
  assert.deepEqual(auditLarkSourceContent(unsafeValues), [
    "lark_user_identity",
    "secret_assignment",
    "phone_number"
  ]);
});

test("keeps the standalone Lark manifest builder aligned with the runtime contract", () => {
  const input = {
    sourceId: "src_lark_contract",
    externalKey: "wiki:contract",
    title: "Contract",
    content: "<h1>登录态</h1><h2>账号组</h2><p>正文。</p>",
    observedAt: "2026-08-09T00:00:00.000Z",
    revision: 17,
    updatedAt: "2026-08-08T12:00:00.000Z",
    projectKeys: []
  };
  const scriptManifest = buildLarkSourceManifest(input);
  const runtimeManifest = buildSourceManifest({
    sourceId: input.sourceId,
    connector: "lark",
    externalKey: input.externalKey,
    title: input.title,
    content: input.content,
    observedAt: input.observedAt,
    upstreamVersion: {
      revision: String(input.revision),
      updated_at: input.updatedAt
    },
    projectKeys: input.projectKeys,
    contentType: "application/xml",
    redactionPolicy: "connector-specific",
    processingProfile: "lark-source-candidates-v1"
  });

  assert.deepEqual(scriptManifest, runtimeManifest);
});

test("writes versioned source manifests and project keys for Lark batches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lark-source-version-"));
  const corpus = path.join(root, "corpus");
  const output = path.join(root, "output");
  const directory = "doc-one";
  await mkdir(path.join(corpus, directory), { recursive: true });
  await writeFile(
    path.join(corpus, directory, "content.xml"),
    "<h1>版本</h1><p>完整正文。</p>",
    "utf8"
  );
  await writeFile(
    path.join(corpus, "manifest.json"),
    `${JSON.stringify({
      generatedAt: "2026-08-09T00:00:00.000Z",
      documents: {
        "wiki:one": {
          key: "wiki:one",
          title: "版本文档",
          directory,
          objType: "docx",
          revisionId: 42,
          upstreamUpdatedAt: "2026-08-08T12:00:00.000Z",
          observedAt: "2026-08-09T00:00:00.000Z",
          contentHash: "upstream-content-hash"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    const result = await buildLarkSourceCandidates({
      input: path.join(corpus, "manifest.json"),
      output,
      batchSize: 20,
      projectKey: "github.com/example/knowledge"
    });
    const batch = JSON.parse(await readFile(result.batchPaths[0], "utf8"));
    const mapping = JSON.parse(
      await readFile(path.join(output, "mapping.json"), "utf8")
    );
    const sourceManifest = JSON.parse(
      await readFile(
        path.join(output, mapping[0].sourceManifest),
        "utf8"
      )
    );

    assert.deepEqual(batch[0].project_keys, [
      "github.com/example/knowledge"
    ]);
    assert.equal(sourceManifest.version.upstream.revision, "42");
    assert.equal(
      sourceManifest.version.upstream.updated_at,
      "2026-08-08T12:00:00.000Z"
    );
    assert.match(sourceManifest.version.content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(mapping[0].sourceVersion.fingerprint, sourceManifest.version.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disables the legacy direct CLI that wrote complete Lark XML into Markdown candidates", async () => {
  await assert.rejects(
    execFileAsync(
      "node",
      [
        path.resolve("scripts/build-lark-source-candidates.mjs"),
        "--input",
        "/tmp/legacy-lark-manifest.json"
      ],
      { cwd: process.cwd() }
    ),
    /use agent-knowledge ingest lark-export/
  );
});
