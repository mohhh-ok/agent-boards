import { describe, expect, test } from "bun:test";
// anchor.js is CommonJS shared with the window (<script>)
const anchor = require("../anchor.js");

function edit(oldText: string, newText: string, caret: number, range: { start: number; end: number }) {
  return anchor.shiftRange(range, anchor.diff(oldText, newText, caret));
}

describe("shiftRange (edits inside the window)", () => {
  const text = "Intro. Comment on this sentence. Outro.";
  const quoted = "Comment on this sentence.";
  const range = { start: text.indexOf(quoted), end: text.indexOf(quoted) + quoted.length };

  test("typing before the range moves it and keeps the same passage", () => {
    const next = "Intro, now longer. Comment on this sentence. Outro.";
    const r = edit(text, next, "Intro, now longer".length, range);
    expect(next.slice(r.start, r.end)).toBe(quoted);
  });

  test("edits after the range do not move it", () => {
    const next = text + " More text.";
    expect(edit(text, next, next.length, range)).toEqual(range);
  });

  test("rewriting inside the range keeps the comment on the rewritten passage", () => {
    const next = "Intro. Comment on this longer sentence. Outro.";
    const r = edit(text, next, "Intro. Comment on this longer".length, range);
    expect(next.slice(r.start, r.end)).toBe("Comment on this longer sentence.");
  });

  test("deleting the whole range returns null (the comment loses its place)", () => {
    const next = "Intro. Outro.";
    expect(edit(text, next, range.start, range)).toBeNull();
  });

  test("the caret decides where text was inserted among repeated characters", () => {
    // An a was added at the start of "aa" (caret at 1). The range [1,2] is the second a → [2,3]
    expect(edit("aa", "aaa", 1, { start: 1, end: 2 })).toEqual({ start: 2, end: 3 });
  });

  test("inserting right before the range does not extend it", () => {
    const next = "Intro. XComment on this sentence. Outro.";
    const r = edit(text, next, range.start + 1, range);
    expect(next.slice(r.start, r.end)).toBe(quoted);
  });
});

describe("locate (outside changes and reopening)", () => {
  test("finds the quote when it is still there", () => {
    const before = "First line.\nThe target sentence.\nThird line.";
    const s = before.indexOf("The target sentence.");
    const a = { ...anchor.context(before, s, s + "The target sentence.".length), start: s };
    const after = "A new paragraph was added at the top.\n\n" + before;
    const r = anchor.locate(after, a);
    expect(after.slice(r.start, r.end)).toBe("The target sentence.");
  });

  test("with the same quote in several places, takes the one whose context matches", () => {
    const text = "A says yes here. B also says yes there.";
    const second = text.lastIndexOf("yes");
    const a = { ...anchor.context(text, second, second + 3), start: second };
    const after = "One sentence at the start. " + text;
    const r = anchor.locate(after, a);
    expect(r.start).toBe(after.lastIndexOf("yes"));
  });

  test("when the quote was rewritten but its context remains, reattaches between them", () => {
    const before = "This sentence is long enough to act as context. The old wording here. This one is long enough to follow as context.";
    const s = before.indexOf("The old");
    const e = before.indexOf(".", s) + 1;
    const a = { ...anchor.context(before, s, e), start: s };
    const after = before.replace("The old wording here.", "The newly revised wording.");
    const r = anchor.locate(after, a);
    expect(after.slice(r.start, r.end)).toBe("The newly revised wording.");
  });

  test("returns null when both the quote and its context are gone", () => {
    const before = "A paragraph that goes. Comment here. A paragraph that goes.";
    const s = before.indexOf("Comment here.");
    const a = { ...anchor.context(before, s, s + "Comment here.".length), start: s };
    expect(anchor.locate("An entirely different text now.", a)).toBeNull();
  });
});

test("lineOf is 1-based", () => {
  expect(anchor.lineOf("a\nb\nc", 0)).toBe(1);
  expect(anchor.lineOf("a\nb\nc", 4)).toBe(3);
});
