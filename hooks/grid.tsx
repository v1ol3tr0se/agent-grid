import type { EngineInterface, Frozen, RenderElement, RenderInput } from "claude-code";

import type { GridCard, GridLive, GridNow, GridProc, GridStatus } from "../types";
import { expand } from "./keys";
import { layouts, readCards, readLive, readView, view } from "./state";
import { firstLine, fit, fmtBytes, fmtLeft, fmtRan, kTokens, plural, spread, tilde } from "./text";

const MODEL_COLOR: Record<string, string> = { opus: "claude", sonnet: "blue", haiku: "green", fable: "magenta" };
const frameColor = (c: GridCard) =>
	c.status === "failed" ? "error" : (c.color ?? ((c.model && MODEL_COLOR[c.model]) || "gray"));

const DEFAULT_AGENT_SECS = 170;
const WORKFLOW_RESIDUAL_SECS = 180;

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

function runDoing(c: GridCard, nowMs: number): string {
	const quiet = (nowMs - (c.lastAt ?? c.startedAt ?? nowMs)) / 1000;
	const still = quiet >= 60 ? ` · nothing new for ${fmtRan(quiet)}` : "";
	const count = `${c.done ?? 0} of ${c.listed ?? 0} agents done`;
	if (c.note === "stopped") return `stopped · ${count}`;
	if (c.status !== "running") return count;
	if (!c.listed) return `starting: its script has not launched an agent yet${still}`;
	return `${c.phase ? `${c.phase}: ` : ""}${count} · its script picks what runs next${still}`;
}

const tallyOf = (stored: readonly GridCard[]) =>
	(["workflow", "agent", "shell"] as const)
		.map((kind) => [stored.filter((c) => c.kind === kind).length, kind] as const)
		.filter(([n]) => n > 0)
		.map(([n, kind]) => plural(n, kind))
		.join(" · ");

let gridTop = 0;
let gridTopKey: string | undefined;
export const firstPage = () => {
	gridTop = 0;
	gridTopKey = undefined;
};

export async function drawGrid(
	$: EngineInterface,
	e: Frozen<RenderInput<"AbovePrompt">>,
	width: number,
	across: number,
	budget: number,
	emptyHint: string,
) {
	const stored = await readCards($);
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
			view.isEngineWindow = false;
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

	type Row = { el: RenderElement; isResult: boolean };
	const live = await readLive($);
	const liveOf = (c: GridCard): GridLive | undefined => (c.status === "running" ? live[c.id] : undefined);
	const STATE: Record<string, string> = { D: "disk I/O", T: "stopped", t: "stopped", Z: "exited" };
	const rate = (n: number) => (n > 0 ? ` (${fmtBytes(n)}/s)` : "");
	const pair = (first: RenderElement, parts: string[], inner: number) => {
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

	const opened = await readView($);
	const ex = opened.expanded ? all.find((c) => c.id === opened.expanded) : undefined;
	if (ex) {
		const rows = [...contentRows(ex, true, across - 2), ...pinnedOf(ex, true, across - 2)];
		const room = Math.max(1, budget - 4);
		const last = Math.max(0, rows.length - room);
		const start = opened.start < 0 ? last : Math.min(opened.start, last);
		if (e.surface === "terminal") {
			view.expandedRows = rows.length;
			view.expandedRoom = room;
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
							{...(key === view.selectedKey ? { autoFocus: true as const } : {})}
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
		if (!view.selectedKey || !order.includes(view.selectedKey)) {
			const at = view.selectedKey && was ? was.indexOf(view.selectedKey) : -1;
			view.selectedKey = order[Math.max(0, Math.min(at, order.length - 1))];
			if ((at >= 0 || fresh) && view.selectedKey) view.refocus = { site: e.requestId, key: view.selectedKey };
		} else if (fresh || was!.indexOf(view.selectedKey) !== order.indexOf(view.selectedKey)) {
			view.refocus = { site: e.requestId, key: view.selectedKey };
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
			view.isEngineWindow = !fits;
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
		view.bandHasKeys && view.selectedKey
			? gridRows.findIndex((row) => row.some((c) => `box:${c.id}` === view.selectedKey))
			: -1;
	if (chosenRow >= 0 && chosenRow < top) top = chosenRow;
	else if (chosenRow >= 0 && chosenRow >= endOf(top)) top = topFor(chosenRow);
	if (e.surface === "terminal") {
		gridTop = top;
		gridTopKey = `box:${gridRows[top]![0]!.id}`;
		view.isEngineWindow = false;
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
							{...(key === view.selectedKey ? { autoFocus: true as const } : {})}
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
