// Display language shared by every command.
// Chosen as: --lang > <COMMAND>_LANG > the macOS language setting. Anything but ja is en.
// $LANG is not used (agents and terminals often set en_US.UTF-8 even when macOS is in Japanese).
import { spawnSync } from "node:child_process";

export type Lang = "ja" | "en";

export type I18n<T> = {
  readonly lang: Lang;
  readonly M: T;
  setLang(next: Lang): void;
};

export function createI18n<T>(table: Record<Lang, T>): I18n<T> {
  let lang: Lang = "en";
  let M = table[lang];
  return {
    get lang() {
      return lang;
    },
    get M() {
      return M;
    },
    setLang(next: Lang) {
      lang = next;
      M = table[next];
    },
  };
}

export function parseLang(value: string | undefined, source: string, onBad: (source: string, value: string) => never): Lang {
  if (value === "ja" || value === "en") return value;
  return onBad(source, value ?? "");
}

// `defaults read -g AppleLanguages` prints `(\n    "ja-JP",\n    en\n)`. The first one is the preferred language
export function systemLang(): Lang {
  const result = spawnSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8" });
  return langFromAppleLanguages(result.status === 0 ? result.stdout : "");
}

export function langFromAppleLanguages(output: string): Lang {
  const first = /\(\s*"?([^",\s)]+)/.exec(output)?.[1];
  return first?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

// Sets the language from the system, then --lang (first argument) or the environment variable, and returns the
// remaining arguments. With --lang the environment variable is not read, so a bad value left there can be overridden.
// Errors about a bad value are shown in the system language
export function applyLang<T>(params: {
  argv: string[];
  envName: string;
  i18n: I18n<T>;
  onBad: (source: string, value: string) => never;
  detect?: () => Lang;
}): string[] {
  params.i18n.setLang((params.detect ?? systemLang)());
  if (params.argv[0] === "--lang") {
    params.i18n.setLang(parseLang(params.argv[1], "--lang", params.onBad));
    return params.argv.slice(2);
  }
  const envLang = process.env[params.envName];
  if (envLang !== undefined && envLang !== "") params.i18n.setLang(parseLang(envLang, params.envName, params.onBad));
  return params.argv;
}
