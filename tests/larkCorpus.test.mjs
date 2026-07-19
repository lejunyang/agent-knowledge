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
      "sheets:sheet123",
      "whiteboard:board123"
    ]
  );
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
