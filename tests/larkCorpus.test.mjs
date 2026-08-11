import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractLarkReferences,
  fetchLarkCorpus
} from "../scripts/fetch-lark-corpus.mjs";

test("extracts and deduplicates embedded Lark document references", () => {
  const content = `
    <cite doc-id="wiki123" file-type="wiki" title="知识库文档" type="doc"></cite>
    <cite doc-id="doc123" file-type="docx" title="普通文档" type="doc"></cite>
    <cite doc-id="doc123" file-type="docx" title="重复文档" type="doc"></cite>
    <synced_reference src-token="synced123" src-block-id="block1"></synced_reference>
    <a href="https://example.feishu.cn/wiki/urlWiki123">链接文档</a>
  `;

  const result = extractLarkReferences(content);

  assert.deepEqual(
    result.documents.map((item) => `${item.fileType}:${item.token}`).sort(),
    [
      "docx:doc123",
      "docx:synced123",
      "wiki:urlWiki123",
      "wiki:wiki123"
    ]
  );
});

test("ignores non-Lark URLs that happen to contain a docs path", () => {
  const result = extractLarkReferences(`
    <a href="https://developer.example.com/docs/resource/guide">外部文档</a>
    <a href="https://example.feishu.cn/docx/doc123">飞书文档</a>
  `);

  assert.deepEqual(
    result.documents.map((item) => `${item.fileType}:${item.token}`),
    ["docx:doc123"]
  );
});

test("separates sheet, bitable, and whiteboard resources from recursive docs", () => {
  const content = `
    <cite doc-id="sheet123" file-type="sheets" title="数据表" type="doc"></cite>
    <sheet token="sheet456" sheet-id="s1"></sheet>
    <bitable token="base123" table-id="t1"></bitable>
    <whiteboard token="board123"></whiteboard>
  `;

  const result = extractLarkReferences(content);

  assert.equal(result.documents.length, 0);
  assert.deepEqual(
    result.resources.map((item) => `${item.fileType}:${item.token}`).sort(),
    [
      "bitable:base123",
      "sheet:sheet456",
      "sheets:sheet123"
    ]
  );
  assert.deepEqual(
    result.media.map((item) => `${item.kind}:${item.token}`),
    ["whiteboard:board123"]
  );
});

test("extracts ordered image, attachment, and whiteboard references without deduplicating occurrences", () => {
  const result = extractLarkReferences(`
    <img src="img-token" name="diagram.png" alt="架构图" mime="image/png" block-id="block-image"/>
    <source token="file-token" name="排障手册.pdf" mime="application/pdf" block-id="block-file"/>
    <whiteboard token="board-token" name="流程画板" block-id="block-board"/>
    <img src="img-token" name="diagram.png" alt="架构图复用" mime="image/png"/>
  `);

  assert.deepEqual(
    result.media.map(({ kind, token, ordinal }) => ({
      kind,
      token,
      ordinal
    })),
    [
      { kind: "image", token: "img-token", ordinal: 0 },
      { kind: "attachment", token: "file-token", ordinal: 1 },
      { kind: "whiteboard", token: "board-token", ordinal: 2 },
      { kind: "image", token: "img-token", ordinal: 3 }
    ]
  );
  assert.equal(result.media[0].alt, "架构图");
  assert.equal(result.media[0].mime, "image/png");
  assert.equal(result.media[0].blockId, "block-image");
  assert.equal(result.media[1].name, "排障手册.pdf");
  assert.equal(result.media[2].name, "流程画板");
});

test("stops cleanly at the per-run limit and rebuilds pending work from the manifest", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "lark-corpus-resume-"));
  const originalPath = process.env.PATH;
  const fixtureBin = path.join(output, "bin");
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(fixtureBin, { recursive: true });
  const fakeCli = path.join(fixtureBin, "lark-cli");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const nodeIndex = args.indexOf("--node-token");
