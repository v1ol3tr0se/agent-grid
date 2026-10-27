import type { Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { GridCard, GridLine, GridLive, GridNow, GridProc, GridStatus } from "../types";

const cardsAtom = atom({ plugin: "agent-grid", key: "cards" } as const, [] as GridCard[]);
const liveAtom = atom({ plugin: "agent-grid", key: "live" } as const, {} as Record<string, GridLive>);
const bandAtom = atom({ plugin: "agent-grid", key: "band" } as const, false);
const viewAtom = atom({ plugin: "agent-grid", key: "view" } as const, { expanded: "", start: -1 });
const VIEW = "grid";
const COMMAND = "workflow";

const MODEL_COLOR: Record<string, string> = { opus: "claude", sonnet: "blue", haiku: "green", fable: "magenta" };
const colorFor = (card: GridCard) => {
	const worn = new Set([...cards.values()].filter((c) => c !== card && c.status === "running").map((c) => c.color));
	for (let n = 0; ; n++) if (!worn.has(nthColor(n))) return nthColor(n);
};
function nthColor(n: number): string {
	const hue = 40 + ((0.5 + n * 0.6180339887) % 1) * 290;
	const light = [0.7, 0.78, 0.62][Math.floor(n / 8) % 3] as number;
	const sat = 0.62;
	const k = (m: number) => (m + hue / 30) % 12;
	const f = (m: number) => light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1));
	return `rgb(${[0, 8, 4].map((m) => Math.round(f(m) * 255)).join(",")})`;
}
const frameColor = (c: GridCard) =>
	c.status === "failed" ? "error" : (c.color ?? ((c.model && MODEL_COLOR[c.model]) || "gray"));

