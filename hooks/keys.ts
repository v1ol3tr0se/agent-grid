import type { EngineInterface, Frozen, Next, UiFocusInput, UiScrollInput } from "claude-code";

import { cards, isClearable, layouts, setView, view } from "./state";

let isWatching = false;
let draftEpoch = 0;
let emptyReads = 0;
let isProbing = false;
let lastSite: string | undefined;

export async function watchDraft($: EngineInterface) {
	if (isWatching) return;
	isWatching = true;
	try {
		const epoch = draftEpoch;
		const draft = await $.prompt
			.read()
			.then((b) => String(b?.text ?? ""))
			.catch(() => undefined);
		if (draft === undefined || epoch !== draftEpoch) return;
		const typing = draft.trim() !== "";
		if (typing === view.isTyping) {
			emptyReads = 0;
			return;
		}
		if (!typing && sendWouldChange() && ++emptyReads < 2) return;
		emptyReads = 0;
		view.isTyping = typing;
		if (view.isTyping) view.bandHasKeys = false;
		if (view.isTyping && view.expandedId !== undefined) void setView($, undefined, undefined);
		$.ui.invalidate("ui.render");
	} finally {
		isWatching = false;
	}
}

export async function syncTyping($: EngineInterface) {
	draftEpoch++;
	const draft = await $.prompt
		.read()
		.then((b) => String(b?.text ?? ""))
		.catch(() => "");
	emptyReads = 0;
	if ((draft.trim() !== "") === view.isTyping) return;
	view.isTyping = !view.isTyping;
	$.ui.invalidate("ui.render");
}

export async function watchKeys($: EngineInterface) {
	if (!view.bandHasKeys || !view.bandDrawn || !lastSite || isProbing || view.movesInFlight) return;
	const key = view.expandedId !== undefined ? `open:${view.expandedId}` : view.selectedKey;
	if (!key) return;
	isProbing = true;
	try {
		const r = await $.ui.focus({ requestId: lastSite, key }).catch(() => undefined);
		if (r?.deny !== "that site does not hold the keyboard") return;
		view.bandHasKeys = false;
		if (view.expandedId !== undefined) await setView($, undefined, undefined);
		$.ui.invalidate("ui.render");
	} finally {
		isProbing = false;
	}
}

const sendWouldChange = () =>
	view.isPinned || view.expandedId !== undefined || [...cards].some(([id, c]) => isClearable(id, c));

export async function expand($: EngineInterface, id: string) {
	const opening = view.expandedId !== id;
	await setView($, opening ? id : undefined, undefined);
	const site = lastSite;
	if (!site) return;
	void $.ui
		.focus({ requestId: site, key: `${opening ? "open" : "box"}:${id}` })
		.then(() => (opening ? $.ui.scroll({ in: site, to: "start" }) : reveal($, site, id)))
		.catch(() => undefined);
}

function reveal($: EngineInterface, site: string, id: string): Promise<unknown> {
	if (!view.isEngineWindow) return Promise.resolve();
	const isFirstRow = layouts.get(site)?.[0]?.includes(`box:${id}`) ?? false;
	return $.ui.scroll({ in: site, to: isFirstRow ? "start" : { key: `frame:${id}` }, block: "nearest" });
}

export async function steer($: EngineInterface, e: Frozen<UiFocusInput>, next: Next<"ui.focus">) {
	if (!view.bandDrawn) return next(e);
	const target: string | undefined = e.element;
	lastSite = e.requestId;
	view.movesInFlight++;
	const r = await next(e).finally(() => {
		view.movesInFlight--;
	});
	if (r?.deny) return r;
	if (!view.bandHasKeys) {
		view.bandHasKeys = true;
		$.ui.invalidate("ui.render");
	}
	if (!target?.startsWith("box:")) return r;
	if (view.selectedKey !== target || e.origin?.kind === "person") $.ui.invalidate("ui.render");
	view.selectedKey = target;
	if (e.origin?.kind === "person") void reveal($, e.requestId, target.slice(4)).catch(() => undefined);
	return r;
}

export async function arrow($: EngineInterface, e: Frozen<UiScrollInput>, next: Next<"ui.scroll">) {
	if (e.origin?.kind !== "person" || !e.by) return next(e);
	if (!view.bandDrawn) return next(e);
	lastSite = e.requestId;
	view.bandHasKeys = true;
	const edge = !e.pointer && e.contentRows !== e.bodyRows && Math.abs(e.by) === e.contentRows ? Math.sign(e.by) : 0;
	const steps = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / Math.max(1, e.bodyRows)));
	if (view.expandedId !== undefined) {
		if (e.pointer && e.contentRows > e.bodyRows) return next(e);
		const last = Math.max(0, view.expandedRows - view.expandedRoom);
		const from = view.expandedStart === undefined ? last : Math.min(view.expandedStart, last);
		const at = edge < 0 ? 0 : edge > 0 ? last : Math.max(0, Math.min(last, from + (e.pointer ? e.by : steps)));
		await setView($, view.expandedId, at >= last ? undefined : at);
		return {};
	}
	const rows = layouts.get(e.requestId);
	if (e.pointer || !rows?.length) return next(e);
	const r = Math.max(
		0,
		rows.findIndex((row) => row.includes(view.selectedKey ?? "")),
	);
	const to = edge < 0 ? 0 : edge > 0 ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, r + steps));
	if (to === r) {
		if (steps < 0 && view.isEngineWindow) void $.ui.scroll({ in: e.requestId, to: "start" }).catch(() => undefined);
		else if (view.selectedKey) void reveal($, e.requestId, view.selectedKey.slice(4)).catch(() => undefined);
		$.ui.invalidate("ui.render");
		return {};
	}
	const key = rows[to]![Math.min(Math.max(0, rows[r]!.indexOf(view.selectedKey ?? "")), rows[to]!.length - 1)]!;
	const was = view.selectedKey;
	view.selectedKey = key;
	void $.ui
		.focus({ requestId: e.requestId, key })
		.then((res) => {
			if (!res?.deny || view.selectedKey !== key) return;
			view.selectedKey = was;
			$.ui.invalidate("ui.render");
		})
		.catch(() => undefined);
	void reveal($, e.requestId, key.slice(4)).catch(() => undefined);
	$.ui.invalidate("ui.render");
	return {};
}
