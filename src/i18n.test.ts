import { describe, it, expect, afterEach } from "vitest";
import { t, detectLocale, listLocales } from "./i18n.js";

describe("t() — translation lookup", () => {
  it("returns English string for 'en' locale", () => {
    const msg = t("en", "adb.not_found");
    expect(msg).toContain("ADB not found");
  });

  it("returns Chinese string for 'zh' locale", () => {
    const msg = t("zh", "adb.not_found");
    expect(msg).toContain("未找到 ADB");
  });

  it("interpolates single placeholder in English", () => {
    const msg = t("en", "device.invalid_state", { serial: "abc123" });
    expect(msg).toBe('Device "abc123" is not in "device" state.');
  });

  it("interpolates multiple placeholders in English", () => {
    const msg = t("en", "device.validate_failed", { serial: "abc123", reason: "timeout" });
    expect(msg).toBe('Failed to validate device "abc123": timeout');
  });

  it("interpolates placeholders in Chinese", () => {
    const msg = t("zh", "device.invalid_state", { serial: "abc123" });
    expect(msg).toBe('设备 "abc123" 状态不是 "device"。');
  });

  it("interpolates multiple placeholders in Chinese", () => {
    const msg = t("zh", "device.validate_failed", { serial: "abc123", reason: "超时" });
    expect(msg).toBe('验证设备 "abc123" 失败：超时');
  });

  it("returns English fallback when key missing in zh locale", () => {
    const msg = t("zh", "adb.not_found");
    expect(msg).toContain("未找到 ADB");
  });

  it("returns placeholder string when key missing in all locales", () => {
    const msg = t("en", "nonexistent.key" as any);
    expect(msg).toBe("[missing i18n: nonexistent.key]");
  });

  it("returns message without interpolation when no vars supplied", () => {
    const msg = t("en", "device.invalid_state");
    expect(msg).toContain("{serial}");
  });

  it("preserves unmatched placeholders in template", () => {
    const msg = t("en", "device.validate_failed", { serial: "test" });
    expect(msg).toContain("{reason}");
    expect(msg).toContain("test");
  });

  it("all available keys return strings without throwing", () => {
    const keys = [
      "adb.not_found", "device.not_found", "device.invalid_state",
      "device.validate_failed", "viewtree.no_root", "jdwp.handshake_failed", "tool.unknown",
    ];
    for (const key of keys) {
      expect(() => t("en", key)).not.toThrow();
      expect(() => t("zh", key)).not.toThrow();
    }
  });
});

describe("detectLocale", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("returns 'en' by default when no locale env vars are set", () => {
    process.env = { ...OLD_ENV };
    delete process.env.LC_MESSAGES;
    delete process.env.LANG;
    delete process.env.LANGUAGE;
    process.env.LC_MESSAGES = "C";
    process.env.LANG = "C";
    expect(detectLocale()).toBe("en");
  });

  it("detects Chinese from LC_MESSAGES", () => {
    process.env.LC_MESSAGES = "zh_CN.UTF-8";
    expect(detectLocale()).toBe("zh");
  });

  it("detects Chinese from LANG", () => {
    delete process.env.LC_MESSAGES;
    process.env.LANG = "zh_CN.UTF-8";
    expect(detectLocale()).toBe("zh");
  });

  it("detects Chinese from LANGUAGE", () => {
    delete process.env.LC_MESSAGES;
    delete process.env.LANG;
    process.env.LANGUAGE = "zh_CN:zh";
    expect(detectLocale()).toBe("zh");
  });

  it("prefers LC_MESSAGES over LANG", () => {
    process.env.LC_MESSAGES = "en_US.UTF-8";
    process.env.LANG = "zh_CN.UTF-8";
    expect(detectLocale()).toBe("en");
  });

  it("detects English from env var", () => {
    process.env.LC_MESSAGES = "en_US.UTF-8";
    expect(detectLocale()).toBe("en");
  });

  it("handles uppercase ZH in env var", () => {
    process.env.LC_MESSAGES = "ZH_CN.UTF-8";
    expect(detectLocale()).toBe("zh");
  });

  it("handles mixed case in env var", () => {
    process.env.LC_MESSAGES = "Zh_CN.UTF-8";
    expect(detectLocale()).toBe("zh");
  });

  it("returns 'en' when env vars contain neither zh nor en", () => {
    process.env.LC_MESSAGES = "fr_FR.UTF-8";
    process.env.LANG = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("en");
  });

  it("returns 'en' when env vars are empty strings", () => {
    process.env.LC_MESSAGES = "";
    process.env.LANG = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("en");
  });

  it("returns 'en' when env vars contain en", () => {
    process.env.LC_MESSAGES = "en_GB.UTF-8";
    process.env.LANG = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("en");
  });
});

describe("listLocales", () => {
  it("returns all supported locales with display names", () => {
    const locales = listLocales();
    expect(locales).toHaveLength(2);
    expect(locales).toContainEqual({ id: "en", name: "English" });
    expect(locales).toContainEqual({ id: "zh", name: "中文" });
  });
});