const KEEP_LINES = 120;
const KEEP_CARDS = 96;
const TRAILER = /^\[(?:exited with code (\d+)|killed)\]$/;
const DEFAULT_AGENT_SECS = 170;
const WORKFLOW_RESIDUAL_SECS = 180;
const PENDING_MS = 60_000;
const PENDING_MAX = 64;
const JOURNAL_HEAD = 1000;
const HEAD = /^\{"type":"(\w+)"(?:,"key":"([^"]+)","agentId":"([^"]*)")?/;

const fmtRan = (s: number) =>
	s < 60
		? `${Math.floor(s)}s`
		: s < 3600
			? `${Math.floor(s / 60)}m`
			: `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
function runDoing(c: GridCard, nowMs: number): string {
	const quiet = (nowMs - (c.lastAt ?? c.startedAt ?? nowMs)) / 1000;
	const still = quiet >= 60 ? ` · nothing new for ${fmtRan(quiet)}` : "";
	const count = `${c.done ?? 0} of ${c.listed ?? 0} agents done`;
	if (c.note === "stopped") return `stopped · ${count}`;
	if (c.status !== "running") return count;
	if (!c.listed) return `starting: its script has not launched an agent yet${still}`;
	return `${c.phase ? `${c.phase}: ` : ""}${count} · its script picks what runs next${still}`;
}
const fmtLeft = (s: number) =>
	s < 60
		? `~${Math.max(5, Math.round(s / 5) * 5)}s`
		: s < 3600
			? `~${Math.round(s / 60)}m`
			: `~${Math.round(s / 3600)}h`;

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function remainingOf(card: GridCard, nowMs: number, all: readonly GridCard[]): number | undefined {
	if (card.kind !== "agent" || card.status !== "running" || card.startedAt === undefined) return undefined;
	const elapsed = Math.max(0, (nowMs - card.startedAt) / 1000);
	if (card.run !== undefined) {
		const longer = all
			.filter(
				(c) =>
					c.run === card.run &&
					c.phase === card.phase &&
					c.status === "done" &&
					c.startedAt !== undefined &&
					c.endedAt !== undefined,
			)
			.map((c) => ((c.endedAt ?? 0) - (c.startedAt ?? 0)) / 1000 - elapsed)
			.filter((s) => s > 30);
		if (longer.length) return Math.round(Math.max(60, median(longer)));
	}
	const left = (card.run !== undefined ? WORKFLOW_RESIDUAL_SECS : DEFAULT_AGENT_SECS) - elapsed;
	return left > 0 ? Math.round(left) : undefined;
}

const wellFormed = (s: string) =>
	s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
const cut = (s: string, n: number) => wellFormed(n >= 0 ? s.slice(0, n) : s.slice(n));
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const fit = (s: string, n: number) => {
	let cells = 0;
	let end = 0;
	for (const ch of s) {
		cells += WIDE.test(ch) ? 2 : 1;
		if (cells > n) return `${s.slice(0, end)}…`;
		if (cells < n) end += ch.length;
	}
	return s;
};
const clean = (s: unknown) =>
	wellFormed(
		String(s ?? "")
			.replace(/\t/g, "  ")
			.replace(
				/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b.|[\x00-\x08\x0b-\x1f\x7f-\x9f]|\u{10EEEE}/gu,
				"",
			),
	);
const firstLine = (s: unknown) =>
	cut(
		clean(s)
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? "",
		300,
	);
const lastLine = (s: unknown) =>
	cut(
		clean(s)
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.at(-1) ?? "",
		-300,
	);
const oneLine = (s: unknown) =>
	clean(s)
		.replace(/\s*\n\s*/g, " ⏎ ")
		.trim();
let home: string | undefined;
const tilde = (s: string) => (home ? s.split(`${home}/`).join("~/") : s);
const fmtBytes = (n: number) =>
	n < 1024
		? `${n} B`
		: n < 1 << 20
			? `${(n / 1024).toFixed(1)} KB`
			: n < 1 << 30
				? `${(n / (1 << 20)).toFixed(1)} MB`
				: `${(n / (1 << 30)).toFixed(2)} GB`;
const linesIn = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);
const shortModel = (m?: string) =>
	m
		? (m.match(/opus|sonnet|haiku|fable/)?.[0] ??
			fit(
				m
					.replace(/:[^:/]*$/, "")
					.split("/")
					.filter(Boolean)
					.at(-1) ?? m,
				12,
			))
		: undefined;
const used = (u: any): number | undefined =>
	u
		? (u.input_tokens ?? 0) +
			(u.cache_read_input_tokens ?? 0) +
			(u.cache_creation_input_tokens ?? 0) +
			(u.output_tokens ?? 0)
		: undefined;
const kTokens = (n?: number) => (!n ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const tallyOf = (stored: readonly GridCard[]) =>
	(["workflow", "agent", "shell"] as const)
		.map((kind) => [stored.filter((c) => c.kind === kind).length, kind] as const)
		.filter(([n]) => n > 0)
		.map(([n, kind]) => plural(n, kind))
		.join(" · ");

function spread(width: number, left: string, middle: string, right: string) {
	const lo = left ? left.length + 1 : 0;
	const hi = width - (right ? right.length + 1 : 0);
	let start = Math.floor((width - middle.length) / 2);
	if (start < lo || start + middle.length > hi) {
		const room = Math.max(0, hi - lo);
		if (middle.length > room) middle = room > 1 ? `${middle.slice(0, room - 1)}…` : "";
		start = lo + Math.floor((room - middle.length) / 2);
	}
	return `${left.padEnd(start)}${middle}`.padEnd(Math.max(0, width - right.length)) + right;
}
const commandOf = (command: unknown) => {
	if (typeof command !== "string") return {};
	const lines = clean(command)
		.split("\n")
		.filter((l) => l.trim());
	return {
		command: lines
			.slice(0, 60)
			.map((l) => cut(l, 300))
			.join("\n"),
		commandLines: lines.length,
	};
};
const callArg = (e: any) =>
	tilde(
		firstLine(e.command ?? e.file_path ?? e.pattern ?? e.url ?? e.query ?? e.description ?? e.skill ?? e.prompt ?? ""),
	);

function resultOf(tool: string, ran: any, input?: any): Pick<GridLine, "result" | "isError"> {
	if (ran?.deny) return { result: `denied: ${firstLine(ran.deny)}`, isError: true };
	const text = clean(ran?.text);
	const done = ran?.isError ? undefined : (ran?.result ?? {});
	if (tool === "Read" && done) {
		if (/contents are empty/.test(text)) return { result: "empty file" };
		const n = text.split("\n").length;
		return { result: `Read ${n} line${n === 1 ? "" : "s"}` };
	}
	if ((tool === "Write" || tool === "Edit") && done?.staged) return { result: "held for review, not written" };
	if (tool === "Write" && done && typeof (done.content ?? input?.content) === "string")
		return { result: `wrote ${plural(linesIn(done.content ?? input.content), "line")}` };
	if (tool === "Edit" && done) {
		const patch: string[] = Array.isArray(done.structuredPatch)
			? done.structuredPatch.flatMap((h: any) => (Array.isArray(h?.lines) ? h.lines : []))
			: [];
		const add = patch.filter((l) => typeof l === "string" && l.startsWith("+")).length;
		const del = patch.filter((l) => typeof l === "string" && l.startsWith("-")).length;
		if (add || del) return { result: `−${del} +${plural(add, "line")}${done.replaceAll ? ", every match" : ""}` };
		if (typeof input?.new_string === "string")
			return {
				result: `−${linesIn(input.old_string)} +${plural(linesIn(input.new_string), "line")}${input.replace_all ? ", every match" : ""}`,
			};
	}
	const first = firstLine(text);
	return {
		result: first === "(Bash completed with no output)" ? "(no output)" : first,
		isError: Boolean(ran?.isError),
	};
}

/** One agent of a run as its journal tells it: every attempt's loop id in order, label, phase and outcome. */
type JournalAgent = { agentIds: string[]; label: string; phase?: string; isDone: boolean; isFailed: boolean };

function parseJournal(text: string): Map<string, JournalAgent> {
	const agents = new Map<string, JournalAgent>();
	let isRestoring = false;
	for (const row of text.split("\n")) {
		const m = row.match(HEAD);
		if (!m) continue;
		const [, type, key, agentId] = m;
		if (type === "restoring" || type === "restored") {
			isRestoring = type === "restoring";
			continue;
		}
		if (isRestoring || !key) continue;
		let a = agents.get(key);
		if (type === "started") {
			let ev: any = {};
			try {
				ev = JSON.parse(row);
			} catch {
				ev = { label: row.match(/"label":"((?:[^"\\]|\\.)*)"/)?.[1] };
			}
			if (!a)
				agents.set(
					key,
					(a = { agentIds: [], label: firstLine(ev.label), phase: ev.phase, isDone: false, isFailed: false }),
				);
			else if (!a.label && ev.label) a.label = firstLine(ev.label);
			if (agentId && !a.agentIds.includes(agentId)) {
				a.agentIds.push(agentId);
				a.isDone = a.isFailed = false;
			}
		} else if (a && type === "result") a.isDone = true;
		else if (a && type === "failed") a.isFailed = true;
	}
	return agents;
}

const cards = new Map<string, GridCard>();
const owner = new Map<string, string>();
const pending = new Map<string, GridCard>();
const seenAt = new Map<string, number>();
const stale = new Set<string>();
const evicted = new Map<string, string | undefined>();
const closed = new Map<string, Pick<GridCard, "title" | "model" | "taskId">>();
const journalSize = new Map<string, number>();
const lookedFor = new Map<string, [number, number]>();
const inFlight = new Set<{ card: GridCard; command: string; since: number; taskId?: string }>();
const lives = new WeakMap<GridCard, GridLive>();
let liveDirty = false;
let isPublishingCards = false;
let isPublishingLive = false;
let isProbeUp = false;
let probeRetryAt = 0;
let lastLookAt = 0;
let dirty = false;
let isPolling = false;
let isTyping = false;
let isWatching = false;
let draftEpoch = 0;
let emptyReads = 0;
let isPinned = false;
let bandDrawn = false;
let isProbing = false;
let movesInFlight = 0;
let bandHasKeys = false;
let selectedKey: string | undefined;
const layouts = new Map<string, string[][]>();
let refocus: { site: string; key: string } | undefined;
let expandedId: string | undefined;
let expandedStart: number | undefined;
let expandedRows = 0;
let expandedRoom = 0;
let lastSite: string | undefined;
let gridTop = 0;
let gridTopKey: string | undefined;
const firstPage = () => {
	gridTop = 0;
	gridTopKey = undefined;
};
let isEngineWindow = false;

function setView($: any, id: string | undefined, start: number | undefined) {
	expandedId = id;
	expandedStart = start;
	return update($, viewAtom, () => ({ expanded: id ?? "", start: start ?? -1 }));
}

const touch = () => {
	dirty = true;
};
function setLive(card: GridCard, patch: GridLive) {
	let live = lives.get(card);
	if (!live) lives.set(card, (live = {}));
	let isChanged = false;
	for (const [k, v] of Object.entries(patch) as [keyof GridLive, any][]) {
		if (JSON.stringify(live[k]) === JSON.stringify(v)) continue;
		if (v === undefined) delete live[k];
		else (live as any)[k] = v;
		isChanged = true;
	}
	if (isChanged && cards.get(card.id) === card) liveDirty = true;
}
const add = (card: GridCard) => {
	card.color ??= colorFor(card);
	cards.set(card.id, card);
	for (const [id, c] of cards)
		if (cards.size > KEEP_CARDS && c.status !== "running" && !(c.kind === "workflow" && hasAgents(id))) close(id, c);
	touch();
};
function close(id: string, c: GridCard) {
	cards.delete(id);
	if (c.run) evicted.set(id, c.agentId);
	else if (c.kind === "agent") closed.set(c.agentId ?? id, { title: c.title, model: c.model, taskId: c.taskId });
	for (const [agentId, cardId] of owner) if (cardId === id) owner.delete(agentId);
}
const hasAgents = (runId: string) => [...cards.values()].some((c) => c.run === runId);
const wake = (card: GridCard) => {
	if (card.status === "running") return;
	card.status = "running";
	card.endedAt = undefined;
	if ([...cards.values()].some((c) => c !== card && c.status === "running" && c.color === card.color))
		card.color = colorFor(card);
};
const push = (card: GridCard, line: GridLine) => {
	card.lines.push(line);
	if (card.lines.length > KEEP_LINES) card.lines.splice(0, card.lines.length - KEEP_LINES);
	wake(card);
	touch();
};
const sinkOf = (agentId: string | undefined): GridCard | undefined => {
	if (!agentId || stale.has(agentId)) return undefined;
	const card = cards.get(owner.get(agentId) ?? "");
	if (card) return card;
	let waiting = pending.get(agentId);
	if (!waiting) {
		if (pending.size >= PENDING_MAX) {
			const oldest = pending.keys().next().value as string;
			pending.delete(oldest);
			seenAt.delete(oldest);
		}
		pending.set(agentId, (waiting = { id: agentId, kind: "agent", title: agentId, status: "running", lines: [] }));
	}
	return waiting;
};
const claim = (id: string, agentId: string, fields: Partial<GridCard>): GridCard => {
	const waiting = pending.get(agentId);
	pending.delete(agentId);
	seenAt.delete(agentId);
	let card = cards.get(id);
	if (!card) {
		card = waiting ?? { id, kind: "agent", title: agentId, status: "running", lines: [] };
		Object.assign(card, fields, { id, kind: "agent", agentId });
		add(card);
	} else {
		wake(card);
		Object.assign(card, fields, { agentId });
		setLive(card, { now: undefined });
		if (waiting) {
			for (const line of waiting.lines) push(card, line);
			card.model = waiting.model ?? card.model;
			card.tokens = waiting.tokens ?? card.tokens;
			const live = lives.get(waiting);
			if (live) setLive(card, { ...live });
			for (const call of inFlight) if (call.card === waiting) call.card = card;
		}
	}
	owner.set(agentId, id);
	if (lives.has(card)) liveDirty = true;
	touch();
	return card;
};

async function pollShell($: any, card: GridCard, now: number) {
	const [lookedAt, wait] = lookedFor.get(card.id) ?? [-Infinity, 5000];
	if (!card.path && card.taskId && now >= lookedAt + wait) {
		lookedFor.set(card.id, [now, Math.min(wait * 2, 120_000)]);
		const roots = [
			await $.env.get("CLAUDE_CODE_TMPDIR").catch(() => undefined),
			await $.env.get("TMPDIR").catch(() => undefined),
			"/tmp",
		];
		const found = await $.process
			.run(
				["find", "-H", ...new Set(roots.filter(Boolean)), "-maxdepth", "5", "-path", `*/tasks/${card.taskId}.output`],
				{ timeoutMs: 5000 },
			)
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

type Block = {
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

function watch(card: GridCard, blocks: Map<number, Block>, c: any) {
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

async function backfill($: any, card: GridCard, file: string) {
	const out = await $.process.run(["tail", "-c", "262144", file], { timeoutMs: 3000 }).catch(() => undefined);
	if (out?.exitCode !== 0 || card.lines.length) return;
	const rows = String(out.stdout).split("\n");
	if (rows.length > 1) rows.shift();
	const lines: GridLine[] = [];
	const calls = new Map<string, { line: GridLine; input: any }>();
	for (const row of rows) {
		let o: any;
		try {
			o = JSON.parse(row);
		} catch {
			continue;
		}
		const content = o?.message?.content;
		if (!Array.isArray(content)) continue;
		if (o.type === "assistant") {
			card.model ??= shortModel(o.message.model);
			const tokens = used(o.message.usage);
			if (tokens) card.tokens = Math.max(card.tokens ?? 0, tokens);
			for (const b of content) {
				if (b?.type === "tool_use") {
					const line: GridLine = { tool: String(b.name ?? ""), text: callArg(b.input ?? {}) };
					calls.set(b.id, { line, input: b.input });
					lines.push(line);
				} else if (b?.type === "text" && firstLine(b.text)) lines.push({ text: firstLine(b.text) });
			}
		} else if (o.type === "user") {
			for (const b of content) {
				const call = b?.type === "tool_result" ? calls.get(b.tool_use_id) : undefined;
				if (!call) continue;
				const text = Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? "").join(" ") : b.content;
				Object.assign(call.line, resultOf(call.line.tool ?? "", { text, isError: b.is_error }, call.input));
			}
		}
	}
	if (!lines.length || card.lines.length) return;
	card.lines = lines.slice(-KEEP_LINES);
	card.failed = lines.filter((l) => l.isError).length;
	touch();
}

async function pollRun($: any, run: GridCard) {
	const entries: any[] = await $.fs.list(run.path).catch(() => []);
	const entry = (name: string) => entries.find((e) => e.name === name);
	const size = entry("journal.jsonl")?.size;
	if (size === undefined || size === journalSize.get(run.id)) return;
	const out = await $.process
		.run(["cut", "-c", `1-${JOURNAL_HEAD}`, `${run.path}/journal.jsonl`], { timeoutMs: 5000 })
		.catch(() => undefined);
	if (out?.exitCode !== 0) return;
	journalSize.set(run.id, size);
	const now = await $.clock.now();
	const parsed = parseJournal(out.stdout);
	const finished = [...parsed.values()].filter((a) => a.isDone || a.isFailed).length;
	const phase = [...parsed.values()].at(-1)?.phase;
	run.lastAt = now;
	if (run.listed !== parsed.size || run.done !== finished || (phase && run.phase !== phase)) {
		run.listed = parsed.size;
		run.done = finished;
		if (phase) run.phase = phase;
		touch();
	}
	for (const [key, a] of parsed) {
		const agentId = a.agentIds.at(-1);
		if (!agentId) continue;
		const id = `wfa:${run.id.slice(3)}:${key.slice(3, 19)}`;
		const status: GridStatus | undefined = a.isDone ? "done" : a.isFailed ? "failed" : undefined;
		const born = entry(`agent-${agentId}.meta.json`)?.mtimeMs || undefined;
		const last = entry(`agent-${agentId}.jsonl`)?.mtimeMs || undefined;
		for (const old of a.agentIds.slice(0, -1)) {
			stale.add(old);
			owner.delete(old);
			pending.delete(old);
			seenAt.delete(old);
		}
		const retry = a.agentIds.length > 1 ? { note: `retry ${a.agentIds.length - 1}` } : {};
		let card = cards.get(id);
		if (!card) {
			if (evicted.get(id) === agentId) continue;
			if (status && now - (last ?? now) >= CLOSE_MS) {
				evicted.set(id, agentId);
				continue;
			}
			card = claim(id, agentId, {
				run: run.id,
				group: run.title,
				title: a.label || agentId,
				phase: a.phase,
				attempt: a.agentIds.length,
				startedAt: born ?? now,
				...retry,
			});
			if (!card.lines.length && entry(`agent-${agentId}.jsonl`))
				void backfill($, card, `${run.path}/agent-${agentId}.jsonl`);
		} else if (card.agentId !== agentId) {
			claim(id, agentId, { attempt: a.agentIds.length, ...retry });
		} else if (a.label && card.title !== a.label) {
			card.title = a.label;
			card.phase ??= a.phase;
			touch();
		}
		if (status && card.status !== status) {
			card.status = status;
			card.endedAt ??= last ?? now;
			touch();
		}
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
const ENDED: GridLive = { procs: undefined, more: undefined, tail: undefined };

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

async function runProbe($: any) {
	if (isProbeUp || !wantsProbe() || (await $.clock.now()) < probeRetryAt) return;
	isProbeUp = true;
	lastLookAt = await $.clock.now();
	let idle = 0;
	let isDone = false;
	let buf = "";
	try {
		const child = $.process.spawn({ argv: ["python3", `${$.plugin.root}/hooks/activity.py`] });
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

async function pollAll($: any) {
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

async function watchDraft($: any) {
	if (isWatching) return;
	isWatching = true;
	try {
		const epoch = draftEpoch;
		const draft = await $.prompt
			.read()
			.then((b: any) => String(b?.text ?? ""))
			.catch(() => undefined);
		if (draft === undefined || epoch !== draftEpoch) return;
		const typing = draft.trim() !== "";
		if (typing === isTyping) {
			emptyReads = 0;
			return;
		}
		if (!typing && sendWouldChange() && ++emptyReads < 2) return;
		emptyReads = 0;
		isTyping = typing;
		if (isTyping) bandHasKeys = false;
		if (isTyping && expandedId !== undefined) void setView($, undefined, undefined);
		$.ui.invalidate("ui.render");
	} finally {
		isWatching = false;
	}
}

async function syncTyping($: any) {
	draftEpoch++;
	const draft = await $.prompt
		.read()
		.then((b: any) => String(b?.text ?? ""))
		.catch(() => "");
	emptyReads = 0;
	if ((draft.trim() !== "") === isTyping) return;
	isTyping = !isTyping;
	$.ui.invalidate("ui.render");
}

async function setPinned($: any, pinned: boolean) {
	isPinned = pinned;
	await update($, bandAtom, () => pinned);
}

function publishCards($: any) {
	dirty = false;
	return update($, cardsAtom, () => [...cards.values()].map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l })) })));
}

function publishLive($: any) {
	liveDirty = false;
	return update($, liveAtom, () => {
		const all: Record<string, GridLive> = {};
		for (const c of cards.values()) {
			const live = lives.get(c);
			if (live && (live.now || live.procs || live.tail)) all[c.id] = JSON.parse(JSON.stringify(live));
		}
		return all;
	});
}

async function watchKeys($: any) {
	if (!bandHasKeys || !bandDrawn || !lastSite || isProbing || movesInFlight) return;
	const key = expandedId !== undefined ? `open:${expandedId}` : selectedKey;
	if (!key) return;
	isProbing = true;
	try {
		const r = await $.ui.focus({ requestId: lastSite, key }).catch(() => undefined);
		if (r?.deny !== "that site does not hold the keyboard") return;
		bandHasKeys = false;
		if (expandedId !== undefined) await setView($, undefined, undefined);
		$.ui.invalidate("ui.render");
	} finally {
		isProbing = false;
	}
}

const isClearable = (id: string, c: GridCard) =>
	c.status !== "running" &&
	!(c.run !== undefined && cards.get(c.run)?.status === "running") &&
	!(c.kind === "workflow" && [...cards.values()].some((a) => a.run === id && a.status === "running"));
const sendWouldChange = () => isPinned || expandedId !== undefined || [...cards].some(([id, c]) => isClearable(id, c));

const CLOSE_MS = 4000;
const STALE_MS = 10 * 60_000;
function closeFinished(now: number) {
	let isClosed = false;
	for (const [id, c] of cards)
		if (
			c.kind === "workflow" &&
			c.status === "running" &&
			now - (c.lastAt ?? c.startedAt ?? now) > STALE_MS &&
			![...cards.values()].some((a) => a.run === id && a.status === "running")
		) {
			c.status = "failed";
			c.note = "stopped";
			c.endedAt = now;
			isClosed = true;
		}
	for (const [id, c] of cards) {
		if (c.status === "running" || id === expandedId) continue;
		if (c.kind === "workflow" && [...cards.values()].some((a) => a.run === id && a.status === "running")) continue;
		if (c.endedAt === undefined) {
			c.endedAt = now;
			continue;
		}
		if (now - c.endedAt < CLOSE_MS) continue;
		close(id, c);
		isClosed = true;
	}
	if (isClosed) touch();
}

function clearFinished() {
	let isCleared = false;
	for (const [id, c] of cards) {
		if (!isClearable(id, c)) continue;
		close(id, c);
		isCleared = true;
	}
	if (isCleared) touch();
	return isCleared;
}

async function drawGrid($: any, e: any, width: number, across: number, budget: number, emptyHint: string) {
	const stored = await read($, cardsAtom);
	const all = stored.filter((c) => c.kind !== "workflow" || !stored.some((a) => a.run === c.id));
	const { Box, Text, Button } = $.ui.resolve(e);
	const nowMs = await $.clock.now();

	const dot = (s: GridStatus) => <Text color={s === "running" ? "claude" : s === "done" ? "success" : "error"}>●</Text>;
	const dim = (text: string) => (
		<Text dimColor wrap="truncate-end">
			{text}
		</Text>
	);
	if (all.length === 0) {
		if (e.surface === "terminal") {
			layouts.delete(e.requestId);
			firstPage();
			isEngineWindow = false;
		}
		return (
			<Box marginRight={4}>{dim(` agents · no subagents, workflows or background shells yet · ${emptyHint}`)}</Box>
		);
	}
	const running = all.filter((c) => c.status === "running");
	const shown = [...running, ...all.filter((c) => c.status !== "running").reverse()];
	const perRowMax = Math.max(1, Math.floor(width / 26));
	const room = Math.max(1, budget - 2);
	const isShort = room < 5;
	const capOf = (n: number) => Math.min(24, Math.floor((isShort ? budget : room) / Math.ceil(shown.length / n)));
	let perRow = Math.max(1, Math.min(shown.length, perRowMax));
	const fits = capOf(perRow) >= 5;
	if (fits) for (let n = perRow - 1; n >= 1; n--) if (capOf(n) >= capOf(perRow)) perRow = n;
	const boxW = Math.floor(across / perRow);
	const widthOf = (row: GridCard[], i: number) =>
		row.length === perRow && i === row.length - 1 ? across - boxW * (perRow - 1) : boxW;
	const gridRows: GridCard[][] = [];
	for (let i = 0; i < shown.length; i += perRow) gridRows.push(shown.slice(i, i + perRow));
	const pages = !fits && !isShort;
	const cap = fits ? capOf(perRow) : pages ? Math.max(5, Math.floor(room / Math.max(1, Math.floor(room / 7)))) : 8;

	type Row = { el: any; isResult: boolean };
	const live = await read($, liveAtom);
	const liveOf = (c: GridCard): GridLive | undefined => (c.status === "running" ? live[c.id] : undefined);
	const STATE: Record<string, string> = { D: "disk I/O", T: "stopped", t: "stopped", Z: "exited" };
	const rate = (n: number) => (n > 0 ? ` (${fmtBytes(n)}/s)` : "");
	const pair = (first: any, parts: string[], inner: number) => {
		const max = Math.max(8, Math.floor(inner / 2));
		let second = "";
		for (const part of parts.filter(Boolean)) {
			if (second && second.length + part.length + 3 > max) break;
			second += ` · ${part}`;
		}
		return (
			<Box flexDirection="row">
				<Box flexShrink={1}>{first}</Box>
				<Box flexShrink={0}>
					<Text dimColor wrap="truncate-end">
						{second}
					</Text>
				</Box>
			</Box>
		);
	};
	const fileRow = (f: GridProc["files"][number], full: boolean, inner: number, speed = 0) => {
		const sign = f.mode === "w" ? "→" : f.mode === "rw" ? "↔" : f.mode === "dir" ? "▸" : "←";
		const pct = f.size ? `${Math.min(100, Math.round((f.pos / f.size) * 100))}%` : "empty";
		const where =
			f.mode === "dir" || f.size === undefined
				? ""
				: f.mode === "w"
					? fmtBytes(f.size)
					: full
						? `${pct} of ${fmtBytes(f.size)}`
						: pct;
		return pair(
			<Text dimColor wrap="truncate-middle">{`  ${sign} ${f.path}`}</Text>,
			[where, speed ? `${fmtBytes(speed)}/s` : ""],
			inner,
		);
	};
	const ownOf = (procs: GridProc[]) => (procs.length > 1 ? procs.filter((p) => !p.root) : procs);
	const busy = (p: GridProc) => (p.state === "R" || p.state === "D" ? 1e15 : 0) + p.cpu * 1e10 + p.rdps + p.wrps;
	const procLine = (p: GridProc, indent: string) => (
		<Text wrap="truncate-end">
			{indent}
			<Text color="claude">⚙</Text> {p.args}
		</Text>
	);
	function activityRows(lv: GridLive | undefined, full: boolean, inner: number): Row[] {
		const procs = lv?.procs;
		if (!procs?.length) return [];
		const own = ownOf(procs);
		const bytes = (p: GridProc) => `read ${fmtBytes(p.rd)}${rate(p.rdps)} · wrote ${fmtBytes(p.wr)}${rate(p.wrps)}`;
		const doing = (p: GridProc) =>
			[p.cpu > 0 || p.state === "R" ? `${p.cpu}% CPU` : "idle", STATE[p.state]].filter(Boolean).join(" · ");
		if (!full) {
			const p = [...own].sort((a, b) => busy(b) - busy(a))[0]!;
			const others = own.length - 1 + (lv?.more ?? 0);
			const f =
				p.files.find((f) => f.mode !== "w" && f.mode !== "dir" && f.size) ??
				p.files.find((f) => f.mode === "w") ??
				p.files[0];
			const speed = f ? (f.mode === "w" ? p.wrps : p.rdps) : 0;
			return [
				{ el: pair(procLine(p, ""), [doing(p), others ? `+${others}` : ""], inner), isResult: true },
				{ el: f ? fileRow(f, false, inner, speed) : dim(`  ${bytes(p)}`), isResult: true },
			];
		}
		const rows: Row[] = [];
		for (const p of own) {
			rows.push({ el: procLine(p, ""), isResult: true });
			rows.push({ el: dim(`  ${doing(p)} · ${bytes(p)}`), isResult: true });
			for (const f of p.files) rows.push({ el: fileRow(f, true, inner), isResult: true });
			if (p.nfiles > p.files.length)
				rows.push({ el: dim(`  + ${plural(p.nfiles - p.files.length, "more file")}`), isResult: true });
		}
		if (lv?.more) rows.push({ el: dim(`+ ${plural(lv.more, "more process")}`), isResult: true });
		return rows;
	}

	function nowRow(n: GridNow, inner: number): Row {
		if (n.kind === "thinking")
			return {
				el: (
					<Text dimColor italic wrap="truncate-end">
						✻ thinking{n.text ? `: ${n.text}` : "…"}
					</Text>
				),
				isResult: false,
			};
		if (n.kind === "text")
			return {
				el: (
					<Text wrap="truncate-end">
						<Text color="claude">✎</Text> {n.text}
					</Text>
				),
				isResult: false,
			};
		const call = (
			<Text wrap="truncate-end">
				{dot("running")} <Text bold>{n.tool}</Text>
				<Text dimColor>{n.text ? `(${n.text})` : ""}</Text>
			</Text>
		);
		return { el: pair(call, [`writing${n.lines ? ` ${plural(n.lines, "line")}` : ""}…`], inner), isResult: false };
	}
	const pinnedOf = (c: GridCard, full: boolean, inner: number): Row[] => {
		const lv = liveOf(c);
		return [...(lv?.now ? [nowRow(lv.now, inner)] : []), ...activityRows(lv, full, inner)];
	};

	function contentRows(c: GridCard, full: boolean, inner: number): Row[] {
		const isRunning = c.status === "running";
		if (c.kind === "shell") {
			const rows: Row[] = [];
			const cmd = (c.command ?? "").split("\n").filter((l) => l.trim());
			const total = Math.max(cmd.length, c.commandLines ?? 0);
			if (cmd.length && full) {
				cmd.forEach((l, i) => {
					rows.push({
						el: (
							<Text wrap="truncate-end">
								<Text color="claude">{i ? " " : "$"}</Text> {tilde(l)}
							</Text>
						),
						isResult: false,
					});
				});
				if (total > cmd.length)
					rows.push({ el: dim(`  … +${plural(total - cmd.length, "more line")}`), isResult: false });
			} else if (cmd.length && firstLine(c.command) !== c.title) {
				const first = (
					<Text wrap="truncate-end">
						<Text color="claude">$</Text> {tilde(cmd[0]!)}
					</Text>
				);
				rows.push({ el: total > 1 ? pair(first, [`+${plural(total - 1, "line")}`], inner) : first, isResult: false });
			}
			if (c.lines.length) for (const l of c.lines) rows.push({ el: dim(l.text), isResult: false });
			else rows.push({ el: dim(isRunning ? "no output yet" : "no output"), isResult: false });
			return rows;
		}
		if (c.kind === "workflow") return [{ el: dim(runDoing(c, nowMs)), isResult: false }];
		const rows: Row[] = [];
		const tail = liveOf(c)?.tail ?? [];
		const runAt = tail.length ? c.lines.findLastIndex((l) => l.tool === "Bash" && l.result === undefined) : -1;
		c.lines.forEach((l, i) => {
			if (!l.tool) rows.push({ el: <Text wrap="truncate-end">● {l.text}</Text>, isResult: false });
			else {
				rows.push({
					el: (
						<Text wrap="truncate-end">
							{dot(l.result === undefined ? "running" : l.isError ? "failed" : "done")} <Text bold>{l.tool}</Text>
							<Text dimColor>({l.text})</Text>
						</Text>
					),
					isResult: false,
				});
				if (l.result !== undefined)
					rows.push({
						el: l.isError ? (
							<Text color="error" wrap="truncate-end">
								{"  ⎿ "}
								{l.result}
							</Text>
						) : (
							dim(`  ⎿ ${l.result}`)
						),
						isResult: true,
					});
				else if (i === runAt)
					for (const t of full ? tail : tail.slice(-1)) rows.push({ el: dim(`  ⎿ ${t}`), isResult: true });
			}
		});
		return rows.length ? rows : [{ el: dim(isRunning ? "starting…" : "no output"), isResult: false }];
	}
	const LIVE_ROWS = 2;
	const count = (c: GridCard) => {
		if (c.kind === "workflow") return 1;
		const live = fits && c.status === "running" ? LIVE_ROWS : 0;
		if (c.kind === "shell")
			return (c.command && firstLine(c.command) !== c.title ? 1 : 0) + Math.max(1, c.lines.length) + live;
		return (
			Math.max(
				1,
				c.lines.reduce((n, l) => n + (l.tool && (l.result !== undefined || l.tool === "Bash") ? 2 : 1), 0),
			) + live
		);
	};
	function rowsOf(c: GridCard, room: number, inner: number) {
		if (room <= 0) return [];
		const pinned = pinnedOf(c, false, inner);
		const content = contentRows(c, false, inner);
		const keep = Math.min(content.length, room >= 4 ? 2 : room - 1);
		const shownPinned = Math.min(pinned.length, Math.max(1, room - keep));
		const contentRoom = room - shownPinned;
		const window = contentRoom > 0 ? content.slice(-contentRoom) : [];
		if (window.length > 1 && window[0]!.isResult) window.shift();
		if (!shownPinned) return window.map((r) => r.el);
		return [
			<Box key="content" flexDirection="column" flexGrow={1}>
				{window.map((r) => r.el)}
			</Box>,
			...pinned.slice(0, shownPinned).map((r) => r.el),
		];
	}

	const glyphOf = (c: GridCard) =>
		c.kind === "shell" ? "$" : c.kind === "workflow" || c.run !== undefined ? "⧉" : "✻";
	function footerOf(c: GridCard) {
		const left = remainingOf(c, nowMs, stored);
		const ran =
			c.status === "running" && left === undefined && c.startedAt !== undefined
				? fmtRan((nowMs - c.startedAt) / 1000)
				: "";
		const isStopped = c.note === "stopped";
		return [
			ran ? `running ${ran}` : isStopped ? "stopped" : c.status,
			isStopped ? "" : c.note,
			left !== undefined ? `${fmtLeft(left)} left` : "",
			kTokens(c.tokens),
			c.group,
		]
			.filter(Boolean)
			.join(" · ");
	}

	const view = await read($, viewAtom);
	const ex = view.expanded ? all.find((c) => c.id === view.expanded) : undefined;
	if (ex) {
		const rows = [...contentRows(ex, true, across - 2), ...pinnedOf(ex, true, across - 2)];
		const room = Math.max(1, budget - 4);
		const last = Math.max(0, rows.length - room);
		const start = view.start < 0 ? last : Math.min(view.start, last);
		if (e.surface === "terminal") {
			expandedRows = rows.length;
			expandedRoom = room;
		}
		const span = rows.length > room ? `${start + 1}–${Math.min(rows.length, start + room)} of ${rows.length}` : "";
		const right = [span, ex.model].filter(Boolean).join(" · ");
		const titleRoom = Math.max(4, across - 5 - right.length);
		return (
			<Box flexDirection="column" width={across}>
				<Box
					key={`frame:${ex.id}`}
					width={across}
					height={room + 4}
					borderStyle="round"
					borderColor={frameColor(ex)}
					flexDirection="column"
					paddingX={0}
					overflow="hidden"
				>
					<Box flexDirection="row">
						<Box flexGrow={1} flexDirection="row">
							<Text color="claude">{glyphOf(ex)} </Text>
							<Button
								key={`open:${ex.id}`}
								label={fit(ex.title, titleRoom)}
								plain
								onPress={() => void expand($, ex.id)}
								autoFocus
							/>
						</Box>
						<Text dimColor> {right}</Text>
					</Box>
					<Box flexDirection="column" flexGrow={1} overflow="hidden">
						{rows.slice(start, start + room).map((r) => r.el)}
					</Box>
					<Text wrap="truncate-end">
						{dot(ex.status)} <Text dimColor>{footerOf(ex)}</Text>
					</Text>
				</Box>
			</Box>
		);
	}

	function boxOf(c: GridCard, height: number, boxWidth: number) {
		const glyph = glyphOf(c);
		const right = c.model ?? "";
		const footer = footerOf(c);
		const key = `box:${c.id}`;
		const room = Math.max(4, boxWidth - 4 - right.length - 1);
		const title = fit(c.title, room - 2);
		return (
			<Box
				key={`frame:${c.id}`}
				width={boxWidth}
				height={height}
				borderStyle="round"
				borderColor={frameColor(c)}
				flexDirection="column"
				paddingX={0}
				overflow="hidden"
			>
				<Box flexDirection="row">
					<Box width={room} flexDirection="row">
						<Text color="claude">{glyph} </Text>
						<Button
							key={key}
							label={title}
							plain
							onPress={() => void expand($, c.id)}
							{...(key === selectedKey ? { autoFocus: true as const } : {})}
						/>
					</Box>
					<Text dimColor> {right}</Text>
				</Box>
				<Box flexDirection="column" flexGrow={1} overflow="hidden">
					{rowsOf(c, height - 4, boxWidth - 2)}
				</Box>
				<Text wrap="truncate-end">
					{dot(c.status)} <Text dimColor>{footer}</Text>
				</Text>
			</Box>
		);
	}

	if (e.surface === "terminal") {
		const keys = gridRows.map((row) => row.map((c) => `box:${c.id}`));
		const order = keys.flat();
		const was = layouts.get(e.requestId)?.flat();
		layouts.set(e.requestId, keys);
		const fresh = !was?.length;
		if (!selectedKey || !order.includes(selectedKey)) {
			const at = selectedKey && was ? was.indexOf(selectedKey) : -1;
			selectedKey = order[Math.max(0, Math.min(at, order.length - 1))];
			if ((at >= 0 || fresh) && selectedKey) refocus = { site: e.requestId, key: selectedKey };
		} else if (fresh || was!.indexOf(selectedKey) !== order.indexOf(selectedKey)) {
			refocus = { site: e.requestId, key: selectedKey };
		}
	}

	const heights = gridRows.map((row) => Math.max(5, Math.min(cap, Math.max(1, ...row.map(count)) + 4)));
	const drawRow = (row: GridCard[], height: number) => (
		<Box flexDirection="row">{row.map((c, i) => boxOf(c, height, widthOf(row, i)))}</Box>
	);
	const tallyRow = (above: number, below: number) => (
		<Text dimColor wrap="truncate-end">
			{spread(across, above ? `↑ ${above} more` : "", tallyOf(stored), below ? `↓ ${below} more` : "")}
		</Text>
	);
	if (!pages) {
		if (e.surface === "terminal") {
			firstPage();
			isEngineWindow = !fits;
		}
		return (
			<Box flexDirection="column" width={across}>
				{gridRows.map((row, r) => drawRow(row, heights[r]!))}
				{fits && !isShort ? tallyRow(0, 0) : null}
			</Box>
		);
	}

	const tall = heights.map((h) => Math.min(h, room));
	const endOf = (top: number) => {
		let end = top;
		let used = 0;
		while (end < tall.length && (end === top || used + tall[end]! <= room)) used += tall[end++]!;
		return end;
	};
	const topFor = (last: number) => {
		let top = last;
		let used = tall[last]!;
		while (top > 0 && used + tall[top - 1]! <= room) used += tall[--top]!;
		return top;
	};
	const anchor =
		e.surface !== "terminal" && gridTopKey
			? gridRows.findIndex((row) => row.some((c) => `box:${c.id}` === gridTopKey))
			: -1;
	let top = Math.min(Math.max(0, anchor >= 0 ? anchor : gridTop), topFor(tall.length - 1));
	const chosenRow =
		bandHasKeys && selectedKey ? gridRows.findIndex((row) => row.some((c) => `box:${c.id}` === selectedKey)) : -1;
	if (chosenRow >= 0 && chosenRow < top) top = chosenRow;
	else if (chosenRow >= 0 && chosenRow >= endOf(top)) top = topFor(chosenRow);
	if (e.surface === "terminal") {
		gridTop = top;
		gridTopKey = `box:${gridRows[top]![0]!.id}`;
		isEngineWindow = false;
	}
	const end = endOf(top);
	const spare = room - tall.slice(top, end).reduce((a, b) => a + b, 0);
	const pageHeight = (i: number) =>
		tall[top + i]! + Math.floor(spare / (end - top)) + (i < spare % (end - top) ? 1 : 0);
	const above = gridRows.slice(0, top).flat();
	const below = gridRows.slice(end).flat();
	const offPage = (off: GridCard[]) =>
		off.length ? (
			<Box display="none">
				{off.map((c) => {
					const key = `box:${c.id}`;
					return (
						<Button
							key={key}
							label={c.title}
							plain
							onPress={() => void expand($, c.id)}
							{...(key === selectedKey ? { autoFocus: true as const } : {})}
						/>
					);
				})}
			</Box>
		) : null;
	return (
		<Box flexDirection="column" width={across}>
			{offPage(above)}
			{gridRows.slice(top, end).map((row, i) => drawRow(row, pageHeight(i)))}
			{offPage(below)}
			{tallyRow(above.length, below.length)}
		</Box>
	);
}

async function expand($: any, id: string) {
	const opening = expandedId !== id;
	await setView($, opening ? id : undefined, undefined);
	const site = lastSite;
	if (!site) return;
	void $.ui
		.focus({ requestId: site, key: `${opening ? "open" : "box"}:${id}` })
		.then(() => (opening ? $.ui.scroll({ in: site, to: "start" }) : reveal($, site, id)))
		.catch(() => undefined);
}

function reveal($: any, site: string, id: string): Promise<unknown> {
	if (!isEngineWindow) return Promise.resolve();
	const isFirstRow = layouts.get(site)?.[0]?.includes(`box:${id}`) ?? false;
	return $.ui.scroll({ in: site, to: isFirstRow ? "start" : { key: `frame:${id}` }, block: "nearest" });
}

async function steer($: any, e: any, next: any) {
	if (!bandDrawn) return next(e);
	const target: string | undefined = e.element;
	lastSite = e.requestId;
	movesInFlight++;
	let r: any;
	try {
		r = await next(e);
	} finally {
		movesInFlight--;
	}
	if (r?.deny) return r;
	if (!bandHasKeys) {
		bandHasKeys = true;
		$.ui.invalidate("ui.render");
	}
	if (!target?.startsWith("box:")) return r;
	if (selectedKey !== target || e.origin?.kind === "person") $.ui.invalidate("ui.render");
	selectedKey = target;
	if (e.origin?.kind === "person") void reveal($, e.requestId, target.slice(4)).catch(() => undefined);
	return r;
}

async function arrow($: any, e: any, next: any) {
	if (e.origin?.kind !== "person" || !e.by) return next(e);
	if (!bandDrawn) return next(e);
	lastSite = e.requestId;
	bandHasKeys = true;
	const edge = !e.pointer && e.contentRows !== e.bodyRows && Math.abs(e.by) === e.contentRows ? Math.sign(e.by) : 0;
	const steps = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / Math.max(1, e.bodyRows)));
	if (expandedId !== undefined) {
		if (e.pointer && e.contentRows > e.bodyRows) return next(e);
		const last = Math.max(0, expandedRows - expandedRoom);
		const from = expandedStart === undefined ? last : Math.min(expandedStart, last);
		const at = edge < 0 ? 0 : edge > 0 ? last : Math.max(0, Math.min(last, from + (e.pointer ? e.by : steps)));
		await setView($, expandedId, at >= last ? undefined : at);
		return {};
	}
	const rows = layouts.get(e.requestId);
	if (e.pointer || !rows?.length) return next(e);
	const r = Math.max(
		0,
		rows.findIndex((row) => row.includes(selectedKey ?? "")),
	);
	const to = edge < 0 ? 0 : edge > 0 ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, r + steps));
	if (to === r) {
		if (steps < 0 && isEngineWindow) void $.ui.scroll({ in: e.requestId, to: "start" }).catch(() => undefined);
		else if (selectedKey) void reveal($, e.requestId, selectedKey.slice(4)).catch(() => undefined);
		$.ui.invalidate("ui.render");
		return {};
	}
	const key = rows[to]![Math.min(Math.max(0, rows[r]!.indexOf(selectedKey ?? "")), rows[to]!.length - 1)]!;
	const was = selectedKey;
	selectedKey = key;
	void $.ui
		.focus({ requestId: e.requestId, key })
		.then((res: any) => {
			if (!res?.deny || selectedKey !== key) return;
			selectedKey = was;
			$.ui.invalidate("ui.render");
		})
		.catch(() => undefined);
	void reveal($, e.requestId, key.slice(4)).catch(() => undefined);
	$.ui.invalidate("ui.render");
	return {};
}

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		const r = await next(e);
		home = (await $.env.get("HOME").catch(() => undefined)) || undefined;
		await update($, liveAtom, () => ({}));
		const saved = await read($, cardsAtom);
		const isLone = (c: GridCard) => c.kind === "agent" && !c.run && c.status === "running";
		const listed = saved.some(isLone) ? await $.agent.list().catch(() => undefined) : undefined;
		const alive = new Set(
			listed?.filter((a) => !["completed", "failed", "killed"].includes(a.status)).map((a) => a.id),
		);
		for (const c of saved) {
			if (listed && isLone(c) && !alive.has(c.agentId ?? c.id)) {
				touch();
				continue;
			}
			const card: GridCard = { ...c, lines: [...(c.lines ?? [])] };
			delete (card as any).members;
			cards.set(card.id, card);
			if (card.kind === "agent") owner.set(card.agentId ?? card.id, card.id);
		}
		if ((await $.ui.panes().catch(() => [])).some((p: any) => p.id === VIEW))
			await $.ui.close({ id: VIEW }).catch(() => undefined);
		isPinned = await read($, bandAtom);
		const view = await read($, viewAtom);
		expandedId = view.expanded || undefined;
		expandedStart = view.start >= 0 ? view.start : undefined;
		await $.command.register({
			name: COMMAND,
			description:
				"Pin the live agent grid above the prompt (it shows itself while anything runs; ctrl+x tab, then the arrows)",
			immediate: true,
		});
		$.clock.every(250, () => {
			if (expandedId !== undefined && (!cards.has(expandedId) || hasAgents(expandedId)))
				void setView($, undefined, undefined);
			if (refocus) {
				const { site, key } = refocus;
				refocus = undefined;
				if (expandedId === undefined && key === selectedKey && !movesInFlight)
					void $.ui.focus({ requestId: site, key }).catch(() => undefined);
			}
			if (dirty && !isPublishingCards) {
				isPublishingCards = true;
				void publishCards($).finally(() => {
					isPublishingCards = false;
				});
			}
			if (liveDirty && !isPublishingLive) {
				isPublishingLive = true;
				void publishLive($).finally(() => {
					isPublishingLive = false;
				});
			}
		});
		$.clock.every(1000, () => {
			void $.clock.now().then(closeFinished);
			if (isPolling) return;
			isPolling = true;
			void pollAll($).finally(() => {
				isPolling = false;
			});
		});
		$.clock.every(300, () => {
			void watchDraft($).catch(() => undefined);
			void watchKeys($).catch(() => undefined);
		});
		return r;
	});

	on("command.run", { command: COMMAND }, async ($) => {
		if ((await $.ui.panes().catch(() => [])).some((p: any) => p.id === VIEW))
			await $.ui.close({ id: VIEW }).catch(() => undefined);
		if (expandedId !== undefined) await setView($, undefined, undefined);
		else if (clearFinished()) await publishCards($);
		else {
			selectedKey = undefined;
			layouts.clear();
			firstPage();
			await setPinned($, !isPinned);
		}
		await syncTyping($);
		$.ui.invalidate("ui.render");
		return {};
	});

	on("prompt.submit", async ($, e, next) => {
		const kind = (e.origin as any)?.kind;
		if (kind === "composer" || kind === "bridge") {
			await setPinned($, false);
			await setView($, undefined, undefined);
			clearFinished();
			await publishCards($);
			await syncTyping($);
		}
		return next(e);
	});

	on("agent.spawn", async ($, e, next) => {
		const r = await next(e);
		if (r.agentId && !e.workflow) {
			const title = firstLine(e.description) || e.subagentType;
			claim(r.agentId, r.agentId, {
				title,
				model: shortModel(r.model),
				taskId: r.agentId,
				startedAt: await $.clock.now(),
			});
		}
		return r;
	});

	on("tool.call", async ($, e, next) => {
		const x = e as any;
		const agentId: string | undefined = x.agentId;
		const card = sinkOf(agentId);
		const line: GridLine | undefined = card ? { tool: x.tool, text: callArg(x) } : undefined;
		if (card && line) push(card, line);
		const call =
			card && x.tool === "Bash" && !x.run_in_background && typeof x.command === "string"
				? { card, command: x.command, since: await $.clock.now() }
				: undefined;
		if (call) inFlight.add(call);

		let ran: any;
		try {
			ran = await next(e);
		} finally {
			if (call) {
				inFlight.delete(call);
				if (![...inFlight].some((o) => o.card === call.card)) setLive(call.card, ENDED);
			}
		}

		if (line) {
			Object.assign(line, resultOf(x.tool, ran, x));
			if (line.isError && card) card.failed = (card.failed ?? 0) + 1;
			touch();
		}
		if (x.tool === "TaskStop" && ran?.result?.task_id && !ran.isError) {
			const stoppedAt = await $.clock.now();
			for (const c of cards.values()) {
				if (
					c.status !== "running" ||
					(c.taskId !== ran.result.task_id && (c.run === undefined || cards.get(c.run)?.taskId !== ran.result.task_id))
				)
					continue;
				c.status = "failed";
				c.note = "stopped";
				c.endedAt ??= stoppedAt;
			}
			touch();
		}
		const res = ran?.result;
		if (agentId && (!card || card.run !== undefined || !cards.has(card.id))) return ran;
		const now = await $.clock.now();
		if (x.tool === "Bash" && res?.backgroundTaskId) {
			const path = String(ran.text ?? "").match(/written to: (\S+\.output)/)?.[1];
			add({
				id: `sh:${res.backgroundTaskId}`,
				kind: "shell",
				title: firstLine(x.description ?? x.command),
				...commandOf(x.command),
				status: "running",
				lines: [],
				taskId: res.backgroundTaskId,
				path,
				startedAt: now,
			});
		} else if (x.tool === "Monitor" && res?.taskId) {
			const command = commandOf(x.command);
			add({
				id: `sh:${res.taskId}`,
				kind: "shell",
				title: firstLine(x.description) || "monitor",
				...command,
				status: "running",
				lines: [],
				taskId: res.taskId,
				startedAt: now,
			});
		} else if (x.tool === "Workflow" && res?.transcriptDir) {
			const title = firstLine(res.workflowName) || "workflow";
			add({
				id: `wf:${res.runId}`,
				kind: "workflow",
				title,
				status: "running",
				lines: [],
				taskId: res.taskId,
				path: res.transcriptDir,
				startedAt: now,
			});
		}
		return ran;
	});

	on("turn.step", async function* ($, e, next) {
		const agentId = e.agentId;
		const first = sinkOf(agentId);
		if (!first) return yield* next(e);
		const sink = () => cards.get(owner.get(agentId ?? "") ?? "") ?? first;
		if (!first.model) {
			first.model = shortModel(e.model);
			touch();
		}
		const stream = next(e);
		const blocks = new Map<number, Block>();
		let fed = first;
		try {
			for await (const chunk of stream) {
				if (!stale.has(agentId ?? "")) watch((fed = sink()), blocks, chunk);
				yield chunk;
			}
		} finally {
			for (const box of new Set([fed, first]))
				if (cards.get(box.id) !== box || !box.agentId || box.agentId === agentId) setLive(box, { now: undefined });
		}
		const card = sink();
		const r: any = await stream.result;
		const tokens = used(r?.usage);
		if (card && tokens) {
			card.tokens = tokens;
			touch();
		}
		return r;
	});

	on("turn.complete", async ($, e, next) => {
		const agentId = e.agentId;
		const card =
			agentId && !stale.has(agentId) ? (cards.get(owner.get(agentId) ?? "") ?? pending.get(agentId)) : undefined;
		if (card) {
			card.status = e.reason === "answer" ? "done" : "failed";
			card.endedAt = await $.clock.now();
			touch();
		}
		return next(e);
	});

	on("session.append", async ($, e, next) => {
		if (e.door === "response" && e.agentId) {
			const text = firstLine(
				((e.message.content ?? []) as any[])
					.filter((b) => b?.type === "text")
					.map((b) => b.text)
					.join(" "),
			);
			const card = text ? sinkOf(e.agentId) : undefined;
			if (card) {
				if (lives.get(card)?.now?.kind === "text") setLive(card, { now: undefined });
				push(card, { text });
			}
		}
		if ((e.origin as any)?.kind === "task-notification") {
			const text = (e.message.content as any[]).map((b) => b?.text ?? "").join("");
			const taskId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
			const status = text.match(/<status>([^<]+)<\/status>/)?.[1];
			const card = taskId ? [...cards.values()].find((c) => c.taskId === taskId) : undefined;
			if (card && status) {
				const now = await $.clock.now();
				card.status = status === "completed" ? "done" : "failed";
				card.endedAt ??= now;
				for (const c of cards.values())
					if (c.run === card.id && c.status === "running") {
						c.status = card.status;
						c.endedAt ??= now;
					}
				touch();
			}
		}
		return next(e);
	});

	on("ui.focus", { component: "AbovePrompt" }, ($, e, next) => steer($, e, next));
	on("ui.scroll", { component: "AbovePrompt" }, ($, e, next) => arrow($, e, next));

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const count = e.props.hasSurvey || isTyping ? 0 : (await read($, cardsAtom)).length;
		const isUp = count > 0 || (!e.props.hasSurvey && !isTyping && (await read($, bandAtom)));
		if (e.surface === "terminal") {
			bandDrawn = isUp;
			if (!isUp) firstPage();
		}
		if (!isUp) return next(e);
		const across =
			e.surface === "terminal"
				? Math.min(e.viewport?.columns ?? Infinity, e.props.bodyColumns + 5)
				: e.props.bodyColumns;
		const budget = Math.max(
			5,
			e.viewport?.isFullscreen === false ? Math.floor(e.props.maxRows / 2) - 4 : e.props.maxRows,
		);
		const grid = await drawGrid($, e, e.props.bodyColumns, across, budget, `/${COMMAND} hides it`);
		if (e.surface !== "terminal") return grid;
		const below = await next(e);
		if ((below as { type?: string }).type === "engine") return grid;
		const kids = ((below as any).children ?? (below as any).props?.children ?? []) as any[];
		const g = grid as any;
		if ((below as any).type !== "Box" || !kids.length || g?.type !== "Box") return grid;
		const own = (g.children ?? g.props?.children ?? []) as any[];
		return {
			...g,
			props: { ...g.props, minHeight: Math.max(Number(g.props?.minHeight) || 0, 3) },
			children: [...own, ...kids],
		};
	});
};
