import { translate, type SupportedLocale } from "../i18n/locale.js";
import type { RetrievalModelKind } from "../retrieval/modelCache.js";
import {
  InquirerPrompter,
  promptSelect,
  type InteractivePrompter
} from "./prompts.js";

export type ModelPrompter = InteractivePrompter;

/** 在交互终端中复用统一 Inquirer adapter 选择模型类型。 */
export class TerminalModelPrompter extends InquirerPrompter {}

/** 未传 `--kind` 时，交互选择管理 Embedding 还是 Reranker。 */
export async function promptForRetrievalModelKind(
  prompter: ModelPrompter,
  locale: SupportedLocale
): Promise<RetrievalModelKind> {
  return promptSelect(
    prompter,
    translate(locale, "模型类型", "Model kind"),
    [
      {
        name: "Embedding",
        value: "embedding",
        description: translate(locale, "语义召回模型", "Semantic retrieval model")
      },
      {
        name: "Reranker",
        value: "reranker",
        description: translate(locale, "Cross-encoder 批量重排模型", "Cross-encoder batch reranking model")
      }
    ],
    "embedding"
  );
}
