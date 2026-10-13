// Run by test/concurrency.test.ts: appends messages to one thread, as the window (user) or as `reply` (ai).
// usage: bun thread-worker.ts <home> <reportPath> <threadId> <user|ai> <count> <tag>
import { addReply, addUserMessage } from "../../lib/threads.ts";

const [home, reportPath, threadId, role, count, tag] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  const text = `${tag}-${i}`;
  if (role === "user") addUserMessage({ home, reportPath, threadId, section: { level: 2, text: "s", occurrence: 0 }, text });
  else if (addReply({ home, threadId, text }) === null) throw new Error("thread not found");
}
