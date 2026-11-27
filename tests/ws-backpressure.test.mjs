import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModule } from './helpers.mjs';
import test from 'node:test';
import { createHarness, until, sleep } from './runtime-harness.mjs';

const CAP = 4 * 1024 * 1024;
const { BoundedLog } = await loadModule('bounded-log.ts');

/** A stand-in for WebSocket: records instances and delivers frames synchronously. */
function fakeWebSocket() {
	const sockets = [];
	class FakeWebSocket {
		constructor(url, protocols) {
			this.url = url; this.protocols = protocols; this.readyState = 1;
			this.listeners = new Map(); sockets.push(this);
		}
		addEventListener(name, fn) {
			const hs = this.listeners.get(name) ?? []; hs.push(fn); this.listeners.set(name, hs);
		}
		emit(name, event) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
		close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
	}
	return { sockets, WebSocket: FakeWebSocket };
}

/** Replace the log stream with a Writable whose writes never complete (a blocked disk). */
function blockedLogs({ highWaterMark = 16384, error } = {}) {
	const construct = BoundedLog.prototype._construct, write = BoundedLog.prototype._write;
	const logs = [];
	BoundedLog.prototype._construct = function (callback) {
		this._writableState.highWaterMark = highWaterMark;
		logs.push({ stream: this, pending: undefined });
		construct.call(this, callback);
	};
	BoundedLog.prototype._write = function (_chunk, _encoding, callback) {
		const entry = logs.find((log) => log.stream === this);
		if (error) setTimeout(() => callback(error), 0);
		else entry.pending = callback; // the disk holds the callback until the test fails it
	};
	return { logs, restore() {
		BoundedLog.prototype._construct = construct;
		BoundedLog.prototype._write = write;
		for (const { stream } of logs) stream.destroy();
	} };
}

const warnings = (h) => h.sent.filter((m) => m.message.details.cause === 'output' && /Log incomplete/.test(m.message.content));

test('a blocked log caps its backlog at 4 MiB, warns once context-only, and the socket keeps observing frames', async (t) => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const logs = blockedLogs();
	const h = createHarness();
	t.after(async () => { await h.close(); logs.restore(); globalThis.WebSocket = saved; });
	await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example/feed' }, description: 'slow disk', persistent: true });
	assert.ok(await until(() => logs.logs.length === 1));
	const socket = fake.sockets[0];
	for (let i = 0; i < 10000; i++) socket.emit('message', { data: 'x'.repeat(500) });
	assert.ok(logs.logs[0].stream.writableLength <= CAP, 'the write backlog is capped');
	assert.ok(logs.logs[0].stream.destroyed, 'the stuck log is destroyed, not kept open');
	const state = (await h.snapshots())[0];
	assert.equal(state.status, 'running', 'the watch continues');
	assert.ok(state.logError, 'the degradation is visible in the snapshot');
	assert.equal(warnings(h).length, 1, 'exactly one warning');
	assert.equal(warnings(h)[0].options.triggerTurn, false, 'the warning never wakes the model');
	assert.equal(warnings(h)[0].message.details.notifyLevel, 'context');
	// Later frames are still observed as events; blank heartbeats still are not events.
	// Wait for the burst's own batch to flush first, so the probe frame gets its own batch.
	assert.ok(await until(() => h.sent.some((m) => m.message.details.eventCount >= 10000)));
	socket.emit('message', { data: 'after-degrade' });
	socket.emit('message', { data: '   ' });
	assert.ok(await until(() => h.sent.some((m) => m.message.details.lines?.includes('after-degrade'))));
	assert.equal(warnings(h).length, 1, 'later frames never warn again');
	assert.equal((await h.snapshots())[0].status, 'running');
	const list = await h.call('monitor_list', {});
	assert.match(list.content[0].text, /log incomplete/, 'the list shows the degraded log');
	// Stop cleans up without a second warning or a late write.
	assert.equal((await h.call('monitor_stop', { id: state.id })).details.stopped, true);
	await sleep(50);
	assert.equal(warnings(h).length, 1);
});

test('a single frame larger than the cap degrades the log immediately without queueing it', async (t) => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const logs = blockedLogs();
	const h = createHarness();
	t.after(async () => { await h.close(); logs.restore(); globalThis.WebSocket = saved; });
	await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example/feed' }, description: 'giant frame', persistent: true, notify: { output: 'none' } });
	assert.ok(await until(() => logs.logs.length === 1));
	fake.sockets[0].emit('message', { data: 'g'.repeat(CAP + 1) });
	assert.equal(logs.logs[0].stream.writableLength, 0, 'the giant frame is never queued');
	assert.ok(logs.logs[0].stream.destroyed);
	const state = (await h.snapshots())[0];
	assert.equal(state.status, 'running');
	assert.ok(state.logError);
	assert.equal(warnings(h).length, 1, 'the warning is visible even under output:none');
	assert.equal(warnings(h)[0].options.triggerTurn, false);
	assert.equal(state.eventCount, 0, 'the warning costs no event slot');
	assert.equal(state.suppressedCount, 0);
	// Blank and normal frames after degradation neither write nor warn.
	fake.sockets[0].emit('message', { data: '' });
	fake.sockets[0].emit('message', { data: 'later' });
	await sleep(300);
	assert.equal(warnings(h).length, 1);
	assert.equal((await h.snapshots())[0].status, 'running');
});

