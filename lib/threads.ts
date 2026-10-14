// reportboard's conversations with the AI, one thread per section (h2 / h3).
// Stored in <home>/threads/<sha256 of the report's absolute path>.json, never next to the report, so the user's
// repository gets no extra files. They survive replacing the window and reloading the file.
//
// A thread remembers the heading it was started on (level, text, and which occurrence of that text), and the ledger row
// when it was started on one. On every render it is attached to the place that still matches, following renamed headings
// and moved rows (placeThreads); no thread is ever left out of the window
// (docs/design.md "レポートを書き換えても会話を見失わせない").
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// receivedAt: when `wait` handed the user's message to the AI. doneAt: when the AI sent its last reply to it (`reply --done`).
// In between, the window shows that the AI is working on it
export type ThreadMessage = { from: "user" | "ai"; text: string; at: string; receivedAt?: string; doneAt?: string };
export type RowRef = { name: string; occurrence: number };
export type SectionRef = { level: number; text: string; occurrence: number; row?: RowRef };
export type Thread = { id: string; heading: SectionRef; messages: ThreadMessage[] };
// resetThreadIds: threads the user cleared from the window (resetThreads), so a late reply can say so
export type ThreadFile = { file: string; threads: Thread[]; resetThreadIds?: string[] };
// A section of the rendered report a thread can sit on
export type Section = SectionRef & { id: string };

// The window (sending) and `reply` (another process) both read, change and write a whole threads file. Each change
// happens under a per-file lock, so a message written by one is never overwritten by the other.
// Synchronous on purpose: the window process cannot await inside webview callbacks
const LOCK_RETRY_MS = 5;
const LOCK_WAIT_MS = 15_000;
// A lock left by a killed process is taken over after this long (a change takes milliseconds)
const LOCK_STALE_MS = 10_000;

export function threadsDir(home: string): string {
  return join(home, "threads");
}

export function threadsPath(home: string, reportPath: string): string {
  return join(threadsDir(home), createHash("sha256").update(reportPath).digest("hex") + ".json");
}

export function readThreads(home: string, reportPath: string): ThreadFile {
  const path = threadsPath(home, reportPath);
  if (!existsSync(path)) return { file: reportPath, threads: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ThreadFile;
}

// Append the user's message, starting a thread on the section when threadId is null
export function addUserMessage(params: { home: string; reportPath: string; threadId: string | null; section: SectionRef; text: string; now?: Date }): Thread {
  return withThreadsLock(threadsPath(params.home, params.reportPath), () => addUserMessageLocked(params));
}

function addUserMessageLocked(params: { home: string; reportPath: string; threadId: string | null; section: SectionRef; text: string; now?: Date }): Thread {
  const data = readThreads(params.home, params.reportPath);
  let thread = params.threadId === null ? undefined : data.threads.find((t) => t.id === params.threadId);
  if (thread === undefined) {
    const { level, text, occurrence, row } = params.section;
    const heading: SectionRef = row === undefined ? { level, text, occurrence } : { level, text, occurrence, row: { name: row.name, occurrence: row.occurrence } };
    thread = { id: `t-${randomUUID().replaceAll("-", "").slice(0, 12)}`, heading, messages: [] };
    data.threads.push(thread);
  }
  thread.messages.push({ from: "user", text: params.text, at: (params.now ?? new Date()).toISOString() });
  writeThreads(params.home, params.reportPath, data);
  return thread;
}

// Append the AI's reply. The thread is found by its id among every report's threads.
// done: this is the last reply to what the AI received, so the window stops showing that it is working
export function addReply(params: { home: string; threadId: string; text: string; done?: boolean; now?: Date }): { file: string; thread: Thread } | null {
  return changeThread(params.home, params.threadId, (thread) => {
    const at = (params.now ?? new Date()).toISOString();
    if (params.done === true) {
      for (const m of thread.messages) if (m.from === "user" && m.receivedAt !== undefined) m.doneAt ??= at;
    }
    thread.messages.push({ from: "ai", text: params.text, at });
    return true;
  });
}

// The user cleared the report's conversations in the window. The report itself is not touched. Returns the ids removed
export function resetThreads(params: { home: string; reportPath: string }): string[] {
  const path = threadsPath(params.home, params.reportPath);
  if (!existsSync(path)) return [];
  return withThreadsLock(path, () => {
    const data = readThreads(params.home, params.reportPath);
    const ids = data.threads.map((t) => t.id);
    if (ids.length === 0) return [];
    writeThreads(params.home, params.reportPath, { ...data, threads: [], resetThreadIds: [...(data.resetThreadIds ?? []), ...ids] });
    return ids;
  });
}

// Whether the thread was cleared by the user (resetThreads), for a reply that comes after
export function wasReset(home: string, threadId: string): boolean {
  const dir = threadsDir(home);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => name.endsWith(".json") && parseThreadFile(join(dir, name))?.resetThreadIds?.includes(threadId) === true);
}

