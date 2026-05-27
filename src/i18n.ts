/**
 * Lightweight i18n for user-facing runtime strings.
 * Supports English and Chinese initially; extendable to more locales.
 * / 轻量级国际化模块，支持中英文，可扩展至更多语言。
 */

export type Locale = "en" | "zh";

const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  zh: "中文",
};

type MessageMap = Record<string, string>;

const MESSAGES: Record<Locale, MessageMap> = {
  en: {
    // ── ADB errors / ADB 错误 ──
    "adb.not_found":
      "ADB not found in PATH. Install Android SDK Platform Tools:\n" +
      "  https://developer.android.com/tools/releases/platform-tools\n" +
      "Then ensure adb is in your PATH.",
    "device.not_found":
      "No Android device found. Please connect a device or start an emulator.",
    "device.invalid_state":
      'Device "{serial}" is not in "device" state.',
    "device.validate_failed":
      'Failed to validate device "{serial}": {reason}',

    // ── ViewTree errors / 视图树错误 ──
    "viewtree.no_root":
      "No view root found in dump.",

    // ── JDWP errors / JDWP 错误 ──
    "jdwp.handshake_failed":
      "JDWP handshake failed — target may not be a Java process.",

    // ── General / 通用 ──
    "tool.unknown":
      'Unknown tool: {name}',
  },

  zh: {
    "adb.not_found":
      "PATH 中未找到 ADB。请安装 Android SDK Platform Tools：\n" +
      "  https://developer.android.com/tools/releases/platform-tools\n" +
      "然后将 adb 加入 PATH。",
    "device.not_found":
      "未找到 Android 设备，请连接设备或启动模拟器。",
    "device.invalid_state":
      '设备 "{serial}" 状态不是 "device"。',
    "device.validate_failed":
      '验证设备 "{serial}" 失败：{reason}',

    "viewtree.no_root":
      "导出的视图层次结构中未找到根节点。",

    "jdwp.handshake_failed":
      "JDWP 握手失败——目标可能不是 Java 进程。",

    "tool.unknown":
      "未知工具：{name}",
  },
};

/**
 * Detect the preferred locale from environment variables.
 * Checks LC_MESSAGES, LANG, and LANGUAGE (standard POSIX locale env vars).
 * Falls back to English.
 * / 从环境变量检测首选语言。依次检查 LC_MESSAGES、LANG、LANGUAGE，最后回退到英语。
 */
export function detectLocale(): Locale {
  for (const envVar of ["LC_MESSAGES", "LANG", "LANGUAGE"]) {
    const val = process.env[envVar] || "";
    if (val.toLowerCase().includes("zh")) return "zh";
    if (val.toLowerCase().includes("en")) return "en";
  }
  return "en";
}

/**
 * Get a localized message by key, optionally replacing {placeholders}.
 * Throws if the key is missing in the active locale.
 * / 根据 key 获取本地化消息，可选替换 {占位符}。
 */
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const msg = MESSAGES[locale]?.[key];
  if (msg === undefined) {
    // Fallback to English if key missing in target locale
    const fallback = MESSAGES.en[key];
    if (fallback === undefined) {
      return `[missing i18n: ${key}]`;
    }
    if (!vars) return fallback;
    return interpolate(fallback, vars);
  }
  if (!vars) return msg;
  return interpolate(msg, vars);
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
}

/**
 * List available locales with their display names.
 * / 列出可用语言及其显示名称。
 */
export function listLocales(): Array<{ id: Locale; name: string }> {
  return (Object.keys(LOCALE_NAMES) as Locale[]).map((id) => ({
    id,
    name: LOCALE_NAMES[id],
  }));
}
