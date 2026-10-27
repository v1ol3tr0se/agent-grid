import type { EngineInterface } from "claude-code";

import type { GridCard, GridLine, GridStatus } from "../types";
import { CLOSE_MS, cards, claim, evicted, KEEP_LINES, owner, pending, seenAt, stale, touch } from "./state";
import { callArg, firstLine, resultOf, shortModel, used } from "./text";

const JOURNAL_HEAD = 1000;
const HEAD = /^\{"type":"(\w+)"(?:,"key":"([^"]+)","agentId":"([^"]*)")?/;

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

const journalSize = new Map<string, number>();

async function backfill($: EngineInterface, card: GridCard, file: string) {
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

export async function pollRun($: EngineInterface, run: GridCard) {
	const entries = await $.fs.list(run.path).catch(() => []);
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
