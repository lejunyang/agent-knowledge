import { translate, type SupportedLocale } from "../i18n/locale.js";
import type { RetrievalModelKind } from "../retrieval/modelCache.js";
import {
  InquirerPrompter,
  promptSelect,
  type InteractivePrompter
} from "./prompts.js";

export type ModelPrompter = InteractivePrompter;
export class TerminalModelPrompter extends InquirerPrompter {}

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
