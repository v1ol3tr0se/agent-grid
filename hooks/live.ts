import type { EngineInterface } from "claude-code";

import type { GridCard, GridLive, GridNow, GridProc } from "../types";
import { pollRun } from "./journal";
import { cards, claim, closed, inFlight, KEEP_LINES, lives, pending, seenAt, setLive, touch } from "./state";
import { clean, cut, firstLine, lastLine, oneLine, tilde } from "./text";

const TRAILER = /^\[(?:exited with code (\d+)|killed)\]$/;
const PENDING_MS = 60_000;

export type Block = {
	kind: GridNow["kind"];
	text: string;
	tool?: string;
	json: string;
	arg?: string;
	breaks: number;
	isEscaped: boolean;
};
const MAIN_ARG = /"(?:file_path|command|pattern|url|query|description|skill|prompt|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const PART_ARG = /"(?:file_path|command|pattern|url|query|description|skill|prompt|path)"\s*:\s*"((?:[^"\\]|\\.)*)\\?$/;
const unjson = (s: string) => {
	try {
		return String(JSON.parse(`"${s}"`));
	} catch {
		return s;
	}
};

export function watch(card: GridCard, blocks: Map<number, Block>, c: any) {
	if (typeof c?.index === "number" && blocks.size) {
		const was = blocks.get(c.index);
		const kind = c.kind === "input" ? "tool" : c.kind;
		if (c.index < Math.max(...blocks.keys()) || (was && c.kind !== "tool" && was.kind !== kind)) blocks.clear();
	}
	let now: GridNow | undefined;
	if (c?.kind === "thinking" || c?.kind === "text") {
		let b = blocks.get(c.index);
		if (!b) blocks.set(c.index, (b = { kind: c.kind, text: "", json: "", breaks: 0, isEscaped: false }));
		b.text = (b.text + String(c.text ?? "")).slice(-600);
		now = { kind: b.kind, text: tilde(lastLine(b.text)) };
	} else if (c?.kind === "tool") {
		blocks.set(c.index, { kind: "tool", tool: String(c.name ?? ""), text: "", json: "", breaks: 0, isEscaped: false });
		now = { kind: "tool", tool: firstLine(c.name), text: "" };
	} else if (c?.kind === "input") {
		const b = blocks.get(c.index);
		if (b?.kind !== "tool") return;
		const piece = String(c.json ?? "");
		if (b.tool === "Write")
			for (const ch of piece) {
				if (b.isEscaped) {
					if (ch === "n") b.breaks++;
					b.isEscaped = false;
				} else if (ch === "\\") b.isEscaped = true;
			}
		if (b.arg === undefined) {
			b.json += piece;
			const m = b.json.match(MAIN_ARG);
			if (m) b.arg = tilde(firstLine(unjson(m[1]!)));
			else if (b.json.length > 8192) b.arg = "";
		}
		const part = b.arg === undefined ? b.json.match(PART_ARG)?.[1] : undefined;
		const text = b.arg ?? (part ? `${tilde(firstLine(unjson(part)))}…` : "");
		now = { kind: "tool", tool: firstLine(b.tool), text, ...(b.breaks ? { lines: b.breaks + 1 } : {}) };
	} else if (c?.kind !== "stop") return;
	setLive(card, { now });
}

const lookedFor = new Map<string, [number, number]>();

async function pollShell($: EngineInterface, card: GridCard, now: number) {
	const [lookedAt, wait] = lookedFor.get(card.id) ?? [-Infinity, 5000];
	if (!card.path && card.taskId && now >= lookedAt + wait) {
		lookedFor.set(card.id, [now, Math.min(wait * 2, 120_000)]);
		const roots = [
			await $.env.get("CLAUDE_CODE_TMPDIR").catch(() => undefined),
			await $.env.get("TMPDIR").catch(() => undefined),
			"/tmp",
		];
		const dirs = new Set(roots.filter((root): root is string => Boolean(root)));
		const found = await $.process
			.run(["find", "-H", ...dirs, "-maxdepth", "5", "-path", `*/tasks/${card.taskId}.output`], { timeoutMs: 5000 })
			.catch(() => undefined);
		card.path = found?.stdout.split("\n").find(Boolean);
	}
	if (!card.path) return;
	const tail = await $.process.run(["tail", "-c", "65536", card.path], { timeoutMs: 3000 }).catch(() => undefined);
	if (!tail) return;
	const lines: string[] = tail.stdout.split("\n");
	if (new TextEncoder().encode(tail.stdout).length >= 65536) lines.shift();
	const out = lines
		.map((l) =>
			l
				.split("\r")
				.map(clean)
				.filter((p) => p.trim())
				.at(-1),
		)
		.filter((l): l is string => l !== undefined)
		.slice(-KEEP_LINES)
		.map((l) => cut(l, 300));
	const end = out.at(-1)?.match(TRAILER);
	if (end) {
		out.pop();
		card.status = end[1] === "0" ? "done" : "failed";
		card.note = end[1] === undefined ? "killed" : `exit ${end[1]}`;
	} else if (card.status !== "running") card.note = "";
	if (end || out.length !== card.lines.length || out[out.length - 1] !== card.lines[card.lines.length - 1]?.text) {
		card.lines = out.map((text) => ({ text }));
		touch();
	}
}

const procsOf = (t: any): GridProc[] =>
	(Array.isArray(t?.procs) ? t.procs : []).map((p: any) => {
		const files = (Array.isArray(p?.files) ? p.files : []).map((f: any) => ({
			path: cut(tilde(oneLine(f?.path)), 300),
			mode: String(f?.mode ?? "r"),
			pos: Number(f?.pos) || 0,
			...(typeof f?.size === "number" ? { size: f.size } : {}),
		}));
		return {
			pid: Number(p?.pid) || 0,
			args: cut(tilde(oneLine(p?.args)), 300),
			...(p?.root ? { root: true } : {}),
			state: String(p?.state ?? "").slice(0, 1),
			cpu: Number(p?.cpu) || 0,
			rd: Number(p?.rd) || 0,
			wr: Number(p?.wr) || 0,
			rdps: Number(p?.rdps) || 0,
			wrps: Number(p?.wrps) || 0,
			files,
			nfiles: Math.max(files.length, Number(p?.nfiles) || 0),
		};
	});
const liveOfTask = (t: any): GridLive => ({ procs: procsOf(t), more: Number(t?.more) || undefined });
export const ENDED: GridLive = { procs: undefined, more: undefined, tail: undefined };

function applyActivity(text: string, now: number) {
	let tasks: any[];
	try {
		tasks = JSON.parse(text)?.tasks;
	} catch {
		return;
	}
	if (!Array.isArray(tasks)) return;
	const byId = new Map(tasks.filter((t) => t?.id).map((t) => [String(t.id), t]));
	const taken = new Set<string>();
	for (const c of cards.values()) {
		if (c.kind !== "shell") continue;
		const t = c.status === "running" && c.taskId ? byId.get(c.taskId) : undefined;
		if (t) taken.add(String(t.id));
		setLive(c, t ? liveOfTask(t) : ENDED);
	}
	for (const call of inFlight) {
		if (call.taskId && !byId.has(call.taskId)) call.taskId = undefined;
		if (call.taskId) taken.add(call.taskId);
	}
	for (const call of inFlight) {
		if (call.taskId) continue;
		const t = tasks.find(
			(x) =>
				x?.id &&
				!taken.has(String(x.id)) &&
				typeof x.cmd === "string" &&
				x.cmd.trim() === call.command.trim() &&
				now - (Number(x.age) || 0) * 1000 >= call.since - 2000,
		);
		if (t) taken.add((call.taskId = String(t.id)));
	}
	const byCard = new Map<GridCard, any>();
	for (const call of inFlight) {
		const t = call.taskId ? byId.get(call.taskId) : undefined;
		if (t || !byCard.has(call.card)) byCard.set(call.card, t);
	}
	for (const [card, t] of byCard) {
		const tail =
			t && Array.isArray(t.tail) ? t.tail.map((l: unknown) => cut(tilde(oneLine(l)), 300)).filter(Boolean) : undefined;
		setLive(card, t ? { ...liveOfTask(t), tail } : ENDED);
	}
}

const wantsProbe = () =>
	inFlight.size > 0 || [...cards.values()].some((c) => c.kind === "shell" && c.status === "running");

let isProbeUp = false;
let probeRetryAt = 0;
let lastLookAt = 0;

async function runProbe($: EngineInterface) {
	if (isProbeUp || !wantsProbe() || (await $.clock.now()) < probeRetryAt) return;
	isProbeUp = true;
	lastLookAt = await $.clock.now();
	let idle = 0;
	let isDone = false;
	let buf = "";
	try {
		const child = $.process.spawn({ argv: ["node", `${$.plugin.root}/hooks/activity.ts`] });
		for await (const piece of child) {
			if (piece.stream !== "stdout") continue;
			buf += piece.text;
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				lastLookAt = await $.clock.now();
				applyActivity(buf.slice(0, nl), lastLookAt);
				buf = buf.slice(nl + 1);
			}
			idle = wantsProbe() ? 0 : idle + 1;
			if (idle > 3) {
				isDone = true;
				break;
			}
		}
	} catch {
	} finally {
		isProbeUp = false;
		applyActivity('{"tasks":[]}', 0);
	}
	if (!isDone) probeRetryAt = (await $.clock.now()) + 30_000;
}

export async function pollAll($: EngineInterface) {
	void runProbe($).catch(() => undefined);
	const now = await $.clock.now();
	if (isProbeUp && now - lastLookAt > 5000) for (const c of cards.values()) if (lives.get(c)?.procs) setLive(c, ENDED);
	for (const agentId of [...pending.keys()]) {
		const was = closed.get(agentId);
		if (was) {
			closed.delete(agentId);
			claim(agentId, agentId, { ...was, startedAt: now });
			continue;
		}
		const t = seenAt.get(agentId);
		if (t === undefined) seenAt.set(agentId, now);
		else if (now - t > PENDING_MS) {
			pending.delete(agentId);
			seenAt.delete(agentId);
		}
	}
	for (const card of [...cards.values()]) {
		if (card.kind === "shell" ? card.note !== undefined : card.status !== "running") continue;
		if (card.kind === "shell") await pollShell($, card, now);
		else if (card.kind === "workflow") await pollRun($, card);
	}
	if ([...cards.values()].some((c) => c.status === "running")) $.ui.invalidate("ui.render");
}
