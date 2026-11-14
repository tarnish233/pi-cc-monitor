import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { groupTaskEntries } = await loadModule("tasks.ts");
const entry = (id, extra = {}) => ({ provider: "monitor", providerLabel: "Monitor", id, title: id, state: "running", active: true, ...extra });

test("actual parent links group subscriptions immediately after their source, preserving sibling order", () => {
  const input = [entry("work", { role: "task" }), entry("independent"), entry("errors", { parentId: "work", role: "subscription" }), entry("progress", { parentId: "work", role: "subscription" })];
  const original = JSON.stringify(input);
  const output = groupTaskEntries(input);
  assert.deepEqual(output.map((item) => item.id), ["work", "errors", "progress", "independent"]);
  assert.deepEqual(output.map((item) => item.depth), [0, 1, 1, 0]);
  assert.equal(output[0].hasChildren, true);
  assert.equal(JSON.stringify(input), original, "grouping must not mutate provider data");
});

test("provider namespace is part of a relation; identical titles never create a parent", () => {
  const input = [entry("work", { provider: "loop", title: "same" }), entry("observer", { parentId: "work", title: "same" }), entry("unrelated", { title: "same" })];
  const output = groupTaskEntries(input);
  assert.deepEqual(output.map((item) => item.depth), [0, 0, 0]);
  assert.deepEqual(output.map((item) => item.id), ["work", "observer", "unrelated"]);
});

test("missing parents, self-links and cycles stay visible once without recursion", () => {
  const input = [entry("orphan", { parentId: "missing" }), entry("self", { parentId: "self" }), entry("a", { parentId: "b" }), entry("b", { parentId: "a" })];
  const output = groupTaskEntries(input);
  assert.equal(output.length, input.length);
  assert.deepEqual(new Set(output.map((item) => item.id)), new Set(input.map((item) => item.id)));
  assert.equal(output.find((item) => item.id === "orphan").depth, 0);
  assert.equal(output.find((item) => item.id === "self").depth, 0);
});

test("deep relationships use an iterative traversal and preserve flat providers unchanged", () => {
  const flat = [entry("loop1", { provider: "loop" }), entry("loop2", { provider: "loop" })];
  assert.deepEqual(groupTaskEntries(flat).map((item) => item.id), ["loop1", "loop2"]);
  const deep = Array.from({ length: 10000 }, (_, i) => entry(String(i), i ? { parentId: String(i - 1) } : {}));
  const output = groupTaskEntries(deep);
  assert.equal(output.length, deep.length);
  assert.equal(output.at(-1).depth, deep.length - 1);
});
