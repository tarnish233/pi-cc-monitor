/** Existing footer behavior, exercised through observation-only sources. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { createJob } from './observation-fixtures.mjs';
const { default: factory } = await loadModule('index.ts');
function harness(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-footer-'));
  const tools = new Map(), commands = new Map(), handlers = new Map(), calls = [], bus = new Map();
  const pi = { registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, spec) => commands.set(name, spec), registerMessageRenderer() {}, registerToolRenderer() {}, appendEntry() {}, sendMessage() {},
    getAllTools: () => [...tools.keys()].map(name => ({ name })), getCommands: () => [],
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); }; },
    events: { on(name, fn) { bus.set(name, fn); return () => { if (bus.get(name) === fn) bus.delete(name); }; }, emit: (name, value) => bus.get(name)?.(value) } };
  const ctx = { cwd, hasUI: true, mode: 'rpc', ui: { notify() {}, setStatus: (key, value) => calls.push([key, value]) }, isIdle: () => true, sessionManager: { getEntries: () => [] } };
  factory(pi);
  const emit = async name => { for (const fn of handlers.get(name) ?? []) await fn({ reason: name === 'session_start' ? 'startup' : 'quit' }, ctx); };
  const call = (name, args) => tools.get(name).execute('fixture', args, undefined, undefined, ctx);
  t.after(async () => { await emit('session_shutdown'); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, calls, call, emit, bus, status: () => calls.filter(([key]) => key === 'monitor').at(-1)?.[1], count: () => calls.filter(([key]) => key === 'monitor').length,
    settings: args => commands.get('monitor_settings').handler(args, ctx), source: () => createJob(cwd).fileSource };
}
async function until(predicate) { const end = Date.now() + 5000; while (Date.now() < end) { if (predicate()) return true; await new Promise(r => setTimeout(r, 10)); } return false; }
test('footer counts observations and disappears after the last observation ends', async t => {
  const h = harness(t); await h.emit('session_start'); assert.equal(h.count(), 0);
  const a = (await h.call('Monitor', { source: h.source(), description: 'first', persistent: true })).details; assert.equal(h.status(), '1 monitor');
  const b = (await h.call('Monitor', { source: h.source(), description: 'second', persistent: true })).details; assert.equal(h.status(), '2 monitors');
  await h.call('monitor_stop', { id: a.taskId }); assert.equal(h.status(), '1 monitor'); await h.call('monitor_stop', { id: b.taskId }); assert.equal(h.status(), undefined);
  await h.call('Monitor', { source: createJob(h.cwd, { state: 'succeeded' }).source, description: 'finished run' }); assert.ok(await until(() => h.status() === undefined));
});
test('output and listing do not repaint an unchanged footer count', async t => {
  const h = harness(t); await h.emit('session_start'); const job = createJob(h.cwd, { stdout: 'one\ntwo\n' });
  await h.call('Monitor', { source: job.fileSource, description: 'chatty', persistent: true }); const count = h.count();
  await new Promise(r => setTimeout(r, 600)); await h.call('monitor_list', {}); assert.equal(h.count(), count);
});
test('footer settings immediately affect the active observation count', async t => {
  const file = process.env.PI_CC_CONFIG_FILE, before = fs.readFileSync(file, 'utf8'); t.after(() => fs.writeFileSync(file, before));
  const h = harness(t); await h.emit('session_start'); await h.call('Monitor', { source: h.source(), description: 'first', persistent: true }); assert.equal(h.status(), '1 monitor');
  await h.settings('footer off'); assert.equal(h.status(), undefined); await h.call('Monitor', { source: h.source(), description: 'second', persistent: true }); assert.equal(h.status(), undefined);
  await h.settings('footer on'); assert.equal(h.status(), '2 monitors');
});
test('shutdown clears the footer without cancelling the source', async t => {
  const h = harness(t); await h.emit('session_start'); const source = h.source(); await h.call('Monitor', { source, description: 'active', persistent: true }); assert.equal(h.status(), '1 monitor');
  assert.equal(h.bus.has('loop:stopped'), true); assert.equal(h.bus.has('loop:adopt-observations'), true);
  assert.equal(h.bus.has('pi-cc:monitor:observation-link'), true);
  await h.emit('session_shutdown'); assert.equal(h.status(), undefined); assert.equal(fs.existsSync(source.stdout), true);
  assert.equal(h.bus.has('loop:stopped'), false); assert.equal(h.bus.has('loop:adopt-observations'), false);
  assert.equal(h.bus.has('pi-cc:monitor:observation-link'), false);
});
