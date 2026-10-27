#!/usr/bin/env node
/**
 * agent-grid's activity probe: what the session's shells are doing, once a second.
 *
 * A Claude Code task shell is a child of the session's process that holds `.../tasks/<id>.output` open (on its stdout or
 * stderr, or parked on a higher fd while a redirect of its own runs): every Bash call, foreground or background, and every
 * Monitor. For each one, one JSON line a second on stdout: its task id, the command it runs, its output's newest lines,
 * and the processes under it with their state, their CPU over the last second, the bytes they have read and written (and
 * per second), and the files they hold open (how, where in them, their size). It reads /proc only, starts nothing, and
 * ends with its parent (the session) or the pipe.
 *
 * `activity.ts [pid]` watches that pid's shells instead of its parent's (a check by hand).
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Clock ticks per second in /proc/<pid>/stat; USER_HZ is 100 on every Linux build that matters. */
const HZ = 100;
const TASK = /\/tasks\/([^/]+)\.output$/;
const EVAL = /&& eval '([\s\S]*)'(?: < \/dev\/null)? && pwd -P >\| \S+$/;
const NOT_FILES = ["/dev/", "/proc/", "/sys/", "/memfd:", "/dmabuf:", "/SYSV"];
const REMOTE = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "ceph", "glusterfs", "afs", "davfs", "sshfs"]);
const TAIL_BYTES = 4096;
const TAIL_LINES = 6;
const MAX_FILES = 8;
const MAX_PROCS = 24;

type Mounts = Map<string, boolean>;
type File = { path: string; mode: string; pos: number; size: number | null };
type Proc = {
	pid: number;
	args: string;
	state: string;
	cpu: number;
	rd: number;
	wr: number;
	rdps: number;
	wrps: number;
	files: File[];
	nfiles: number;
	root?: boolean;
};
type Task = { id: string; cmd: string | null; age: number; tail: string[]; procs: Proc[]; more: number };

const seen = new Map<number, [number, number, number, number]>();
const utf8 = new TextDecoder();

function read(path: string): string | null {
	try {
		return utf8.decode(readFileSync(path));
	} catch {
		return null;
	}
}

/** A link target as text that is surely UTF-8: a name in another encoding gets U+FFFD where it isn't. */
function link(path: string): string | null {
	try {
		return utf8.decode(readlinkSync(path, { encoding: "buffer" }));
	} catch {
		return null;
	}
}

function list(path: string): string[] | null {
	try {
		return readdirSync(path);
	} catch {
		return null;
	}
}

/** Seconds since boot, the clock /proc/<pid>/stat's start time counts on. */
export function uptime(): number {
	return Number((read("/proc/uptime") ?? "0").split(" ")[0]);
}

/** A process's mounts: mount id -> whether a stat on it can hang (network, FUSE). */
export function mountTable(pid: number | "self"): Mounts {
	const table: Mounts = new Map();
	for (const row of (read(`/proc/${pid}/mountinfo`) ?? "").split("\n")) {
		if (!row) continue;
		const at = row.indexOf(" - ");
		const fstype = (at < 0 ? "" : row.slice(at + 3)).split(" ")[0] ?? "";
		table.set(row.split(" ")[0] ?? "", REMOTE.has(fstype) || fstype.startsWith("fuse"));
	}
	return table;
}

function children(pid: number): number[] {
	const kids: number[] = [];
	for (const t of list(`/proc/${pid}/task`) ?? []) {
		for (const k of (read(`/proc/${pid}/task/${t}/children`) ?? "").split(/\s+/)) if (k) kids.push(Number(k));
	}
	return kids;
}

/**
 * The task output file this process holds: on stdout, else stderr, else where a shell parks them (fd 10 and up)
 * while a redirect of its own runs (`{ ...; } > log 2>&1`). A reader of the file (agent-grid's own `tail`, Grep's rg)
 * holds it on a low fd: not a task. null when it holds none.
 */
