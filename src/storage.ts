import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Exclusive creation also prevents a pre-existing temporary symlink from being followed. */
export function atomicWrite(path: string, content: string, mode = 0o600): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp.${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", mode);
		writeFileSync(fd, content, "utf8");
		if (process.platform !== "win32") fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch { /* The temporary file may not have been created. */ }
		throw error;
	}
	if (process.platform !== "win32") {
		let directoryFd: number | undefined;
		try {
			directoryFd = openSync(dir, "r");
			fsyncSync(directoryFd);
		} catch (error) {
			// Some filesystems do not support directory fsync. Other errors are real failures.
			if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		} finally {
			if (directoryFd !== undefined) closeSync(directoryFd);
		}
	}
}
