// reportboard's conversations with the AI, one thread per section (h2 / h3).
// Stored in <home>/threads/<sha256 of the report's absolute path>.json, never next to the report, so the user's
// repository gets no extra files. They survive replacing the window and reloading the file.
//
// A thread remembers the heading it was started on (level, text, and which occurrence of that text), and the ledger row
// when it was started on one. On every render it is attached to the place that still matches; a thread whose place is
// gone is shown at the end of the report
// (docs/design.md "セクションごとに AI とやり取りする").
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// receivedAt: when `wait` handed the user's message to the AI. doneAt: when the AI sent its last reply to it (`reply --done`).
// In between, the window shows that the AI is working on it
export type ThreadMessage = { from: "user" | "ai"; text: string; at: string; receivedAt?: string; doneAt?: string };
export type RowRef = { name: string; occurrence: number };
export type SectionRef = { level: number; text: string; occurrence: number; row?: RowRef };
export type Thread = { id: string; heading: SectionRef; messages: ThreadMessage[] };
export type ThreadFile = { file: string; threads: Thread[] };
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

// Pairs each thread with the section it belongs to now. sectionId is null when its heading is gone
export function placeThreads(threads: Thread[], sections: Section[]): Array<Thread & { sectionId: string | null }> {
  return threads.map((thread) => {
    const section = sections.find(
      (s) =>
        s.level === thread.heading.level &&
        s.text === thread.heading.text &&
        s.occurrence === thread.heading.occurrence &&
        s.row?.name === thread.heading.row?.name &&
        s.row?.occurrence === thread.heading.row?.occurrence,
    );
    return { ...thread, sectionId: section?.id ?? null };
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
