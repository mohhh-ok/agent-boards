// macOS のメニューバーに「編集」メニュー(取り消す・やり直す・カット・コピー・ペースト・すべてを選択)を作る。
//
// macOS では ⌘Z / ⌘C / ⌘V などはメニューの項目を通って WKWebView に届く。webview(webview-bun が使うライブラリ)は
// メニューを作らないので、何もしないと本文の編集欄でこれらのショートカットが効かない。項目の action は
// first responder(フォーカスのある WKWebView)へ流れ、WebKit 標準の取り消し・クリップボード操作になる。
//
// ⌘W・⌘S など textboard.html が自分で扱うキーはメニューに載せない(載せるとページに届かなくなる)。
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

// objc_msgSend は引数の数ごとに型を決めて呼ぶ必要があるので、引数の数ごとに別に開く
const base = dlopen(LIBOBJC, {
  objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols;
const send1 = dlopen(LIBOBJC, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols.objc_msgSend;
const send3 = dlopen(LIBOBJC, {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols.objc_msgSend;

function cstr(s: string) {
  return ptr(Buffer.from(s + "\0", "utf8"));
}

function cls(name: string): Pointer {
  return base.objc_getClass(cstr(name)) as Pointer;
}

function sel(name: string): Pointer {
  return base.sel_registerName(cstr(name)) as Pointer;
}

function nsString(s: string): Pointer {
  return send1(cls("NSString"), sel("stringWithUTF8String:"), cstr(s)) as Pointer;
}

function newMenu(title: string): Pointer {
  const menu = base.objc_msgSend(cls("NSMenu"), sel("alloc")) as Pointer;
  return send1(menu, sel("initWithTitle:"), nsString(title)) as Pointer;
}

function addItem(menu: Pointer, title: string, action: string | null, key: string): Pointer {
  return send3(menu, sel("addItemWithTitle:action:keyEquivalent:"), nsString(title), action ? sel(action) : null, nsString(key)) as Pointer;
}

export function installEditMenu(lang: "ja" | "en") {
  const t =
    lang === "ja"
      ? { edit: "編集", undo: "取り消す", redo: "やり直す", cut: "カット", copy: "コピー", paste: "ペースト", selectAll: "すべてを選択" }
      : { edit: "Edit", undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All" };

  const app = base.objc_msgSend(cls("NSApplication"), sel("sharedApplication")) as Pointer;
  const mainMenu = newMenu("");

  // メニューバーの先頭はアプリケーションメニューとして扱われるので、空のものを置いてから「編集」を足す
  const appItem = addItem(mainMenu, "", null, "");
  send1(appItem, sel("setSubmenu:"), newMenu("textboard"));

  const editItem = addItem(mainMenu, t.edit, null, "");
  const edit = newMenu(t.edit);
  addItem(edit, t.undo, "undo:", "z");
  addItem(edit, t.redo, "redo:", "Z"); // 大文字は ⇧ 付き(⌘⇧Z)
  send1(edit, sel("addItem:"), base.objc_msgSend(cls("NSMenuItem"), sel("separatorItem")));
  addItem(edit, t.cut, "cut:", "x");
  addItem(edit, t.copy, "copy:", "c");
  addItem(edit, t.paste, "paste:", "v");
  addItem(edit, t.selectAll, "selectAll:", "a");
  send1(editItem, sel("setSubmenu:"), edit);

  send1(app, sel("setMainMenu:"), mainMenu);
}