function outputOf(pid: number): string | null {
	const fds = list(`/proc/${pid}/fd`);
	if (!fds) return null;
	const parked = fds.filter((f) => /^\d+$/.test(f) && Number(f) >= 10).sort((a, b) => Number(a) - Number(b));
	for (const fd of ["1", "2", ...parked]) {
		const target = link(`/proc/${pid}/fd/${fd}`);
		if (target && TASK.test(target)) return target;
	}
	return null;
}

/**
 * The shell and the script of a `<shell> -c [-l] <script>` argv, or of the one the Bash tool's sandbox ends bwrap's
 * own argv with (`bwrap ... -- <shell> -c <script>`); [null, null] for any other.
 */
export function shellOf(argv: string[]): [string | null, string | null] {
	let c = -1;
	argv.slice(0, -1).forEach((a, k) => {
		if (a === "-c") c = k;
	});
	return c > 0 ? [argv[c - 1] ?? null, argv.at(-1) ?? null] : [null, null];
}

/** The command a Bash call runs, out of its shell's argv; null for any other shell (a Monitor's). */
export function commandOf(argv: string[]): string | null {
	const m = EVAL.exec(shellOf(argv)[1] ?? "");
	return m?.[1]?.replaceAll(`'"'"'`, "'") ?? null;
}

function tail(path: string): string[] {
	let data: string;
	let start: number;
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			start = Math.max(0, size - TAIL_BYTES - 1);
			const buf = Buffer.alloc(size - start);
			const n = readSync(fd, buf, 0, buf.length, start);
			data = utf8.decode(buf.subarray(0, n));
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
	let lines = data.split("\n");
	if (start > 0) {
		const part = lines[0] ?? "";
		lines = lines.slice(1);
		if (!lines.some((line) => line.trim()) && part.trim())
			lines = [`…${part.slice(part.lastIndexOf("\r") + 1).slice(-300)}`];
	}
	const out: string[] = [];
	for (const line of lines) {
		const last = line
			.split("\r")
			.filter((p) => p.trim())
			.at(-1);
		if (last !== undefined) out.push(last.trimEnd());
	}
	return out.slice(-TAIL_LINES);
}

/** The regular files and directories it holds open, the first MAX_FILES of them, and how many it holds. */
export function filesOf(pid: number, out: string | null, mounts: Mounts): [File[], number] {
	const files: File[] = [];
	let count = 0;
	const fds = list(`/proc/${pid}/fd`);
	if (!fds) return [files, count];
	for (const fd of fds.sort((a, b) => Number(a) - Number(b))) {
		const target = link(`/proc/${pid}/fd/${fd}`);
		if (!target?.startsWith("/") || NOT_FILES.some((p) => target.startsWith(p)) || target === out) continue;
		if (fd === "0" && target.endsWith(" (deleted)")) continue;
		const info = read(`/proc/${pid}/fdinfo/${fd}`) ?? "";
		const mnt = /^mnt_id:\s*(\d+)/m.exec(info)?.[1];
		if (mnt && !mounts.has(mnt)) for (const [k, v] of mountTable(pid)) mounts.set(k, v);
		const flags = Number.parseInt(/^flags:\s*([0-7]+)/m.exec(info)?.[1] ?? "0", 8);
		let size: number | null = null;
		let mode: string | null = flags & 0o200000 ? "dir" : null;
		if (!((mnt === undefined ? undefined : mounts.get(mnt)) ?? true)) {
			let st: ReturnType<typeof statSync> | null = null;
			try {
				st = statSync(`/proc/${pid}/fd/${fd}`);
			} catch {}
			if (st?.isDirectory()) mode = "dir";
			else if (st?.isFile()) size = st.size;
			else if (st) continue;
		}
		count++;
		if (files.length >= MAX_FILES) continue;
		const pos = /^pos:\s*(\d+)/m.exec(info)?.[1];
		const access = flags & 3;
		mode ??= access === 1 ? "w" : access === 2 ? "rw" : "r";
		files.push({ path: target, mode, pos: pos ? Number(pos) : 0, size });
	}
	return [files, count];
}

const argvOf = (raw: string) => raw.replace(/\0+$/, "").split("\0");

