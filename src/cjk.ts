/**
 * SQLite FTS5 默认 tokenizer 不会把连续中文自然语言稳定拆成可召回词项。
 *
 * 这里使用确定性的 2/3-gram 辅助列，不依赖系统分词扩展，保证离线和跨平台行为一致。
 * n-gram 只用于候选召回，最终排序仍结合 metadata、dense score 和治理字段。
 */
export function cjkNgrams(input: string, maxTerms = 96): string[] {
  const terms = new Set<string>();
  const runs = input.match(/\p{Script=Han}+/gu) ?? [];

  for (const run of runs) {
    for (const size of [2, 3]) {
      for (let index = 0; index <= run.length - size; index += 1) {
        terms.add(run.slice(index, index + size));
        if (terms.size >= maxTerms) {
          return [...terms];
        }
      }
    }
  }

  return [...terms];
}