const docIndex = args.indexOf("--doc");
const token = nodeIndex >= 0 ? args[nodeIndex + 1] : args[docIndex + 1];
if (args[0] === "wiki") {
  process.stdout.write(JSON.stringify({ok:true,data:{node_token:token,obj_token:token,obj_type:"docx",title:token}}));
} else {
  const child = token === "root" ? '<cite doc-id="child" file-type="docx" title="child" type="doc"></cite>' : "";
  process.stdout.write(JSON.stringify({ok:true,data:{document:{document_id:token,revision_id:1,content:'<title>'+token+'</title>'+child}}}));
}
`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);
  process.env.PATH = `${fixtureBin}:${originalPath}`;
  try {
    const first = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 1
    });
    assert.equal(first.complete, false);
    assert.equal(first.pending.length, 1);

    const second = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 1
    });
    assert.equal(second.complete, true);
    assert.deepEqual(Object.keys(second.documents).sort(), [
      "docx:child",
      "wiki:root"
    ]);
    const persisted = JSON.parse(
      await readFile(path.join(output, "manifest.json"), "utf8")
    );
    assert.equal(persisted.complete, true);
  } finally {
    process.env.PATH = originalPath;
    await rm(output, { recursive: true, force: true });
  }
});

test("refreshes existing documents with a cheap version probe before fetching content", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "lark-corpus-refresh-"));
  const originalPath = process.env.PATH;
  const fixtureBin = path.join(output, "bin");
  const counterPath = path.join(output, "docs-fetch-count.txt");
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(fixtureBin, { recursive: true });
  const fakeCli = path.join(fixtureBin, "lark-cli");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const nodeIndex = args.indexOf("--node-token");
const docIndex = args.indexOf("--doc");
const token = nodeIndex >= 0 ? args[nodeIndex + 1] : args[docIndex + 1];
if (args[0] === "wiki") {
  process.stdout.write(JSON.stringify({ok:true,data:{node_token:token,obj_token:token,obj_type:"docx",title:token,updated_at:"2026-08-08T12:00:00.000Z"}}));
} else {
  const counter = ${JSON.stringify(counterPath)};
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(count + 1));
  process.stdout.write(JSON.stringify({ok:true,data:{document:{document_id:token,revision_id:17,content:'<h1>Version</h1><p>body</p>'}}}));
}
`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);
  process.env.PATH = `${fixtureBin}:${originalPath}`;
  try {
    const first = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 10,
      refreshExisting: false
    });
    assert.equal(first.documents["wiki:root"].lastRefreshClassification, "new");
    assert.equal(await readFile(counterPath, "utf8"), "1");

    const second = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 10,
      refreshExisting: true
    });
    assert.equal(
      second.documents["wiki:root"].lastRefreshClassification,
      "unchanged"
    );
    assert.equal(await readFile(counterPath, "utf8"), "1");
  } finally {
    process.env.PATH = originalPath;
    await rm(output, { recursive: true, force: true });
  }
});

test("retries transient lark-cli failures with bounded policy", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "lark-corpus-retry-"));
  const originalPath = process.env.PATH;
  const fixtureBin = path.join(output, "bin");
  const counterPath = path.join(output, "attempt-count.txt");
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(fixtureBin, { recursive: true });
  const fakeCli = path.join(fixtureBin, "lark-cli");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env node
