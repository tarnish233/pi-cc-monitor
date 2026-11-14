import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";
import { createHarness, startReady, until } from "./runtime-harness.mjs";

const { ENDED_MONITOR_HISTORY_LIMIT } = await loadModule("index.ts");

test("terminal history is bounded only after every outcome is delivered, without touching active work", async (t) => {
	const h = createHarness({ idle: false });
	t.after(() => h.close());
	const active = await startReady(h);
	const receipts = await Promise.all(Array.from({ length: ENDED_MONITOR_HISTORY_LIMIT + 1 }, (_, index) =>
		h.call("Monitor", { command: ":", description: `history ${index}`, mode: "completion" }).then((result) => result.details),
	));

	const completedBeforeFlush = await until(async () => {
		const list = await h.snapshots();
		return receipts.every(({ taskId }) => list.some((record) => record.id === taskId && record.status === "completed"));
	});
	const statusCounts = (await h.snapshots()).reduce((counts, record) => ({ ...counts, [record.status]: (counts[record.status] ?? 0) + 1 }), {});
	assert.ok(completedBeforeFlush, `all one-shot commands reached their terminal state: ${JSON.stringify(statusCounts)}`);
	const before = await h.snapshots();
	assert.equal(before.length, ENDED_MONITOR_HISTORY_LIMIT + 2, "busy delivery retains every terminal record plus active work");
	assert.equal(h.sent.length, 0, "none of the terminal outcomes was delivered while the agent was busy");

	const expectedEviction = before
		.filter((record) => record.status === "completed")
		.sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt))[0];
	h.setIdle(true);
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, ENDED_MONITOR_HISTORY_LIMIT + 1, "bounding history never drops a pending outcome");

	const bounded = await until(async () => (await h.snapshots()).length === ENDED_MONITOR_HISTORY_LIMIT + 1);
	assert.ok(bounded, "delivered terminal records are pruned in the background");
	const after = await h.snapshots();
	assert.equal(after.filter((record) => record.status === "completed").length, ENDED_MONITOR_HISTORY_LIMIT);
	assert.ok(after.some((record) => record.id === active.taskId && record.status === "running"), "active work never counts as terminal history");
	assert.ok(!after.some((record) => record.id === expectedEviction.id), "the oldest delivered terminal record is evicted first");
});
