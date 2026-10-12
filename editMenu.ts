// Builds the Edit menu (Undo, Redo, Cut, Copy, Paste, Select All) in the macOS menu bar.
//
// On macOS, ⌘Z / ⌘C / ⌘V and the like reach WKWebView through menu items. webview (the library webview-bun uses)
// creates no menu, so without this these shortcuts do nothing in the editor. Each item's action goes to the
// first responder (the focused WKWebView) and becomes WebKit's standard undo / clipboard operation.
//
// Keys that textboard.html handles itself, such as ⌘W and ⌘S, are not put in the menu (they would no longer reach the page).
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const LIBOBJC = "/usr/lib/libobjc.A.dylib";

// objc_msgSend must be called with a signature fixed per argument count, so it is opened once per argument count
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

  // The first menu in the bar is treated as the application menu, so put an empty one first, then add Edit
  const appItem = addItem(mainMenu, "", null, "");
  send1(appItem, sel("setSubmenu:"), newMenu("textboard"));

  const editItem = addItem(mainMenu, t.edit, null, "");
  const edit = newMenu(t.edit);
  addItem(edit, t.undo, "undo:", "z");
  addItem(edit, t.redo, "redo:", "Z"); // Uppercase means with ⇧ (⌘⇧Z)
  send1(edit, sel("addItem:"), base.objc_msgSend(cls("NSMenuItem"), sel("separatorItem")));
  addItem(edit, t.cut, "cut:", "x");
  addItem(edit, t.copy, "copy:", "c");
  addItem(edit, t.paste, "paste:", "v");
  addItem(edit, t.selectAll, "selectAll:", "a");
  send1(editItem, sel("setSubmenu:"), edit);

  send1(app, sel("setMainMenu:"), mainMenu);
}
