/**
 * Locale 解析刻意保持小而确定。
 *
 * 首发只提供 zh-CN 和 en；不支持的系统 locale 回退中文，保证默认产品体验为中文，同时让
 * 显式配置的英文行为可预测。
 */
export type SupportedLocale = "zh-CN" | "en";
export type LocalePreference = "auto" | SupportedLocale;

/** 规范化宿主 locale；当前未支持的语言统一回退中文。 */
export function normalizeLocale(input: string | undefined): SupportedLocale {
  const normalized = input?.trim().toLowerCase().replace("_", "-") ?? "";
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  return "zh-CN";
}

/** 按 LC_ALL、LC_MESSAGES、LANG、系统 locale 的顺序检测界面语言。 */
export function detectLocale(
  environment: NodeJS.ProcessEnv = process.env,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale
): SupportedLocale {
  const candidate =
    environment.LC_ALL ||
    environment.LC_MESSAGES ||
    environment.LANG ||
    systemLocale;
  return normalizeLocale(candidate);
}

/** 合并显式参数、用户配置和系统检测，显式选择始终优先。 */
export function resolveLocale(options: {
  explicit?: string;
  configured?: LocalePreference;
  environment?: NodeJS.ProcessEnv;
  systemLocale?: string;
}): SupportedLocale {
  if (options.explicit && options.explicit !== "auto") {
    return normalizeLocale(options.explicit);
  }
  if (options.configured && options.configured !== "auto") {
    return options.configured;
  }
  return detectLocale(options.environment ?? process.env, options.systemLocale);
}

/** 在中文默认文案和英文文案之间选择；机器字段不应调用本函数翻译。 */
export function translate(locale: SupportedLocale, chinese: string, english: string): string {
  return locale === "en" ? english : chinese;
}