export function look(pid: number, now: number, out: string | null, mounts: Mounts): [Proc | null, string[], number] {
	const raw = read(`/proc/${pid}/stat`);
	const rawArgv = read(`/proc/${pid}/cmdline`);
	if (!raw || rawArgv === null) return [null, [], 0];
	const rest = raw
		.slice(raw.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const state = rest[0] ?? "";
	const ticks = Number(rest[11]) + Number(rest[12]);
	const born = Number(rest[19]) / HZ;
	const io = new Map<string, number>();
	for (const row of (read(`/proc/${pid}/io`) ?? "").split("\n")) {
		const at = row.indexOf(":");
		if (at < 0) continue;
		const value = row.slice(at + 1).trim();
		io.set(row.slice(0, at), /^\d+$/.test(value) ? Number(value) : 0);
	}
	const rd = io.get("rchar") ?? 0;
	const wr = io.get("wchar") ?? 0;
	const was = seen.get(pid) ?? [born, 0, 0, 0];
	seen.set(pid, [now, ticks, rd, wr]);
	const dt = now - was[0];
	const argv = argvOf(rawArgv);
	const comm = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
	const [files, nfiles] = filesOf(pid, out, mounts);
	const proc: Proc = {
		pid,
		args: [...argv.join(" ")].slice(0, 400).join("") || `[${comm}]`,
		state,
		cpu: dt > 0 ? Math.round(((ticks - was[1]) / HZ / dt) * 100) : 0,
		rd,
		wr,
		rdps: dt > 0 ? Math.round((rd - was[2]) / dt) : 0,
		wrps: dt > 0 ? Math.round((wr - was[3]) / dt) : 0,
		files,
		nfiles,
	};
	return [proc, argv, born];
}

export function task(root: number, now: number, out: string, mounts: Mounts): Task | null {
	const procs: Proc[] = [];
	const [top, argv, born] = look(root, now, out, mounts);
	if (!top) return null;
	const [shell, script] = shellOf(argv);
	const name = basename(shell ?? argv[0] ?? "") || "sh";
	const wrapper = (its: string[]) =>
		(its.length === argv.length && its.every((a, k) => a === argv[k])) ||
		(script !== null && shellOf(its)[1] === script);
	top.args = name;
	top.root = true;
	procs.push(top);
	let more = 0;
	const stack = children(root);
	while (stack.length) {
		const pid = stack.shift() as number;
		const kids = children(pid);
		stack.unshift(...kids);
		if (procs.length > MAX_PROCS) {
			if (!kids.length || !wrapper(argvOf(read(`/proc/${pid}/cmdline`) ?? ""))) more++;
			continue;
		}
		const [proc, its] = look(pid, now, out, mounts);
		if (!proc) continue;
		if (wrapper(its)) {
			if (kids.length) continue;
			proc.args = `${name} (subshell)`;
		}
		procs.push(proc);
	}
	const id = TASK.exec(out)?.[1] ?? "";
	return { id, cmd: commandOf(argv), age: Math.round((now - born) * 10) / 10, tail: tail(out), procs, more };
}

async function main() {
	const watch = process.argv[2] ? Number(process.argv[2]) : undefined;
	const host = watch ?? process.ppid;
	process.stdout.on("error", () => process.exit(0));
	for (;;) {
		if (watch === undefined && process.ppid !== host) return;
		const now = uptime();
		const mounts = mountTable("self");
		const tasks: Task[] = [];
		for (const kid of children(host)) {
			const out = kid !== process.pid ? outputOf(kid) : null;
			const t = out ? task(kid, now, out, mounts) : null;
			if (t) tasks.push(t);
		}
		const alive = new Set(tasks.flatMap((t) => t.procs.map((p) => p.pid)));
		for (const pid of [...seen.keys()]) if (!alive.has(pid)) seen.delete(pid);
		process.stdout.write(`${JSON.stringify({ tasks })}\n`);
		await sleep(1000);
	}
}

if (import.meta.main) {
	process.on("SIGINT", () => process.exit(0));
	await main();
}
