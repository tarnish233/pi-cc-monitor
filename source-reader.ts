/** Read-only, bounded file operations. No runner control or shell execution. */
import fs from "node:fs";
import path from "node:path";

export const READ_CHUNK_BYTES = 64 * 1024;
export interface ReadRequest { path: string; maxBytes: number; offset?: number; tail?: boolean; guardBytes?: number; root?: string }
export interface FileSlice { identity: string; size: number; offset: number; data: Buffer; guard: Buffer }
export interface SourceReader {
	read(request: ReadRequest): Promise<FileSlice>;
	readonly active: boolean;
	readonly pid?: number;
	stop(force?: boolean): Promise<boolean>;
	closeNow(): void;
}
export function checkReadRequest(request: ReadRequest): void {
	if (!request || typeof request.path !== "string" || !request.path || request.path.includes("\0")) throw new Error("invalid file read path");
	if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > READ_CHUNK_BYTES + 1) throw new Error("invalid bounded read size");
	if (request.root !== undefined && (typeof request.root !== "string" || !request.root || request.root.includes("\0"))) throw new Error("invalid job source boundary");
	if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) throw new Error("invalid read offset");
	if (request.guardBytes !== undefined && (!Number.isSafeInteger(request.guardBytes) || request.guardBytes < 0 || request.guardBytes > 64)) throw new Error("invalid read guard");
}
export class LocalSourceReader implements SourceReader {
	private closed = false;
	private pending = new Set<Promise<unknown>>();
	get active(): boolean { return this.pending.size > 0; }
	read(request: ReadRequest): Promise<FileSlice> {
		checkReadRequest(request);
		if (this.closed) return Promise.reject(new Error("observation reader is closed"));
		const operation = this.readFile(request);
		this.pending.add(operation);
		void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
		return operation;
	}
	private async readFile(request: ReadRequest): Promise<FileSlice> {
		if (request.root) {
			const [root, parent] = await Promise.all([fs.promises.realpath(request.root), fs.promises.realpath(path.dirname(request.path))]);
			const relative = path.relative(root, path.join(parent, path.basename(request.path)));
			if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("job source escaped its manifest directory through a parent link");
		}
		// NONBLOCK prevents a substituted FIFO from blocking before fstat can reject it.
		const file = await fs.promises.open(request.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		try {
			const stat = await file.stat({ bigint: true });
			const size = Number(stat.size);
			if (!Number.isSafeInteger(size) || size < 0) throw new Error("source size exceeds the supported read range");
			if (!stat.isFile()) throw new Error("observation source must be a regular file, not a device or FIFO");
			if (this.closed) throw new Error("observation reader is closed");
			const offset = request.tail ? Math.max(0, size - request.maxBytes) : request.offset ?? 0;
			const guardSize = Math.min(request.guardBytes ?? 0, offset);
			let guard: Buffer = Buffer.alloc(guardSize);
			if (guardSize) {
				const r = await file.read(guard, 0, guardSize, offset - guardSize);
				guard = guard.subarray(0, r.bytesRead);
			}
			const data = Buffer.alloc(Math.min(request.maxBytes, Math.max(0, size - offset)));
			const result = data.length ? await file.read(data, 0, data.length, offset) : { bytesRead: 0 };
			if (this.closed) throw new Error("observation reader is closed");
			return { identity: `${stat.dev}:${stat.ino}`, size, offset, data: data.subarray(0, result.bytesRead), guard };
		} finally { await file.close(); }
	}
	closeNow(): void { this.closed = true; }
	async stop(): Promise<boolean> {
		this.closeNow();
		if (!this.active) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
		} finally { if (timer) clearTimeout(timer); }
		return !this.active;
	}
}