test('an async log write error degrades once; a later destroy error never warns twice', async (t) => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const logs = blockedLogs({ error: new Error('disk full') });
	const h = createHarness();
	t.after(async () => { await h.close(); logs.restore(); globalThis.WebSocket = saved; });
	await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example/feed' }, description: 'broken disk', persistent: true });
	assert.ok(await until(() => logs.logs.length === 1));
	const socket = fake.sockets[0];
	socket.emit('message', { data: 'first' });
	assert.ok(await until(() => warnings(h).length === 1));
	assert.match(warnings(h)[0].message.content, /log write failed: disk full/);
	assert.match((await h.snapshots())[0].logError, /disk full/);
	assert.equal((await h.snapshots())[0].status, 'running', 'a log failure does not end the watch');
	socket.emit('message', { data: 'second' });
	logs.logs[0].stream.emit('error', new Error('late destroy error'));
	await sleep(50);
	assert.equal(warnings(h).length, 1, 'no duplicate warning from a late error');
});

test('write() returning false is ordinary backpressure, not degradation', async (t) => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const logs = blockedLogs({ highWaterMark: 16 });
	const h = createHarness();
	t.after(async () => { await h.close(); logs.restore(); globalThis.WebSocket = saved; });
	await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example/feed' }, description: 'small watermark', persistent: true, notify: { output: 'none' } });
	assert.ok(await until(() => logs.logs.length === 1));
	for (let i = 0; i < 10; i++) fake.sockets[0].emit('message', { data: 'x'.repeat(100) });
	assert.equal(logs.logs[0].stream.destroyed, false, 'below the cap the log keeps writing');
	assert.equal(logs.logs[0].stream.writableLength, 10 * 101);
	const state = (await h.snapshots())[0];
	assert.equal(state.logError, undefined);
	assert.equal(warnings(h).length, 0);
	assert.equal(state.status, 'running');
});

test('a healthy log still writes every frame and flushes on natural close', async (t) => {
	const saved = globalThis.WebSocket;
	const savedConstruct = BoundedLog.prototype._construct;
	const streams = [];
	BoundedLog.prototype._construct = function (callback) { streams.push(this); savedConstruct.call(this, callback); };
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const h = createHarness();
	t.after(async () => { await h.close(); BoundedLog.prototype._construct = savedConstruct; globalThis.WebSocket = saved; });
	const armed = await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example/feed' }, description: 'healthy log', persistent: true, notify: { output: 'none' } });
	assert.ok(await until(() => streams.length === 1));
	fake.sockets[0].emit('message', { data: 'frame one' });
	fake.sockets[0].emit('message', { data: '' });
	fake.sockets[0].emit('message', { data: 'frame two' });
	fake.sockets[0].close();
	assert.equal(streams[0].writableEnded, true, 'natural close still ends the log');
	assert.ok(await until(() => fs.readFileSync(armed.details.outputPath, 'utf8') === 'frame one\n\nframe two\n'));
	assert.equal(warnings(h).length, 0);
	const state = (await h.snapshots())[0];
	assert.equal(state.status, 'exited');
	assert.equal(state.logError, undefined);
});
test('a late disk-callback failure after the watch ended reports an incomplete log, never continued observation', async (t) => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const logs = blockedLogs();
	const h = createHarness();
	t.after(async () => { await h.close(); logs.restore(); globalThis.WebSocket = saved; });
	for (const end of ['natural-close', 'stop']) {
		const before = warnings(h).length;
		const armed = await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example/feed' }, description: end, persistent: true, notify: { output: 'none' } });
		assert.ok(await until(() => logs.logs.length === before + 1));
		const socket = fake.sockets.at(-1);
		const log = logs.logs.at(-1);
		socket.emit('message', { data: 'queued frame' });
		assert.ok(await until(() => typeof log.pending === 'function'), 'the mocked disk actually has a pending write');
		assert.equal(warnings(h).length, before);
		if (end === 'natural-close') socket.close();
		else assert.equal((await h.call('monitor_stop', { id: armed.details.taskId })).details.stopped, true);
		assert.equal(log.stream.writableEnded, true, 'the healthy close still ends the log');
		// A real late failure: the disk fails the pending _write callback only after end().
		log.pending(new Error('EIO from pending disk write'));
		assert.ok(await until(() => warnings(h).length === before + 1));
		const warning = warnings(h)[before];
		assert.match(warning.message.content, /EIO from pending disk write|observation log flush timed out/);
		assert.match(warning.message.content, /buffered writes may be missing/);
		assert.doesNotMatch(warning.message.content, /The watch continues/, 'an ended watch never claims continuation');
		assert.equal(warning.options.triggerTurn, false, 'still one context-only warning, no wakeup');
		assert.equal(warning.message.details.notifyLevel, 'context');
		const state = (await h.snapshots()).find((m) => m.id === armed.details.taskId);
		assert.equal(state.status, end === 'natural-close' ? 'exited' : 'stopped');
		assert.equal(state.resourceActive, undefined, 'the resource stays released');
		assert.match(state.logError, /EIO|flush timed out/);
		assert.equal(state.eventCount, 0, 'the warning costs no event slot');
		assert.equal(h.sent.filter((m) => m.message.details.monitorId === armed.details.taskId && ['closed', 'stopped'].includes(m.message.details.cause)).length, 1, 'no second closing notice');
		// A later error on the destroyed stream never warns twice.
		log.stream.emit('error', new Error('late destroy error'));
		await sleep(20);
		assert.equal(warnings(h).length, before + 1);
	}
});