// Note that `wait` handed the user's message sent at `sentAt` to the AI. False when the message is not there
export function markReceived(params: { home: string; threadId: string; sentAt: string; now?: Date }): boolean {
  const result = changeThread(params.home, params.threadId, (thread) => {
    const message = thread.messages.find((m) => m.from === "user" && m.at === params.sentAt);
    if (message === undefined) return false;
    message.receivedAt ??= (params.now ?? new Date()).toISOString();
    return true;
  });
  return result !== null;
}

// What the window shows for a thread, from the user's latest message:
// "sent" = no AI has taken it yet; "received" = an AI took it and has not replied yet; "working" = it has replied and
// is still at it; null = nothing pending. The work ends with `reply --done`, or when a `wait` for the window starts
// after the AI took the message (waitStartedAt, ms): an AI that waits again has finished, even if it forgot --done
export function threadState(thread: Pick<Thread, "messages">, waitStartedAt: number | null = null): "sent" | "received" | "working" | null {
  const index = thread.messages.findLastIndex((m) => m.from === "user");
  if (index === -1) return null;
  const message = thread.messages[index];
  if (message.receivedAt === undefined) return "sent";
  if (message.doneAt !== undefined || (waitStartedAt !== null && waitStartedAt > Date.parse(message.receivedAt))) return null;
  return index === thread.messages.length - 1 ? "received" : "working";
}

// Find the thread by its id among every report's threads and change it under the lock. change returns false to write nothing
function changeThread(home: string, threadId: string, change: (thread: Thread) => boolean): { file: string; thread: Thread } | null {
  const dir = threadsDir(home);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    // Find the file without the lock, then read it again under the lock before changing it
    if (parseThreadFile(path)?.threads.some((t) => t.id === threadId) !== true) continue;
    const result = withThreadsLock(path, () => {
      const data = parseThreadFile(path);
      const thread = data?.threads.find((t) => t.id === threadId);
      if (data === null || thread === undefined || !change(thread)) return null;
      writeThreads(home, data.file, data);
      return { file: data.file, thread };
    });
    if (result !== null) return result;
  }
  return null;
}

// How a thread was placed on the report as it is now:
// "exact" = its heading (and row) as saved; "renamed" = the same place under a changed name (the numbers in the
// heading changed, or the row moved under another heading), so the thread follows it; "moved" = its row is gone but
// its heading is there, so it is shown under the heading with where it came from; null = its heading is gone too
// (sectionId null)
export type Placement = "exact" | "renamed" | "moved" | null;
export type PlacedThread = Thread & { sectionId: string | null; placement: Placement; place: SectionRef | null };

// Names compared with their numbers left out: a report's headings and rows carry totals that change with each edit
// ("Phase 4 — 51 人日" → "Phase 4 — 49 人日")
function withoutNumbers(text: string): string {
  return text.replace(/[0-9０-９]+(?:[.,．][0-9０-９]+)*/g, "#").replace(/\s+/g, " ").trim();
}

// The occurrence-th of the candidates, or the only one: a heading or row of the same name that is still there at another
// position is a different one, so a renamed candidate (with other numbers) is taken alone only when it is the only one
function pick<T>(candidates: T[], occurrence: number, alone: boolean): T | null {
  if (alone && candidates.length === 1) return candidates[0];
  return candidates[occurrence] ?? null;
}

function only<T>(candidates: T[]): T | null {
  return candidates.length === 1 ? candidates[0] : null;
}

