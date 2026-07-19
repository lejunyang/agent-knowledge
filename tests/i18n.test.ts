import { describe, expect, it } from "vitest";
import {
  detectLocale,
  normalizeLocale,
  resolveLocale,
  translate
} from "../src/i18n/locale.js";

describe("locale resolution", () => {
  it("defaults unknown and unsupported system locales to Chinese", () => {
    expect(normalizeLocale("fr-FR")).toBe("zh-CN");
    expect(resolveLocale({ configured: "auto", environment: { LANG: "fr_FR.UTF-8" } })).toBe("zh-CN");
    expect(
      resolveLocale({
        configured: "auto",
        environment: {},
        systemLocale: "fr-FR"
      })
    ).toBe("zh-CN");
  });

  it("detects Chinese and English locale environment variables", () => {
    expect(detectLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
    expect(detectLocale({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(detectLocale({ LC_MESSAGES: "en_GB.UTF-8" })).toBe("en");
  });

  it("prefers explicit locale over configured and system locale", () => {
    expect(
      resolveLocale({
        explicit: "en",
        configured: "zh-CN",
        environment: { LANG: "zh_CN.UTF-8" }
      })
    ).toBe("en");
    expect(
      resolveLocale({
        configured: "en",
        environment: { LANG: "zh_CN.UTF-8" }
      })
    ).toBe("en");
  });

  it("translates bilingual messages without changing machine values", () => {
    expect(translate("zh-CN", "中文说明", "English help")).toBe("中文说明");
    expect(translate("en", "中文说明", "English help")).toBe("English help");
  });
});
