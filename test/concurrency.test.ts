import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUserMessage, readThreads } from "../lib/threads.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-boards-concurrency-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runAll(commands: string[][]) {
  const procs = commands.map((cmd) => Bun.spawn(["bun", ...cmd], { stdout: "pipe", stderr: "pipe" }));
  return Promise.all(procs.map(async (p) => ({ code: await p.exited, stderr: await new Response(p.stderr).text() })));
}

test("launches for the same name that overlap all get the lock in turn, without crashing", async () => {
  const worker = join(import.meta.dir, "workers/lock-worker.ts");
  const stateDir = join(dir, "state");
  const results = await runAll(Array.from({ length: 6 }, () => [worker, stateDir, "150"]));
  for (const r of results) expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
}, 60_000);

test("the window and reply writing one thread at the same time lose no message", async () => {
  const worker = join(import.meta.dir, "workers/thread-worker.ts");
  const report = "/reports/race.md";
  const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section: { level: 2, text: "s", occurrence: 0 }, text: "first" });
  const writers = [
    [worker, dir, report, thread.id, "user", "40", "u1"],
    [worker, dir, report, thread.id, "user", "40", "u2"],
    [worker, dir, report, thread.id, "ai", "40", "a1"],
    [worker, dir, report, thread.id, "ai", "40", "a2"],
  ];
  const results = await runAll(writers);
  for (const r of results) expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
  const texts = readThreads(dir, report).threads[0].messages.map((m) => m.text);
  expect(texts).toHaveLength(1 + 4 * 40);
  for (const tag of ["u1", "u2", "a1", "a2"]) for (let i = 0; i < 40; i++) expect(texts).toContain(`${tag}-${i}`);
}, 60_000);
