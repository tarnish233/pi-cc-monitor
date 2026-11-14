import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModule } from './helpers.mjs';

const factory = (await loadModule('index.ts')).default;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}
export const groupAlive = (pid) => { try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
export function createHarness({ idle = true, loop = false, send } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-contract-'));
  const tools = new Map(), handlers = new Map(), bus = new Map(), sent = [], statuses = [];
  const pi = {
    registerTool(t) { tools.set(t.name, t); },
    registerCommand() {}, registerMessageRenderer() {}, registerToolRenderer() {}, appendEntry() {},
    getCommands() { return []; },
    getAllTools() { return [...tools.keys(), ...(loop ? ['cron_delete'] : [])].map((name) => ({ name })); },
    on(name, handler) { const h = handlers.get(name) ?? []; h.push(handler); handlers.set(name, h); return () => h.splice(h.indexOf(handler), 1); },
    sendMessage(message, options) { send?.(message, options); sent.push({ message, options }); },
    events: {
      on(name, handler) { const h = bus.get(name) ?? []; h.push(handler); bus.set(name, h); return () => h.splice(h.indexOf(handler), 1); },
      emit(name, data) { for (const h of [...(bus.get(name) ?? [])]) void h(data); },
    },
  };
  const ctx = { cwd, hasUI: false, mode: 'print', isIdle: () => idle,
    ui: { notify() {}, setStatus(key, value) { statuses.push({ key, value }); } },
    sessionManager: { getEntries: () => [] }, hasPendingMessages: () => false };
  factory(pi);
  return { pi, ctx, tools, handlers, sent, statuses, cwd,
    setIdle(v) { idle = v; },
    call(name, params) { return tools.get(name).execute('test-call', params, undefined, undefined, ctx); },
    async emit(name, data = {}) { for (const h of [...(handlers.get(name) ?? [])]) await h(data, ctx); },
    async emitBus(name, data = {}) { await Promise.all([...(bus.get(name) ?? [])].map((h) => h(data))); },
    async close() { await this.emit('session_shutdown', { reason: 'quit' }); fs.rmSync(cwd, { recursive: true, force: true }); },
    async snapshots() { return (await this.call('monitor_list', {})).details.monitors; },
  };
}
export async function startReady(h, extra = {}) {
  const code = "process.on('SIGTERM',()=>{});process.stdout.write('READY\\n');setInterval(()=>{},1000)";
  const result = await h.call('Monitor', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`, description: 'owned resource', mode: 'completion', persistent: true, ...extra });
  if (!await until(() => fs.existsSync(result.details.outputPath) && fs.readFileSync(result.details.outputPath, 'utf8').includes('READY'))) throw Error('Owned fixture never became ready');
  const record = (await h.snapshots()).find((r) => r.id === result.details.taskId);
  return { ...result.details, pid: record.pid };
}
