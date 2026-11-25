/** Bounded disk logging, independent of event observation and process lifetime.
 * Each stream keeps two equal-size segments: <file>.1 then <file>.
 * Rotation never grows past maxBytes, including the archive. Discarding old
 * bytes is reported once; disk failures are ordinary Writable errors.
 */
import fs from "node:fs";
import { Writable } from "node:stream";

export interface BoundedLogOptions {
	maxBytes: number;
	fd?: number;
	onTruncate?: () => void;
}
const OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);

export class BoundedLog extends Writable {
	private fd: number | undefined;
	private size = 0;
	private trimmed = false;
	private readonly segmentBytes: number;
	constructor(private readonly file: string, private readonly options: BoundedLogOptions) {
		super();
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2) throw new Error("log maxBytes must be an integer >= 2");
		this.segmentBytes = Math.floor(options.maxBytes / 2);
		this.fd = options.fd;
	}
	override _construct(callback: (error?: Error | null) => void): void {
		const ready = (error: NodeJS.ErrnoException | null, fd?: number) => {
			if (error) { callback(error); return; }
			this.fd = fd;
			try {
				const stat = fs.fstatSync(fd!);
				if (!stat.isFile() || stat.size > this.segmentBytes) throw new Error("log is not an empty or bounded regular file");
				this.size = stat.size;
				callback();
			} catch (e) { callback(e as Error); }
		};
		if (this.fd !== undefined) ready(null, this.fd);
		else fs.open(this.file, OPEN_FLAGS, 0o600, ready);
	}
	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		void this.writeChunk(chunk).then(() => callback(), (e: Error) => callback(e));
	}
	private ensureWritable(): void {
		if (this.destroyed) throw new Error("log was destroyed");
	}
	private async writeChunk(chunk: Buffer): Promise<void> {
		let offset = 0;
		while (offset < chunk.length) {
			this.ensureWritable();
			if (this.size >= this.segmentBytes) await this.rotate();
			this.ensureWritable();
			const length = Math.min(chunk.length - offset, this.segmentBytes - this.size);
			const written = await new Promise<number>((resolve, reject) => {
				fs.write(this.fd!, chunk, offset, length, null, (error, bytes) => error ? reject(error) : resolve(bytes));
			});
			if (written <= 0) throw new Error("log write made no progress");
			offset += written;
			this.size += written;
		}
	}
	private async closeFile(): Promise<void> {
		const fd = this.fd;
		this.fd = undefined;
		if (fd === undefined) return;
		await new Promise<void>((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve()));
	}
	private async rotate(): Promise<void> {
		await this.closeFile();
		this.ensureWritable();
		const archive = this.file + ".1";
		let old: fs.Stats | undefined;
		try { old = await fs.promises.lstat(archive); } catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		this.ensureWritable();
		if (old) {
			if (!old.isFile() || old.isSymbolicLink()) throw new Error("refusing to replace a non-regular log archive");
			await fs.promises.unlink(archive);
			if (!this.trimmed) {
				this.trimmed = true;
				try { this.options.onTruncate?.(); } catch { /* accounting cannot break logging */ }
			}
		}
		this.ensureWritable();
		const current = await fs.promises.lstat(this.file);
		this.ensureWritable();
		if (!current.isFile() || current.isSymbolicLink()) throw new Error("refusing to rotate a non-regular log");
		await fs.promises.rename(this.file, archive);
		this.ensureWritable();
		const fd = await new Promise<number>((resolve, reject) => fs.open(this.file, OPEN_FLAGS | fs.constants.O_EXCL, 0o600, (e, fd) => e ? reject(e) : resolve(fd)));
		if (this.destroyed) {
			// _destroy may already have finished while open() was pending. Never
			// assign an fd that no future finalizer can see and close.
			await new Promise<void>((resolve) => fs.close(fd, () => resolve()));
			throw new Error("log was destroyed during rotation");
		}
		this.fd = fd;
		this.size = 0;
	}
	override _final(callback: (error?: Error | null) => void): void {
		void this.closeFile().then(() => callback(), (e: Error) => callback(e));
	}
	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		void this.closeFile().then(() => callback(error), (e: Error) => callback(error ?? e));
	}
}
export function createBoundedLog(file: string, options: BoundedLogOptions): BoundedLog {
	return new BoundedLog(file, options);
}
