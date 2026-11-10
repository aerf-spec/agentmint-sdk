// npm run loadtest: 1,000 receipts at 50/s, then a burst of 1,000 at once.
import { runLoad, startHarness } from "./bench.js";

const h = await startHarness();
try {
  // Warm the agent-side path (the signer process warms itself at boot).
  await runLoad(h, { count: 200, rate: 0, label: "warmup" });
  for (const [count, rate] of [[1000, 50], [1000, 0]] as const) {
    const r = await runLoad(h, { count, rate });
    console.log(JSON.stringify(r));
  }
} finally {
  await h.close();
}