// Pairs each thread with the section it belongs to now. A conversation is never dropped: a thread whose place cannot be
// found has sectionId null and the window shows it apart (docs/design.md "セクションごとに AI とやり取りする").
// place: the section it sits on now, without the id (what to save when it was renamed)
export function placeThreads(threads: Thread[], sections: Section[]): PlacedThread[] {
  const headings = sections.filter((s) => s.row === undefined);
  const rows = sections.filter((s) => s.row !== undefined);
  const refOf = (s: Section): SectionRef => {
    const { id: _, ...ref } = s;
    return ref;
  };
  const placed = (thread: Thread, section: Section | null, placement: Placement): PlacedThread => ({
    ...thread,
    sectionId: section?.id ?? null,
    placement: section === null ? null : placement,
    place: section === null ? null : refOf(section),
  });

  return threads.map((thread) => {
    const saved = thread.heading;
    const exact = sections.find(
      (s) =>
        s.level === saved.level &&
        s.text === saved.text &&
        s.occurrence === saved.occurrence &&
        s.row?.name === saved.row?.name &&
        s.row?.occurrence === saved.row?.occurrence,
    );
    if (exact !== undefined) return placed(thread, exact, "exact");

    const sameHeading = (s: Section) => s.level === saved.level && s.text === saved.text && s.occurrence === saved.occurrence;
    const heading =
      headings.find(sameHeading) ??
      pick(
        headings.filter((s) => s.level === saved.level && s.text !== saved.text && withoutNumbers(s.text) === withoutNumbers(saved.text)),
        saved.occurrence,
        true,
      );
    if (saved.row === undefined) return placed(thread, heading, "renamed");

    const name = saved.row.name;
    const occurrence = saved.row.occurrence;
    const under = heading === null ? [] : rows.filter((s) => s.level === heading.level && s.text === heading.text && s.occurrence === heading.occurrence);
    const renamedRow = (s: Section) => s.row !== undefined && s.row.name !== name && withoutNumbers(s.row.name) === withoutNumbers(name);
    const row =
      pick(under.filter((s) => s.row?.name === name), occurrence, false) ??
      pick(under.filter(renamedRow), occurrence, true) ??
      // The row moved under another heading (an item moved from one phase to another)
      // (taken only when there is one row of that name in the report)
      (under.every((s) => s.row?.name !== name) ? only(rows.filter((s) => s.row?.name === name)) : null) ??
      only(rows.filter(renamedRow));
    if (row !== null) return placed(thread, row, "renamed");
    return placed(thread, heading, "moved");
  });
}

// Save the place of the threads that were found under a changed name, so they keep following it through the next edits
// and `wait` reports the heading as it is now. Threads changed meanwhile by someone else keep what they have
export function rememberPlaces(params: { home: string; reportPath: string; places: Array<{ id: string; from: SectionRef; to: SectionRef }> }): void {
  if (params.places.length === 0) return;
  const path = threadsPath(params.home, params.reportPath);
  withThreadsLock(path, () => {
    const data = readThreads(params.home, params.reportPath);
    let changed = false;
    for (const { id, from, to } of params.places) {
      const thread = data.threads.find((t) => t.id === id);
      if (thread === undefined || JSON.stringify(thread.heading) !== JSON.stringify(from)) continue;
      thread.heading = to;
      changed = true;
    }
    if (changed) writeThreads(params.home, params.reportPath, data);
  });
}

// Another report's broken file must not stop replies to every other thread
function parseThreadFile(path: string): ThreadFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ThreadFile;
  } catch {
    return null;
  }
}

function withThreadsLock<T>(path: string, change: () => T): T {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch (statError) {
        if (!isErrorCode(statError, "ENOENT")) throw statError;
      }
      if (Date.now() > deadline) throw new Error(`could not lock ${lock}`);
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return change();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Written to a temporary file and renamed over, so a symlink placed there is replaced rather than followed
function writeThreads(home: string, reportPath: string, data: ThreadFile): void {
  mkdirSync(threadsDir(home), { recursive: true, mode: 0o700 });
  const path = threadsPath(home, reportPath);
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...data, file: reportPath }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
}