const fs = require("fs");
const counter = ${JSON.stringify(counterPath)};
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
if (count === 0) {
  process.stderr.write("temporary failure");
  process.exit(1);
}
const args = process.argv.slice(2);
const nodeIndex = args.indexOf("--node-token");
const docIndex = args.indexOf("--doc");
const token = nodeIndex >= 0 ? args[nodeIndex + 1] : args[docIndex + 1];
if (args[0] === "wiki") {
  process.stdout.write(JSON.stringify({ok:true,data:{node_token:token,obj_token:token,obj_type:"docx",title:token}}));
} else {
  process.stdout.write(JSON.stringify({ok:true,data:{document:{document_id:token,revision_id:1,content:'<h1>Retry</h1><p>ok</p>'}}}));
}
`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);
  process.env.PATH = `${fixtureBin}:${originalPath}`;
  try {
    const result = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 10,
      minIntervalMs: 0,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1
    });

    assert.equal(result.complete, true);
    assert.equal(Object.keys(result.documents).length, 1);
    assert.equal(await readFile(counterPath, "utf8"), "3");
  } finally {
    process.env.PATH = originalPath;
    await rm(output, { recursive: true, force: true });
  }
});

test("downloads images, attachments, and whiteboards into a versioned media inventory", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "lark-corpus-media-"));
  const originalPath = process.env.PATH;
  const fixtureBin = path.join(output, "bin");
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(fixtureBin, { recursive: true });
  const fakeCli = path.join(fixtureBin, "lark-cli");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const nodeIndex = args.indexOf("--node-token");
const docIndex = args.indexOf("--doc");
if (args[0] === "wiki") {
  const token = args[nodeIndex + 1];
  process.stdout.write(JSON.stringify({ok:true,data:{node_token:token,obj_token:token,obj_type:"docx",title:token}}));
} else if (args[0] === "docs" && args[1] === "+fetch") {
  const token = args[docIndex + 1];
  const content = '<h1>图文指南</h1><img src="img-token" name="diagram.png" alt="部署拓扑" mime="image/png"/><source token="file-token" name="guide.pdf" mime="application/pdf"/><whiteboard token="board-token" name="board.png"/>';
  process.stdout.write(JSON.stringify({ok:true,data:{document:{document_id:token,revision_id:1,content}}}));
} else if (args[0] === "docs" && args[1] === "+media-download") {
  const token = args[args.indexOf("--token") + 1];
  const target = args[args.indexOf("--output") + 1];
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, Buffer.from('binary:' + token));
  process.stdout.write(JSON.stringify({ok:true,data:{output:target}}));
} else {
  process.stderr.write("unexpected command: " + args.join(" "));
  process.exit(2);
}
`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);
  process.env.PATH = `${fixtureBin}:${originalPath}`;
  try {
    const result = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 10
    });
    const media = Object.values(result.media);

    assert.equal(result.version, 2);
    assert.equal(media.length, 3);
    assert.equal(Object.keys(result.mediaFailures).length, 0);
    assert.equal(result.documents["wiki:root"].mediaReferences.length, 3);
    for (const item of media) {
      assert.match(item.sha256, /^[a-f0-9]{64}$/);
      assert.ok(item.bytes > 0);
      assert.equal(
        await readFile(path.join(output, item.relativePath), "utf8"),
        `binary:${item.token}`
      );
    }
    assert.equal(
      media.find((item) => item.kind === "image").contentType,
      "image/png"
    );
    assert.equal(
      media.find((item) => item.kind === "attachment").contentType,
      "application/pdf"
    );
    assert.equal(
      media.find((item) => item.kind === "whiteboard").downloadMethod,
      "download"
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(output, { recursive: true, force: true });
  }
});

test("falls back to media preview and records unresolved media without failing the document export", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "lark-corpus-media-fallback-"));
  const originalPath = process.env.PATH;
  const fixtureBin = path.join(output, "bin");
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(fixtureBin, { recursive: true });
  const fakeCli = path.join(fixtureBin, "lark-cli");
  await writeFile(
    fakeCli,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "wiki") {
  const token = args[args.indexOf("--node-token") + 1];
  process.stdout.write(JSON.stringify({ok:true,data:{node_token:token,obj_token:token,obj_type:"docx",title:token}}));
} else if (args[0] === "docs" && args[1] === "+fetch") {
  const token = args[args.indexOf("--doc") + 1];
  const content = '<h1>媒体降级</h1><img src="preview-token" name="preview.png" mime="image/png"/><source token="failed-token" name="failed.pdf" mime="application/pdf"/>';
  process.stdout.write(JSON.stringify({ok:true,data:{document:{document_id:token,revision_id:1,content}}}));
} else if (args[0] === "docs" && args[1] === "+media-download") {
  process.stderr.write("download denied");
  process.exit(1);
} else if (args[0] === "docs" && args[1] === "+media-preview") {
  const token = args[args.indexOf("--token") + 1];
  if (token === "failed-token") {
    process.stderr.write("preview denied");
    process.exit(1);
  }
  const target = args[args.indexOf("--output") + 1];
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, Buffer.from('preview:' + token));
  process.stdout.write(JSON.stringify({ok:true,data:{output:target}}));
} else {
  process.stderr.write("unexpected command: " + args.join(" "));
  process.exit(2);
}
`,
    "utf8"
  );
  await chmod(fakeCli, 0o755);
  process.env.PATH = `${fixtureBin}:${originalPath}`;
  try {
    const result = await fetchLarkCorpus({
      roots: ["root"],
      output,
      identity: "user",
      maxDocuments: 10
    });
    const media = Object.values(result.media);
    const failures = Object.values(result.mediaFailures);

    assert.equal(result.complete, true);
    assert.equal(media.length, 1);
    assert.equal(media[0].downloadMethod, "preview");
    assert.equal(await readFile(path.join(output, media[0].relativePath), "utf8"), "preview:preview-token");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].kind, "attachment");
    assert.equal(failures[0].parent, "wiki:root");
    assert.doesNotMatch(JSON.stringify(failures[0]), /failed-token/);
  } finally {
    process.env.PATH = originalPath;
    await rm(output, { recursive: true, force: true });
  }
});
