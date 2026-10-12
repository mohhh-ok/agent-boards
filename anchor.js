// Functions that keep comments on their passage (a range in the text). Loaded by textboard.html via <script>
// and by test/anchor.test.ts via require.
//
// Positions are kept in two ways:
//   - Edits inside the window: shift each range by the diff (one spot) between the text before and after the edit
//     (shiftRange). Offsets are tracked exactly
//   - Changes outside (the agent rewrote the file, or saved comments are reopened): search again by the quoted text
//     and its surrounding context (locate). If not found, the comment becomes one that "lost its place"
(function () {
  var CONTEXT_CHARS = 32;
  var MAX_CANDIDATES = 2000;

  // The diff between the text before and after an edit: the one spot left after removing the common head and tail.
  // Passing caret (the cursor position after the edit) resolves ambiguity in repeated characters (where "aa" → "aaa" was typed)
  function diff(oldText, newText, caret) {
    var max = Math.min(oldText.length, newText.length);
    var p = 0;
    while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
    var grow = Math.max(0, newText.length - oldText.length);
    if (typeof caret === "number") p = Math.min(p, Math.max(0, caret - grow));
    var s = 0;
    while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) s++;
    if (typeof caret === "number") s = Math.min(s, Math.max(0, newText.length - caret));
    return { start: p, oldEnd: oldText.length - s, newEnd: newText.length - s };
  }

  // Shift the range {start, end} by the diff d. Edits before or after the range just move it; an edit overlapping the
  // range is absorbed into it (rewriting inside a commented passage keeps the comment on the rewritten passage).
  // Returns null when the range collapses (its whole content was deleted)
  function shiftRange(range, d) {
    var delta = d.newEnd - d.oldEnd;
    var start = range.start;
    var end = range.end;
    if (end <= d.start) return { start: start, end: end };
    if (start >= d.oldEnd) return { start: start + delta, end: end + delta };
    var nextStart = start <= d.start ? start : d.start;
    var nextEnd = end >= d.oldEnd ? end + delta : d.newEnd;
    if (nextEnd <= nextStart) return null;
    return { start: nextStart, end: nextEnd };
  }

  // The quote of a range and its surrounding context. Used for saving (sidecar) and for searching again after outside changes
  function context(text, start, end) {
    return {
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: text.slice(end, end + CONTEXT_CHARS),
    };
  }

  function commonSuffixLength(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n++;
    return n;
  }

  function commonPrefixLength(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charCodeAt(n) === b.charCodeAt(n)) n++;
    return n;
  }

  function indicesOf(text, needle) {
    var found = [];
    if (needle.length === 0) return found;
    var i = text.indexOf(needle);
    while (i !== -1 && found.length < MAX_CANDIDATES) {
      found.push(i);
      i = text.indexOf(needle, i + 1);
    }
    return found;
  }

  // Compare candidates by how much context matches; on a tie, prefer the one closer to the original position (hint)
  function score(text, start, end, anchor) {
    var before = text.slice(Math.max(0, start - CONTEXT_CHARS), start);
    var after = text.slice(end, end + CONTEXT_CHARS);
    var hint = typeof anchor.start === "number" ? anchor.start : start;
    return commonSuffixLength(before, anchor.prefix || "") + commonPrefixLength(after, anchor.suffix || "") - Math.abs(start - hint) / 1e6;
  }

  // Find anchor = {quote, prefix, suffix, start?} in text. Returns {start, end}, or null if not found.
  //   1. If the quote is still there, the occurrence whose surrounding context matches best
  //   2. If the quote was rewritten, the span between the preceding and following context, if both are still intact
  //      (up to 3 × the quote length + 80 characters)
  function locate(text, anchor) {
    var quote = anchor.quote || "";
    if (quote.length === 0) return null;

    var best = null;
    var bestScore = -Infinity;
    indicesOf(text, quote).forEach(function (i) {
      var sc = score(text, i, i + quote.length, anchor);
      if (sc > bestScore) {
        bestScore = sc;
        best = { start: i, end: i + quote.length };
      }
    });
    if (best) return best;

    var prefix = anchor.prefix || "";
    var suffix = anchor.suffix || "";
    // Short context easily appears elsewhere in the text, so it is not used as a clue
    if (prefix.length < 8 || suffix.length < 8) return null;
    var maxGap = quote.length * 3 + 80;
    var hint = typeof anchor.start === "number" ? anchor.start : 0;
    var bestDistance = Infinity;
    indicesOf(text, prefix).forEach(function (p) {
      var from = p + prefix.length;
      var s = text.indexOf(suffix, from);
      if (s === -1 || s === from || s - from > maxGap) return;
      var distance = Math.abs(from - hint);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { start: from, end: s };
      }
    });
    return best;
  }

  // The line number of offset (1-based)
  function lineOf(text, offset) {
    var line = 1;
    for (var i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  }

  var api = { diff: diff, shiftRange: shiftRange, context: context, locate: locate, lineOf: lineOf, CONTEXT_CHARS: CONTEXT_CHARS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.TextboardAnchor = api;
})();
