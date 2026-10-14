// Instructions from a window to the agent, shared by textboard and reportboard.
// The window process writes JSON to outbox/<name>/ (send); `<command> wait --target <name>` (once) or
// `<command> watch --target <name>` (keeps running, one line per instruction) takes and deletes it.
// Instructions sent while nobody is receiving are kept and taken by the next wait or watch, all of them at once.
// A running wait or watch leaves a marker in targets/<name>.waiters/<pid>, so the window can show whether the AI is waiting.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WindowHost } from "./windows.ts";

export const OUTBOX_DIR_NAME = "outbox";
const WAIT_POLL_MS = 300;

export type WaitMessages = {
  badTimeout: string;
  badTargetName: string;
  notOpen: (target: string) => string;
  windowClosed: (target: string) => string;
  waitTimeout: (target: string) => string;
};

export function createOutbox(host: WindowHost) {
  const outboxDir = (target: string) => join(host.stateDir, OUTBOX_DIR_NAME, target);
  const waitersDir = (target: string) => join(host.targetsDir, `${target}.waiters`);
  // When the latest `wait` for the name started (the content is ms since the epoch)
  const waitStartedPath = (target: string) => join(host.targetsDir, `${target}.wait-started`);

  function prepare(target: string): void {
    mkdirSync(outboxDir(target), { recursive: true, mode: 0o700 });
  }

  function send(target: string, payload: Record<string, unknown>): { id: string } {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const full = { id, target, ...payload };
    prepare(target);
    // Write under another name and rename, so wait never reads a half-written file
    const tmp = join(outboxDir(target), `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n");
    renameSync(tmp, join(outboxDir(target), `${id}.json`));
    return { id };
  }

  function pendingIds(target: string): string[] {
    const dir = outboxDir(target);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort()
      .map((f) => f.slice(0, -".json".length));
  }

  // Take the oldest instruction. Claim it by rename before reading, so that even when several waits take at once,
  // each instruction goes to exactly one wait
  function take(target: string): string | null {
    for (const id of pendingIds(target)) {
      const from = join(outboxDir(target), `${id}.json`);
      const claimed = join(outboxDir(target), `.${id}.${process.pid}.taken`);
      try {
        renameSync(from, claimed);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      const content = readFileSync(claimed, "utf8");
      rmSync(claimed, { force: true });
      return content;
    }
    return null;
  }

  // Every queued instruction, oldest first
  function takeAll(target: string): string[] {
    const taken: string[] = [];
    for (let next = take(target); next !== null; next = take(target)) taken.push(next);
    return taken;
  }

  // The instructions for one target not yet taken, read without taking them
  function pending(target: string): Array<Record<string, unknown>> {
    const found: Array<Record<string, unknown>> = [];
    for (const id of pendingIds(target)) {
      try {
        found.push(JSON.parse(readFileSync(join(outboxDir(target), `${id}.json`), "utf8")));
      } catch {
        // Taken meanwhile
      }
    }
    return found;
  }

  // The targets that have an outbox
  function targets(): string[] {
    const dir = join(host.stateDir, OUTBOX_DIR_NAME);
    return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
  }

  function lastWaitStarted(target: string): number | null {
    try {
      const ms = Number(readFileSync(waitStartedPath(target), "utf8"));
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }

  function waiterAlive(target: string): boolean {
    const dir = waitersDir(target);
    if (!existsSync(dir)) return false;
    for (const file of readdirSync(dir)) {
      const pid = Number(file);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        rmSync(join(dir, file), { force: true });
      }
    }
    return false;
  }

  function parseArgs(args: string[], M: WaitMessages, usageError: (message: string) => never, isTargetName: (name: string | undefined) => name is string) {
    let target: string | null = null;
    let timeoutMs: number | null = null;
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === "--target") {
        const name = args[i + 1];
        if (!isTargetName(name)) return usageError(M.badTargetName);
        target = name;
      } else if (args[i] === "--timeout") {
        const seconds = Number(args[i + 1]);
        if (!Number.isFinite(seconds) || seconds <= 0) usageError(M.badTimeout);
        timeoutMs = seconds * 1000;
      } else usageError(M.badTargetName);
    }
    if (target === null) return usageError(M.badTargetName);
    return { target, timeoutMs };
  }

  type ReceiveParams = { args: string[]; messages: WaitMessages; usageError: (message: string) => never; isTargetName: (name: string | undefined) => name is string; onTaken?: (instruction: string) => void };

  // `wait --target <name> [--timeout <sec>]`. Prints on stdout the instruction JSON, or, when several were queued, a JSON
  // array of all of them, oldest first: an agent that came back late gets everything it missed at once.
  // Exit codes: 0 = got some / 1 = the window is not open / 2 = --timeout passed / 3 = the window was closed
  // onTaken runs with each instruction JSON right after it is printed (reportboard notes there that the AI got it)
  async function wait(params: ReceiveParams): Promise<number> {
    const { target, timeoutMs } = parseArgs(params.args, params.messages, params.usageError, params.isTargetName);
    const onTaken = params.onTaken ?? (() => {});
    writeFileSync(waitStartedPath(target), String(Date.now()));
    // Print first: if onTaken stalls (a lock) and the process is killed, the instructions have already reached the AI
    const handOver = (instructions: string[]) => {
      process.stdout.write(instructions.length === 1 ? instructions[0] : JSON.stringify(instructions.map((i) => JSON.parse(i)), null, 2) + "\n");
      for (const instruction of instructions) onTaken(instruction);
    };
    return await listen({ target, timeoutMs, M: params.messages, handOver, once: true });
  }

  // `watch --target <name> [--timeout <sec>]`: keeps running and prints every instruction as it comes, one JSON per line
  // (for a monitor that turns each line into a notification). Starts with everything queued. Runs until the window is
  // closed (3), --timeout passes (2), or it is stopped; 1 = the window is not open
  async function watch(params: ReceiveParams): Promise<number> {
    const { target, timeoutMs } = parseArgs(params.args, params.messages, params.usageError, params.isTargetName);
    const onTaken = params.onTaken ?? (() => {});
    const handOver = (instructions: string[]) => {
      for (const instruction of instructions) {
        process.stdout.write(JSON.stringify(JSON.parse(instruction)) + "\n");
        onTaken(instruction);
      }
    };
    return await listen({ target, timeoutMs, M: params.messages, handOver, once: false });
  }

  async function listen(params: { target: string; timeoutMs: number | null; M: WaitMessages; handOver: (instructions: string[]) => void; once: boolean }): Promise<number> {
    const { target, M, handOver, once } = params;
    // Hand over the queued instructions first, even if the window is not open
    const queued = takeAll(target);
    if (queued.length > 0) {
      handOver(queued);
      if (once) return 0;
    }
    if (host.findWindowPid(target) === null) {
      console.error(M.notOpen(target));
      return queued.length > 0 ? 0 : 1;
    }

    // A marker so the window can show that the AI is waiting. With several waits for the same name, any live one counts
    const marker = join(waitersDir(target), String(process.pid));
    mkdirSync(waitersDir(target), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "");
    const removeMarker = () => rmSync(marker, { force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        removeMarker();
        process.exit(130);
      });
    }

    try {
      const deadline = params.timeoutMs === null ? Infinity : Date.now() + params.timeoutMs;
      let lastWindowCheck = 0;
      while (Date.now() < deadline) {
        const instructions = takeAll(target);
        if (instructions.length > 0) {
          handOver(instructions);
          if (once) return 0;
        }
        if (Date.now() - lastWindowCheck > 1000) {
          lastWindowCheck = Date.now();
          if (host.findWindowPid(target) === null && pendingIds(target).length === 0) {
            console.error(M.windowClosed(target));
            return 3;
          }
        }
        await Bun.sleep(WAIT_POLL_MS);
      }
      console.error(M.waitTimeout(target));
      return 2;
    } finally {
      removeMarker();
    }
  }

  return { outboxDir, waitersDir, prepare, send, pendingIds, pending, targets, take, takeAll, waiterAlive, lastWaitStarted, wait, watch };
}
