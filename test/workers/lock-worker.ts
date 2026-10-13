// Run by test/concurrency.test.ts: takes and releases the lock of one target many times, while other workers do the same.
// While holding the lock it creates a marker with O_EXCL, so two holders at once would fail.
// usage: bun lock-worker.ts <stateDir> <rounds>
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWindowHost } from "../../lib/windows.ts";

const [stateDir, rounds] = process.argv.slice(2);
const host = createWindowHost({ name: "locktest", scriptPath: "/nowhere.ts", htmlPath: "/nowhere.html", stateDir });
host.ensureStateDir((dir) => {
  throw new Error(`bad state dir ${dir}`);
});
const marker = join(stateDir, "holder");
for (let i = 0; i < Number(rounds); i++) {
  if (!(await host.acquireTargetLock("same"))) throw new Error("lock timed out");
  writeFileSync(marker, String(process.pid), { flag: "wx" });
  rmSync(marker);
  host.releaseTargetLock("same");
}
