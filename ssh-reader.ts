/** A fixed read-only SSH transport. Source paths are JSON data on stdin, never shell code. */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killTree, processGroupAlive, stopProcessGroup } from "./process.ts";
import { validateHost } from "./job-protocol.ts";
import { checkReadRequest, type FileSlice, type ReadRequest, type SourceReader } from "./source-reader.ts";

/** Python 3 is required on the observed host; nothing is installed or written there. */
export const REMOTE_READER = String.raw`import base64, errno, json, os, select, signal, stat, sys

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def alarm(signum, frame):
    raise TimeoutError('read deadline exceeded')

signal.signal(signal.SIGALRM, alarm)
emit({'ready': True, 'leaseSeconds': 10})
while True:
    # EOF or a lost client's bounded lease ends this reader, not the business job.
    if not select.select([sys.stdin], [], [], 10)[0]:
        break
    line = sys.stdin.readline(16385)
    if not line:
        break
    req = {}
    fd = None
    try:
        if len(line) > 16384 or not line.endswith('\n'):
            raise ValueError('invalid request length')
        req = json.loads(line)
        p = req['path']
        limit = req['maxBytes']
        offset = req.get('offset', 0)
        guard_size = req.get('guardBytes', 0)
        if not isinstance(p, str) or not p or '\x00' in p or len(p) > 4096:
            raise ValueError('invalid path')
        if type(limit) is not int or not 1 <= limit <= 65537 or type(offset) is not int or offset < 0 or type(guard_size) is not int or not 0 <= guard_size <= 64:
            raise ValueError('invalid read bounds')
        signal.alarm(8)
        root = req.get('root')
        if root is not None:
            if not isinstance(root, str) or not root or '\x00' in root:
                raise ValueError('invalid root')
            real_root = os.path.realpath(root)
            target = os.path.join(os.path.realpath(os.path.dirname(p)), os.path.basename(p))
            if os.path.commonpath([real_root, target]) != real_root:
                raise ValueError('job source escaped its manifest directory')
        fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError('source is not a regular file')
        if req.get('tail'):
            offset = max(0, st.st_size - limit)
        guard_size = min(guard_size, offset)
        guard = b''
        if guard_size:
            os.lseek(fd, offset - guard_size, os.SEEK_SET)
            guard = os.read(fd, guard_size)
        os.lseek(fd, offset, os.SEEK_SET)
        data = os.read(fd, min(limit, max(0, st.st_size - offset)))
        emit({'requestId': req['requestId'], 'identity': str(st.st_dev) + ':' + str(st.st_ino), 'size': st.st_size, 'offset': offset,
              'data': base64.b64encode(data).decode('ascii'), 'guard': base64.b64encode(guard).decode('ascii')})
    except Exception as exc:
        code = errno.errorcode.get(getattr(exc, 'errno', None), 'ETIMEDOUT' if isinstance(exc, TimeoutError) else 'EREAD')
        emit({'requestId': req.get('requestId'), 'error': code})
    finally:
        signal.alarm(0)
        if fd is not None:
            os.close(fd)
`;

