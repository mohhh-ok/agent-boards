import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
// enterKey.js is CommonJS shared with the windows (<script>)
const enterKey = require("../enterKey.js");

const idle = () => ({ composing: false, endedAt: null as number | null });
const key = (init: Partial<{ key: string; shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number }>) => ({
  key: "Enter",
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  ...init,
});

describe("isPlainEnter", () => {
  test("Enter outside conversion sends", () => {
    expect(enterKey.isPlainEnter(key({}), idle(), 1000)).toBe(true);
  });

  test("Shift+Enter and ⌥Enter do not send (new line)", () => {
    expect(enterKey.isPlainEnter(key({ shiftKey: true }), idle(), 1000)).toBe(false);
    expect(enterKey.isPlainEnter(key({ altKey: true }), idle(), 1000)).toBe(false);
  });

  test("other keys do not send", () => {
    expect(enterKey.isPlainEnter(key({ key: "a", keyCode: 65 }), idle(), 1000)).toBe(false);
  });

  test("Enter during conversion does not send", () => {
    expect(enterKey.isPlainEnter(key({ isComposing: true, keyCode: 229 }), idle(), 1000)).toBe(false);
    expect(enterKey.isPlainEnter(key({}), { composing: true, endedAt: null }, 1000)).toBe(false);
  });

  test("the confirming Enter WebKit fires after compositionend does not send", () => {
    // WebKit: compositionend first, then keydown with isComposing false and keyCode 229
    expect(enterKey.isPlainEnter(key({ keyCode: 229 }), { composing: false, endedAt: 1000 }, 1001)).toBe(false);
    // In case the keyCode is 13: it arrives right after compositionend
    expect(enterKey.isPlainEnter(key({}), { composing: false, endedAt: 1000 }, 1005)).toBe(false);
  });

  test("the next Enter after confirming sends", () => {
    expect(enterKey.isPlainEnter(key({}), { composing: false, endedAt: 1000 }, 1000 + 300)).toBe(true);
  });
});

describe("onPlainEnter on a textarea", () => {
  const windows: Window[] = [];
  afterEach(async () => {
    for (const w of windows.splice(0)) await w.happyDOM.close();
  });

  function setup() {
    const window = new Window({ url: "http://localhost/" });
    windows.push(window);
    const ta = window.document.createElement("textarea");
    window.document.body.append(ta);
    let sent = 0;
    enterKey.onPlainEnter(ta, () => sent++);
    const press = (init: Record<string, unknown>) => {
      const e = new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...init });
      ta.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const composition = (type: string) => ta.dispatchEvent(new window.CompositionEvent(type));
    return { window, press, composition, sent: () => sent };
  }

  test("Enter sends and keeps the new line out; Shift+Enter leaves the new line to the textarea", () => {
    const { press, sent } = setup();
    expect(press({ keyCode: 13 })).toBe(true);
    expect(sent()).toBe(1);
    expect(press({ keyCode: 13, shiftKey: true })).toBe(false);
    expect(sent()).toBe(1);
  });

  test("Enter while composing and the confirming Enter right after compositionend do not send", () => {
    const { press, composition, sent } = setup();
    composition("compositionstart");
    press({ keyCode: 229, isComposing: true });
    expect(sent()).toBe(0);
    composition("compositionend");
    press({ keyCode: 229 });
    press({ keyCode: 13 });
    expect(sent()).toBe(0);
  });

  test("Enter pressed again after confirming sends", async () => {
    const { press, composition, sent } = setup();
    composition("compositionstart");
    composition("compositionend");
    await Bun.sleep(enterKey.AFTER_COMPOSITION_MS + 30);
    press({ keyCode: 13 });
    expect(sent()).toBe(1);
  });
});

describe("the windows use the shared handling", () => {
  for (const page of ["reportboard.html", "textboard.html"]) {
    test(`${page} loads enterKey.js and has no Enter handling of its own`, () => {
      const html = readFileSync(resolve(import.meta.dir, "..", page), "utf8");
      expect(html).toContain('<script src="enterKey.js"></script>');
      expect(html).not.toMatch(/isComposing|keyCode === 229|compositionend/);
    });
  }
});
