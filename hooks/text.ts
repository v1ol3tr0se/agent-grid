import type { GridLine } from "../types";

const wellFormed = (s: string) =>
	s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
export const cut = (s: string, n: number) => wellFormed(n >= 0 ? s.slice(0, n) : s.slice(n));
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
export const fit = (s: string, n: number) => {
	let cells = 0;
	let end = 0;
	for (const ch of s) {
		cells += WIDE.test(ch) ? 2 : 1;
		if (cells > n) return `${s.slice(0, end)}…`;
		if (cells < n) end += ch.length;
	}
	return s;
};
export const clean = (s: unknown) =>
	wellFormed(
		String(s ?? "")
			.replace(/\t/g, "  ")
			.replace(
				/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b.|[\x00-\x08\x0b-\x1f\x7f-\x9f]|\u{10EEEE}/gu,
				"",
			),
	);
export const firstLine = (s: unknown) =>
	cut(
		clean(s)
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? "",
		300,
	);
export const lastLine = (s: unknown) =>
	cut(
		clean(s)
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.at(-1) ?? "",
		-300,
	);
export const oneLine = (s: unknown) =>
	clean(s)
		.replace(/\s*\n\s*/g, " ⏎ ")
		.trim();

let home: string | undefined;
export const setHome = (dir: string | undefined) => {
	home = dir;
};
export const tilde = (s: string) => (home ? s.split(`${home}/`).join("~/") : s);

export const fmtRan = (s: number) =>
	s < 60
		? `${Math.floor(s)}s`
		: s < 3600
			? `${Math.floor(s / 60)}m`
			: `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
export const fmtLeft = (s: number) =>
	s < 60
		? `~${Math.max(5, Math.round(s / 5) * 5)}s`
		: s < 3600
			? `~${Math.round(s / 60)}m`
			: `~${Math.round(s / 3600)}h`;
export const fmtBytes = (n: number) =>
	n < 1024
		? `${n} B`
		: n < 1 << 20
			? `${(n / 1024).toFixed(1)} KB`
			: n < 1 << 30
				? `${(n / (1 << 20)).toFixed(1)} MB`
				: `${(n / (1 << 30)).toFixed(2)} GB`;
const linesIn = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);
export const shortModel = (m?: string) =>
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
export const used = (u: any): number | undefined =>
	u
		? (u.input_tokens ?? 0) +
			(u.cache_read_input_tokens ?? 0) +
			(u.cache_creation_input_tokens ?? 0) +
			(u.output_tokens ?? 0)
		: undefined;
export const kTokens = (n?: number) => (!n ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function spread(width: number, left: string, middle: string, right: string) {
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
export const commandOf = (command: unknown) => {
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
export const callArg = (e: any) =>
	tilde(
		firstLine(e.command ?? e.file_path ?? e.pattern ?? e.url ?? e.query ?? e.description ?? e.skill ?? e.prompt ?? ""),
	);

export function resultOf(tool: string, ran: any, input?: any): Pick<GridLine, "result" | "isError"> {
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
