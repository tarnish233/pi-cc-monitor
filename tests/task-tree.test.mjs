import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { groupTaskEntries } = await loadModule("tasks.ts");
const entry = (id, extra = {}) => ({ provider: "monitor", providerLabel: "Monitor", id, title: id, state: "running", active: true, ...extra });

test("entries are newest-first across providers without mutating provider snapshots", () => {
  const input = [
    entry("work", { createdAt: 10 }),
    entry("independent", { createdAt: 40 }),
    entry("errors", { createdAt: 20 }),
    entry("progress", { createdAt: 30 }),
    entry("loop", { createdAt: 50, provider: "loop", providerLabel: "Loop" }),
  ];
  const original = JSON.stringify(input);
  const output = groupTaskEntries(input);
  assert.deepEqual(output.map((item) => item.id), ["loop", "independent", "progress", "errors", "work"]);
  assert.equal(JSON.stringify(input), original, "sorting must not mutate provider snapshots");
});

test("equal times are stable and missing or invalid times fall back to provider order", () => {
  const input = [
    entry("undated"), entry("tie-a", { createdAt: 100 }), entry("zero", { createdAt: 0 }),
    entry("nan", { createdAt: NaN }), entry("newest", { createdAt: 200 }),
    entry("tie-b", { createdAt: 100 }), entry("infinity", { createdAt: Infinity }),
  ];
  assert.deepEqual(groupTaskEntries(input).map((item) => item.id), ["newest", "tie-a", "tie-b", "zero", "undated", "nan", "infinity"]);
});

test("provider namespace deduplicates only within the same provider", () => {
  const input = [entry("same", { provider: "loop", createdAt: 20 }), entry("same", { provider: "monitor", createdAt: 10 }), entry("same", { provider: "monitor", title: "duplicate", createdAt: 999 })];
  const output = groupTaskEntries(input);
  assert.equal(output.length, 2);
  assert.deepEqual(output.map((item) => [item.provider, item.title]), [["loop", "same"], ["monitor", "same"]]);
});
