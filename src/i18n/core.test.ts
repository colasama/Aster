import { describe, expect, it } from "vitest";
import { catalogs, enUS } from "./catalogs";
import {
  createTranslator,
  extractPlaceholders,
  formatMessage,
  matchLocale,
  resolveLocale,
} from "./core";

describe("i18n catalogs", () => {
  it("enforces translation keys and interpolation variables at compile time", () => {
    const translate = createTranslator("en-US");
    const assertInvalidCallsAreRejected = (checkedTranslate: typeof translate) => {
      // @ts-expect-error Missing catalog keys must fail the frontend type gate.
      checkedTranslate("missing.catalog.key");
      // @ts-expect-error Placeholder values are required by the source message.
      checkedTranslate("common.seconds");
      // @ts-expect-error Placeholder names are checked, not accepted as arbitrary records.
      checkedTranslate("common.seconds", { seconds: 5 });
    };
    expect(assertInvalidCallsAreRejected).toBeTypeOf("function");
    expect(translate("common.seconds", { count: 5 })).toBe("5 seconds");
  });

  it("keeps every locale complete and interpolation-compatible", () => {
    const expectedKeys = Object.keys(enUS).sort();
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog).sort()).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect(extractPlaceholders(catalog[key as keyof typeof catalog])).toEqual(
          extractPlaceholders(enUS[key as keyof typeof enUS]),
        );
      }
    }
  });

  it("selects a stored locale before matching browser language", () => {
    expect(resolveLocale("en-US", ["zh-Hans-CN"])).toBe("en-US");
    expect(resolveLocale(null, ["fr-FR", "zh-Hans-CN"])).toBe("zh-CN");
    expect(resolveLocale("invalid", ["en-GB"])).toBe("en-US");
    expect(matchLocale("ZH-hant-HK")).toBe("zh-CN");
  });

  it("interpolates text without treating values as templates", () => {
    expect(formatMessage("Hello {name}", { name: "$&{other}<script>" })).toBe(
      "Hello $&{other}<script>",
    );
    expect(createTranslator("zh-CN")("common.seconds", { count: 12 })).toBe("12 秒");
    expect(() => formatMessage("Hello {name}")).toThrow("Missing i18n variable: name");
    expect(() => formatMessage("Hello", { name: "Aster" })).toThrow("Unused i18n variable: name");
  });
});