function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
/** No user command, command prefix, remote cwd, interpreter or SSH option is accepted. */
export function sshReadCommand(): string { return `python3 -u -c ${shellQuote(REMOTE_READER)}`; }
const MAX_PACKET_CHARS = 128 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
interface Pending { id: number; request: ReadRequest; resolve(value: FileSlice): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class SshSourceReader implements SourceReader {
	private child?: ChildProcess;
	private closed = false;
	private pending?: Pending;
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private nextId = 0;
	private failures = 0;
	private retryAt = 0;
	constructor(private readonly host: string, private readonly onPid?: (pid: number | null) => void) { validateHost(host); }
	get pid(): number | undefined { return this.child?.pid; }
	get active(): boolean { return this.pending !== undefined || processGroupAlive(this.child); }
	private release(child: ChildProcess): void {
		if (this.child !== child || processGroupAlive(child)) return;
		this.child = undefined;
		this.onPid?.(null);
	}
	private fail(error: Error, stop = false): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending) { clearTimeout(pending.timer); pending.reject(error); }
		this.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
		if (stop && this.child) { const child = this.child; void stopProcessGroup(child).then(() => this.release(child)); }
	}
	private connect(): ChildProcess {
		if (this.closed) throw new Error("SSH observation reader is closed");
		if (this.child) {
			if (this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) return this.child;
			this.release(this.child);
			if (this.child) throw new Error("previous SSH observation cleanup is unconfirmed");
		}
		if (Date.now() < this.retryAt) throw new Error("SSH observation is reconnecting with bounded backoff");
		this.buffer = ""; this.decoder = new StringDecoder("utf8");
		const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", this.host, sshReadCommand()],
			{ stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
		this.child = child;
		if (child.pid) this.onPid?.(child.pid);
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
		child.stdin?.on("error", () => {
			if (this.child !== child || this.closed) return;
			this.fail(new Error("SSH observation input closed"), true);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (this.child !== child || this.closed) return;
			this.buffer += this.decoder.write(chunk);
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
				if (line.length > MAX_PACKET_CHARS) { this.fail(new Error("SSH observation packet exceeds its bound"), true); return; }
				this.packet(line);
			}
			if (this.buffer.length > MAX_PACKET_CHARS) this.fail(new Error("SSH observation packet exceeds its bound"), true);
		});
		child.on("error", (error: Error) => { if (this.child === child) this.fail(new Error(`SSH observation could not start: ${error.message}`), true); });
		child.on("close", (code, signal) => {
			if (this.child !== child) return;
			// Clean exit 0 with no pending request is the remote helper's normal 10s idle-lease expiry.
			if (!this.closed && (this.pending !== undefined || code !== 0 || signal !== null)) {
				this.fail(new Error(`SSH observation connection closed${stderr.trim() ? ': ' + stderr.trim().replace(/[\x00-\x1f\x7f]/g, ' ') : ''}`));
			}
			this.release(child);
			if (this.child === child) void stopProcessGroup(child).then(() => this.release(child));
		});
		return child;
	}
	private packet(line: string): void {
		let value: Record<string, unknown>;
		try { value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); }
		catch { this.fail(new Error("SSH observation received invalid protocol data"), true); return; }
		if (value.ready === true && value.leaseSeconds === 10) return;
		const pending = this.pending;
		if (!pending || value.requestId !== pending.id) return;
		if (typeof value.error === "string") {
			this.pending = undefined; clearTimeout(pending.timer);
			const error = new Error(`Remote file read failed: ${value.error.slice(0, 100)}`) as NodeJS.ErrnoException; error.code = value.error; pending.reject(error); return;
		}
		try {
			if (typeof value.identity !== "string" || value.identity.length > 128 || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
			if (typeof value.data !== "string" || typeof value.guard !== "string" || !BASE64.test(value.data) || !BASE64.test(value.guard)) throw new Error();
			const data = Buffer.from(value.data, "base64"), guard = Buffer.from(value.guard, "base64");
			if (data.length > pending.request.maxBytes || guard.length > 64) throw new Error();
			const expected = pending.request.tail ? Math.max(0, value.size - pending.request.maxBytes) : pending.request.offset ?? 0;
			if (value.offset !== expected) throw new Error();
			this.pending = undefined; clearTimeout(pending.timer); this.failures = 0; this.retryAt = 0;
			pending.resolve({ identity: value.identity, size: value.size, offset: value.offset, data, guard });
		} catch { this.fail(new Error("SSH observation received an invalid file slice"), true); }
	}
	read(request: ReadRequest): Promise<FileSlice> {
		checkReadRequest(request);
		if (this.pending) return Promise.reject(new Error("SSH reader permits one bounded request at a time"));
		let child: ChildProcess;
		try { child = this.connect(); } catch (error) { return Promise.reject(error); }
		const id = ++this.nextId;
		return new Promise<FileSlice>((resolve, reject) => {
			const timer = setTimeout(() => this.fail(new Error("SSH observation read timed out"), true), 10_000);
			this.pending = { id, request, resolve, reject, timer };
			child.stdin?.write(JSON.stringify({ ...request, requestId: id }) + "\n");
		});
	}
	closeNow(): void {
		this.closed = true; this.fail(new Error("SSH observation stopped"));
		this.child?.stdin?.end(); killTree(this.child, "SIGKILL");
	}
	async stop(force = false): Promise<boolean> {
		this.closed = true; this.fail(new Error("SSH observation stopped"));
		const child = this.child;
		if (!child) return true;
		child.stdin?.end();
		const gone = await stopProcessGroup(child, { force });
		if (gone) this.release(child);
		return gone;
	}
}
