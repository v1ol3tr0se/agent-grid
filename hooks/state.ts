import type { EngineInterface } from "claude-code";
import { atom, read, update } from "claude-code";

import type { GridCard, GridLine, GridLive } from "../types";

const cardsAtom = atom({ plugin: "agent-grid", key: "cards" } as const, [] as GridCard[]);
const liveAtom = atom({ plugin: "agent-grid", key: "live" } as const, {} as Record<string, GridLive>);
const bandAtom = atom({ plugin: "agent-grid", key: "band" } as const, false);
const viewAtom = atom({ plugin: "agent-grid", key: "view" } as const, { expanded: "", start: -1 });

export const KEEP_LINES = 120;
const KEEP_CARDS = 96;
const PENDING_MAX = 64;
export const CLOSE_MS = 4000;
const STALE_MS = 10 * 60_000;

export const cards = new Map<string, GridCard>();
export const owner = new Map<string, string>();
export const pending = new Map<string, GridCard>();
export const seenAt = new Map<string, number>();
export const stale = new Set<string>();
export const evicted = new Map<string, string | undefined>();
export const closed = new Map<string, Pick<GridCard, "title" | "model" | "taskId">>();
export const inFlight = new Set<{ card: GridCard; command: string; since: number; taskId?: string }>();
export const lives = new WeakMap<GridCard, GridLive>();
export const layouts = new Map<string, string[][]>();
/** What the band shows and who holds its keys, shared by the drawing, the key hooks and the timers. */
export const view = {
	isTyping: false,
	isPinned: false,
	bandDrawn: false,
	bandHasKeys: false,
	movesInFlight: 0,
	selectedKey: undefined as string | undefined,
	refocus: undefined as { site: string; key: string } | undefined,
	expandedId: undefined as string | undefined,
	expandedStart: undefined as number | undefined,
	expandedRows: 0,
	expandedRoom: 0,
	isEngineWindow: false,
};
let liveDirty = false;
let dirty = false;
let isPublishingCards = false;
let isPublishingLive = false;

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

export function readCards($: EngineInterface) {
	return read($, cardsAtom);
}
export function readLive($: EngineInterface) {
	return read($, liveAtom);
}
export function readView($: EngineInterface) {
	return read($, viewAtom);
}
export function readPinned($: EngineInterface) {
	return read($, bandAtom);
}

export async function restore($: EngineInterface) {
	await update($, liveAtom, () => ({}));
	const saved = await read($, cardsAtom);
	const isLone = (c: GridCard) => c.kind === "agent" && !c.run && c.status === "running";
	const listed = saved.some(isLone) ? await $.agent.list().catch(() => undefined) : undefined;
	const alive = new Set(listed?.filter((a) => !["completed", "failed", "killed"].includes(a.status)).map((a) => a.id));
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
	view.isPinned = await read($, bandAtom);
	const opened = await read($, viewAtom);
	view.expandedId = opened.expanded || undefined;
	view.expandedStart = opened.start >= 0 ? opened.start : undefined;
}

export function setView($: EngineInterface, id: string | undefined, start: number | undefined) {
	view.expandedId = id;
	view.expandedStart = start;
	return update($, viewAtom, () => ({ expanded: id ?? "", start: start ?? -1 }));
}

export async function setPinned($: EngineInterface, pinned: boolean) {
	view.isPinned = pinned;
	await update($, bandAtom, () => pinned);
}

export const touch = () => {
	dirty = true;
};
export function setLive(card: GridCard, patch: GridLive) {
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
export const add = (card: GridCard) => {
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
export const hasAgents = (runId: string) => [...cards.values()].some((c) => c.run === runId);
const wake = (card: GridCard) => {
	if (card.status === "running") return;
	card.status = "running";
	card.endedAt = undefined;
	if ([...cards.values()].some((c) => c !== card && c.status === "running" && c.color === card.color))
		card.color = colorFor(card);
};
export const push = (card: GridCard, line: GridLine) => {
	card.lines.push(line);
	if (card.lines.length > KEEP_LINES) card.lines.splice(0, card.lines.length - KEEP_LINES);
	wake(card);
	touch();
};
export const sinkOf = (agentId: string | undefined): GridCard | undefined => {
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
export const claim = (id: string, agentId: string, fields: Partial<GridCard>): GridCard => {
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

export function publishCards($: EngineInterface) {
	dirty = false;
	return update($, cardsAtom, () => [...cards.values()].map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l })) })));
}

function publishLive($: EngineInterface) {
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

export function flush($: EngineInterface) {
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
}

export const isClearable = (id: string, c: GridCard) =>
	c.status !== "running" &&
	!(c.run !== undefined && cards.get(c.run)?.status === "running") &&
	!(c.kind === "workflow" && [...cards.values()].some((a) => a.run === id && a.status === "running"));

export function closeFinished(now: number) {
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
		if (c.status === "running" || id === view.expandedId) continue;
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

export function clearFinished() {
	let isCleared = false;
	for (const [id, c] of cards) {
		if (!isClearable(id, c)) continue;
		close(id, c);
		isCleared = true;
	}
	if (isCleared) touch();
	return isCleared;
}
