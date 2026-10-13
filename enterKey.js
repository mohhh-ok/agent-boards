// Inputs where Enter sends or confirms. Loaded by textboard.html and reportboard.html via <script> and by
// test/enterKey.test.ts via require.
//
// Enter sends, Shift+Enter (and ⌥Enter) insert a new line. The Enter that confirms IME conversion (Japanese input etc.)
// does not send. WebKit (Safari / WKWebView) fires compositionend before the confirming keydown, so isComposing is
// already false on it. That keydown is caught by keyCode 229, and, in case a WebKit version reports 13 instead, by
// arriving right after compositionend (no one presses Enter again within that time)
(function () {
  var AFTER_COMPOSITION_MS = 50;

  // state: { composing, endedAt } kept per input by onPlainEnter. now: the keydown's time (event.timeStamp)
  function isPlainEnter(e, state, now) {
    if (e.key !== "Enter" || e.shiftKey || e.altKey) return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (state.composing) return false;
    if (state.endedAt !== null && now - state.endedAt < AFTER_COMPOSITION_MS) return false;
    return true;
  }

  function onPlainEnter(el, run) {
    var state = { composing: false, endedAt: null };
    el.addEventListener("compositionstart", function () { state.composing = true; });
    el.addEventListener("compositionend", function (e) {
      state.composing = false;
      state.endedAt = e.timeStamp;
    });
    el.addEventListener("keydown", function (e) {
      if (!isPlainEnter(e, state, e.timeStamp)) return;
      e.preventDefault();
      run();
    });
  }

  var api = { isPlainEnter: isPlainEnter, onPlainEnter: onPlainEnter, AFTER_COMPOSITION_MS: AFTER_COMPOSITION_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.EnterKey = api;
})();
