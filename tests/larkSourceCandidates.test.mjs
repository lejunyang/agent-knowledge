import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeLarkSourceXml } from "../scripts/build-lark-source-candidates.mjs";

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
