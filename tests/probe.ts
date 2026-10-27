import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { commandOf, filesOf, look, task, uptime } from "../hooks/activity.ts";

const NOW = uptime();
const WRAPPER = "source /dev/null && eval 'sleep 5' && pwd -P >| /dev/null";
const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

test("a vanished pid is skipped", () => {
	const pid = Number(execFileSync("sh", ["-c", "true & echo $!; wait"], { encoding: "utf8" }));
	assert.deepEqual(look(pid, NOW, "", new Map()), [null, [], 0]);
	assert.equal(task(pid, NOW, "/x/tasks/t.output", new Map()), null);
});

test("a sandboxed bash call reads as its shell", async () => {
	assert.equal(
		commandOf(["bwrap", "--new-session", "--die-with-parent", "--", "/usr/bin/bash", "-c", WRAPPER]),
		"sleep 5",
	);
	assert.equal(commandOf(["/bin/zsh", "-c", "-l", WRAPPER]), "sleep 5");
	if (!has("bwrap")) return;
	const p = spawn(
		"bwrap",
		[
			"--die-with-parent",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--",
			"/usr/bin/bash",
			"-c",
			WRAPPER,
		],
		{ stdio: "ignore" },
	);
	try {
		let t = null;
		for (let i = 0; i < 50; i++) {
			t = task(p.pid as number, NOW, "/x/tasks/t.output", new Map());
			if (t?.procs.some((x) => x.args === "sleep 5")) break;
			await sleep(100);
		}
		if (p.exitCode !== null) return;
		assert.equal(t?.cmd, "sleep 5");
		assert.deepEqual(
			t?.procs.map((x) => x.args),
			["bash", "sleep 5"],
		);
	} finally {
		p.kill("SIGKILL");
	}
});

test("a file on a mount of another namespace is not statted", () => {
	const dir = mkdtempSync(join(tmpdir(), "activity-"));
	const path = join(dir, "held");
	const fd = openSync(path, "w+");
	try {
		writeSync(fd, "x".repeat(100));
		const mnt = /^mnt_id:\s*(\d+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1] as string;
		const [files] = filesOf(process.pid, null, new Map([[mnt, true]]));
		const held = files.filter((x) => x.path === path);
		assert.equal(held.length, 1);
		assert.equal(held[0]?.size, null);
	} finally {
		closeSync(fd);
		rmSync(dir, { recursive: true });
	}
});
