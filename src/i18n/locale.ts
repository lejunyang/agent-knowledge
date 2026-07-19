/**
 * Locale resolution is intentionally small and deterministic.
 *
 * Only zh-CN and en are shipped initially. Unsupported system locales fall back to Chinese so the
 * default product experience remains Chinese, while explicit/configured English stays predictable.
 */
export type SupportedLocale = "zh-CN" | "en";
export type LocalePreference = "auto" | SupportedLocale;

export function normalizeLocale(input: string | undefined): SupportedLocale {
  const normalized = input?.trim().toLowerCase().replace("_", "-") ?? "";
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  return "zh-CN";
}

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

export function translate(locale: SupportedLocale, chinese: string, english: string): string {
  return locale === "en" ? english : chinese;
}
