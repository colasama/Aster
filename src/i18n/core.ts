import { catalogs, type MessageCatalog, type MessageKey } from "./catalogs";

export const SUPPORTED_LOCALES = ["en-US", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en-US";
export const LOCALE_STORAGE_KEY = "aster.locale";

type Placeholder<Value extends string> = Value extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholder<Rest>
  : never;
export type PlainMessageKey = {
  [Key in MessageKey]: [Placeholder<MessageCatalog[Key]>] extends [never] ? Key : never;
}[MessageKey];
type InterpolationValue = string | number;
type TranslationArguments<Key extends MessageKey> = [Placeholder<MessageCatalog[Key]>] extends [
  never,
]
  ? []
  : [values: Record<Placeholder<MessageCatalog[Key]>, InterpolationValue>];

export type Translate = <Key extends MessageKey>(
  key: Key,
  ...values: TranslationArguments<Key>
) => string;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as Locale);
}

export function matchLocale(language: string | undefined): Locale | undefined {
  if (!language) return undefined;
  const normalized = language.trim().toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return undefined;
}

export function resolveLocale(
  storedLocale: string | null | undefined,
  browserLanguages: readonly string[] = [],
): Locale {
  if (isLocale(storedLocale)) return storedLocale;
  for (const language of browserLanguages) {
    const locale = matchLocale(language);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function formatMessage(
  template: string,
  values: Readonly<Record<string, InterpolationValue>> = {},
): string {
  const used = new Set<string>();
  const result = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (Object.getOwnPropertyDescriptor(values, name) === undefined) {
      throw new Error(`Missing i18n variable: ${name}`);
    }
    used.add(name);
    return String(values[name]);
  });
  for (const name of Object.keys(values)) {
    if (!used.has(name)) throw new Error(`Unused i18n variable: ${name}`);
  }
  return result;
}

export function createTranslator(locale: Locale): Translate {
  const catalog = catalogs[locale] as Readonly<Record<MessageKey, string>>;
  return ((key: MessageKey, values?: Readonly<Record<string, InterpolationValue>>) =>
    formatMessage(catalog[key], values)) as Translate;
}

export function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
}
