import { describe, it, expect } from "vitest";

describe("resolveLocale behavior", () => {
  it("detectLocale returns zh when LC_MESSAGES is zh", async () => {
    const i18n = await import("./i18n.js");
    const OLD = process.env.LC_MESSAGES;
    process.env.LC_MESSAGES = "zh_CN.UTF-8";
    process.env.LANG = "";
    process.env.LANGUAGE = "";
    expect(i18n.detectLocale()).toBe("zh");
    process.env.LC_MESSAGES = OLD;
  });

  it("detectLocale returns en when LC_MESSAGES is en", async () => {
    const i18n = await import("./i18n.js");
    const OLD = process.env.LC_MESSAGES;
    process.env.LC_MESSAGES = "en_US.UTF-8";
    process.env.LANG = "";
    process.env.LANGUAGE = "";
    expect(i18n.detectLocale()).toBe("en");
    process.env.LC_MESSAGES = OLD;
  });
});
