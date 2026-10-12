import { describe, expect, test } from "bun:test";
// anchor.js は窓(<script>)と共用の CommonJS
const anchor = require("../anchor.js");

function edit(oldText: string, newText: string, caret: number, range: { start: number; end: number }) {
  return anchor.shiftRange(range, anchor.diff(oldText, newText, caret));
}

describe("shiftRange (窓の中での編集)", () => {
  const text = "前置き。ここにコメントする。後書き。";
  const range = { start: 4, end: 14 }; // "ここにコメントする。"

  test("範囲より前に書き足すと、範囲が同じ文字列のままずれる", () => {
    const next = "前置きを足した。ここにコメントする。後書き。";
    const r = edit(text, next, 7, range);
    expect(next.slice(r.start, r.end)).toBe("ここにコメントする。");
  });

  test("範囲より後ろの編集では動かない", () => {
    const next = text + "さらに追記。";
    expect(edit(text, next, next.length, range)).toEqual(range);
  });

  test("範囲の中を書き換えると、書き換えた後の文に付いたまま", () => {
    const next = "前置き。ここに長いコメントをする。後書き。";
    const r = edit(text, next, 10, range);
    expect(next.slice(r.start, r.end)).toBe("ここに長いコメントをする。");
  });

  test("範囲の中身を全部消すと null(場所が分からなくなる)", () => {
    const next = "前置き。後書き。";
    expect(edit(text, next, 4, range)).toBeNull();
  });

  test("同じ文字が並ぶ所でもカーソル位置で挿入位置を決める", () => {
    // "aa" の先頭に a を足した(カーソルは 1)。範囲 [1,2] は 2 文字目の a → [2,3]
    expect(edit("aa", "aaa", 1, { start: 1, end: 2 })).toEqual({ start: 2, end: 3 });
  });

  test("範囲の直前に挿入しても範囲に入らない", () => {
    const next = "前置き。Xここにコメントする。後書き。";
    const r = edit(text, next, 5, range);
    expect(next.slice(r.start, r.end)).toBe("ここにコメントする。");
  });
});

describe("locate (外での書き換え・開き直し)", () => {
  test("引用がそのまま残っていれば見つかる", () => {
    const before = "一行目。\n対象の文です。\n三行目。";
    const a = { ...anchor.context(before, 5, 12), start: 5 };
    const after = "新しい段落を先頭に足しました。\n\n" + before;
    const r = anchor.locate(after, a);
    expect(after.slice(r.start, r.end)).toBe("対象の文です。");
  });

  test("同じ引用が複数あれば、前後の文脈が合うほうを取る", () => {
    const text = "A では はい と言う。B でも はい と言う。";
    const second = text.lastIndexOf("はい");
    const a = { ...anchor.context(text, second, second + 2), start: second };
    const after = "冒頭に一文。" + text;
    const r = anchor.locate(after, a);
    expect(r.start).toBe(after.lastIndexOf("はい"));
  });

  test("引用が書き換えられても前後の文脈が残っていれば、間に付け直す", () => {
    const before = "これは前の文脈としての十分な長さの文。古い言い回しの部分。これは後ろの文脈としての十分な長さの文。";
    const s = before.indexOf("古い");
    const e = before.indexOf("。", s) + 1;
    const a = { ...anchor.context(before, s, e), start: s };
    const after = before.replace("古い言い回しの部分。", "新しく直した言い回し。");
    const r = anchor.locate(after, a);
    expect(after.slice(r.start, r.end)).toBe("新しく直した言い回し。");
  });

  test("引用も文脈も無くなれば null", () => {
    const before = "消える段落です。ここにコメント。消える段落です。";
    const a = { ...anchor.context(before, 8, 15), start: 8 };
    expect(anchor.locate("まったく別の文章になった。", a)).toBeNull();
  });
});

test("lineOf は 1 始まりの行番号", () => {
  expect(anchor.lineOf("a\nb\nc", 0)).toBe(1);
  expect(anchor.lineOf("a\nb\nc", 4)).toBe(3);
});
