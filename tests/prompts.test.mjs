import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { MONITOR_DESCRIPTION, MONITOR_PROMPT_GUIDELINES, MONITOR_TIMEOUTS } = await loadModule("prompts.ts");

test("completion contract keeps strong waiting and verification rules without unconditional handoff", () => {
	assert.equal(MONITOR_PROMPT_GUIDELINES.length, 5);
	assert.match(MONITOR_DESCRIPTION, /LAUNCH RECEIPT, not a result/);
	assert.match(MONITOR_DESCRIPTION, /Continue independent work/);
	assert.match(MONITOR_DESCRIPTION, /If only waiting for Monitor, end your turn/);
	assert.match(MONITOR_DESCRIPTION, /Do not poll, sleep, re-read its logs/);
	assert.match(MONITOR_DESCRIPTION, /while it is pending/);
	assert.ok(MONITOR_DESCRIPTION.includes("read and verify the required outputs/files before using the result"));
	assert.match(MONITOR_DESCRIPTION, /all results it needs have been obtained and verified/);
	assert.match(MONITOR_DESCRIPTION, /Unrelated background tasks do not delay other answers/);
	assert.doesNotMatch(MONITOR_DESCRIPTION, /MUST end your turn|end your turn immediately|never in the launch turn/);
});

test("notification timing and no-turn policy match the boundary runtime", () => {
	assert.ok(MONITOR_DESCRIPTION.includes("next response/tool-batch boundary"));
	assert.match(MONITOR_DESCRIPTION, /does not interrupt the current response or tool batch/);
	assert.match(MONITOR_DESCRIPTION, /end, failure and stop always wake the model/);
	assert.match(MONITOR_DESCRIPTION, /cannot be chosen at start/);
	assert.match(MONITOR_DESCRIPTION, /stored without restarting/);
	assert.doesNotMatch(MONITOR_DESCRIPTION, /protected settled delivery|result arrives after the active turn/);
	assert.match(MONITOR_PROMPT_GUIDELINES[2], /does not require immediately finishing the overall report/);
	assert.match(MONITOR_PROMPT_GUIDELINES[3], /every task the report depends on/);
});

test("per-mode deadlines remain shared and unchanged", () => {
	assert.deepEqual(MONITOR_TIMEOUTS, {
		events: { defaultMs: 300_000, maxMs: 3_600_000 },
		completion: { defaultMs: 1_800_000, maxMs: 7_200_000 },
	});
	assert.ok(MONITOR_DESCRIPTION.includes(String(MONITOR_TIMEOUTS.completion.defaultMs)));
	assert.ok(MONITOR_DESCRIPTION.includes(String(MONITOR_TIMEOUTS.completion.maxMs)));
});
