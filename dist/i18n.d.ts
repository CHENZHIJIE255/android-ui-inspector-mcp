/**
 * Lightweight i18n for user-facing runtime strings.
 * Supports English and Chinese initially; extendable to more locales.
 * / 轻量级国际化模块，支持中英文，可扩展至更多语言。
 */
export type Locale = "en" | "zh";
/**
 * Detect the preferred locale from environment variables.
 * Checks LC_MESSAGES, LANG, and LANGUAGE (standard POSIX locale env vars).
 * Falls back to English.
 * / 从环境变量检测首选语言。依次检查 LC_MESSAGES、LANG、LANGUAGE，最后回退到英语。
 */
export declare function detectLocale(): Locale;
/**
 * Get a localized message by key, optionally replacing {placeholders}.
 * Throws if the key is missing in the active locale.
 * / 根据 key 获取本地化消息，可选替换 {占位符}。
 */
export declare function t(locale: Locale, key: string, vars?: Record<string, string | number>): string;
/**
 * List available locales with their display names.
 * / 列出可用语言及其显示名称。
 */
export declare function listLocales(): Array<{
    id: Locale;
    name: string;
}>;
