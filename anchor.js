// コメントの位置(本文中の範囲)を保つための関数群。textboard.html が <script> で読み、test/anchor.test.ts が require する。
//
// 位置の保ち方は 2 通り:
//   - 窓の中での編集: 編集前後の本文の差分(1 か所)から、各範囲をずらす(shiftRange)。オフセットが正確に追える
//   - 外での書き換え(エージェントがファイルを直した・保存済みのコメントを開き直した): 引用した文字列と前後の
//     文脈で探し直す(locate)。見つからなければ「場所が分からなくなったコメント」にする
(function () {
  var CONTEXT_CHARS = 32;
  var MAX_CANDIDATES = 2000;

  // 編集前後の本文の差分。先頭・末尾の一致を除いた 1 か所を返す。
  // caret(編集後のカーソル位置)を渡すと、同じ文字が並ぶ所での曖昧さ("aa" → "aaa" のどこに入れたか)を解く
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

  // 差分 d に合わせて範囲 {start, end} をずらす。範囲の手前・後ろの編集はそのまま追い、範囲にかかる編集は
  // 範囲に取り込む(コメントした文の中を書き換えたら、書き換えた後の文にコメントが残る)。
  // 範囲が潰れた(中身が全部消えた)ときは null
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

  // 範囲の引用と前後の文脈。保存(sidecar)・外での書き換え後の探し直しに使う
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

  // 文脈の一致の長さで候補を比べ、同点なら元の位置 hint に近いほうを取る
  function score(text, start, end, anchor) {
    var before = text.slice(Math.max(0, start - CONTEXT_CHARS), start);
    var after = text.slice(end, end + CONTEXT_CHARS);
    var hint = typeof anchor.start === "number" ? anchor.start : start;
    return commonSuffixLength(before, anchor.prefix || "") + commonPrefixLength(after, anchor.suffix || "") - Math.abs(start - hint) / 1e6;
  }

  // anchor = {quote, prefix, suffix, start?} を text の中で探す。見つかれば {start, end}、無ければ null。
  //   1. 引用がそのまま残っていれば、その出現のうち前後の文脈がいちばん合うもの
  //   2. 引用が書き換えられていれば、前の文脈と後ろの文脈がそのまま残っている間(引用の 3 倍 + 80 字まで)
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
    // 短い文脈は本文の別の場所にも出やすいので、手がかりとして使わない
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

  // offset が何行目か(1 始まり)
  function lineOf(text, offset) {
    var line = 1;
    for (var i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  }

  var api = { diff: diff, shiftRange: shiftRange, context: context, locate: locate, lineOf: lineOf, CONTEXT_CHARS: CONTEXT_CHARS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.TextboardAnchor = api;
})();
