/** 测试 helper 为关注其他行为的用例补充满足 V2 门禁的实质正文。 */
import type { CandidateMemoryInput } from "../../src/memory/governance.js";
import {
  captureMaterial as captureMaterialProduction,
  type CaptureMaterialOptions,
  type CaptureMaterialResult
} from "../../src/memory/organizer.js";

/** 生成超过最低正文门槛的结构化解释，同时保留用例原始 synopsis/summary。 */
function substantiveExplanation(input: CandidateMemoryInput): string {
  const statement = input.synopsis ?? input.summary ?? input.title;
  return `# ${input.title}

## 背景

${statement}

这条测试知识用于验证确定性的知识治理、检索、更新或反馈流程。正文刻意保存背景和适用范围，而不是只保留一个无法独立执行的短结论。调用方需要结合 domain、scenario、project key、有效期和来源权限判断是否采用。

## 规则

${statement}

执行时先确认输入实体和当前上下文，再按知识描述完成操作，并记录可以复现的验证结果。若前置条件不满足、来源相互冲突或当前版本已经变化，应停止自动应用并进入人工审阅，不能根据相似词项猜测结论。

## 失败策略

没有证据、验证失败或安全范围不匹配时保持 abstain。知识更新应保留 supersedes/conflicts 关系，避免覆盖历史事实；项目和客户数据必须继续执行隔离过滤。

## 验证

验证结果应能由测试断言、正式文档或受信任务结果支持。`;
}

/** 为非 source 且没有显式 explanation/content 的测试输入补充结构化正文。 */
function normalizeTestCandidate(
  input: CandidateMemoryInput
): CandidateMemoryInput {
  const kind = input.kind ?? input.memory_type;
  if (
    kind === "source" ||
    input.layer === "evidence"
  ) {
    return input;
  }
  const existing = input.explanation ?? input.content;
  if (existing !== undefined && existing.trim().length >= 300) {
    return input;
  }
  return {
    ...input,
    explanation: existing
      ? `${existing.trimEnd()}\n\n${substantiveExplanation(input)}`
      : substantiveExplanation(input),
    content: undefined
  };
}

/** 测试入口复用生产 captureMaterial，仅补齐与测试主题无关的正文质量前置条件。 */
export async function captureMaterial(
  rootDir: string,
  inputs: CandidateMemoryInput[],
  options: CaptureMaterialOptions
): Promise<CaptureMaterialResult> {
  return captureMaterialProduction(
    rootDir,
    inputs.map(normalizeTestCandidate),
    options
  );
}
