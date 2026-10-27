import type { Register } from "claude-code";

import type { GridLine } from "../types";
import { drawGrid, firstPage } from "./grid";
import { arrow, steer, syncTyping, watchDraft, watchKeys } from "./keys";
import { type Block, ENDED, pollAll, watch } from "./live";
import {
	add,
	cards,
	claim,
	clearFinished,
	closeFinished,
	flush,
	hasAgents,
	inFlight,
	layouts,
	lives,
	owner,
	pending,
	publishCards,
	push,
	readCards,
	readPinned,
	restore,
	setLive,
	setPinned,
	setView,
	sinkOf,
	stale,
	touch,
	view,
} from "./state";
import { callArg, commandOf, firstLine, resultOf, setHome, shortModel, used } from "./text";

const VIEW = "grid";
const COMMAND = "workflow";

let isPolling = false;

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		const r = await next(e);
		setHome((await $.env.get("HOME").catch(() => undefined)) || undefined);
		await restore($);
		if ((await $.ui.panes().catch(() => [])).some((p) => p.id === VIEW))
			await $.ui.close({ id: VIEW }).catch(() => undefined);
		await $.command.register({
			name: COMMAND,
			description:
				"Pin the live agent grid above the prompt (it shows itself while anything runs; ctrl+x tab, then the arrows)",
			immediate: true,
		});
		$.clock.every(250, () => {
			if (view.expandedId !== undefined && (!cards.has(view.expandedId) || hasAgents(view.expandedId)))
				void setView($, undefined, undefined);
			if (view.refocus) {
				const { site, key } = view.refocus;
				view.refocus = undefined;
				if (view.expandedId === undefined && key === view.selectedKey && !view.movesInFlight)
					void $.ui.focus({ requestId: site, key }).catch(() => undefined);
			}
			flush($);
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
		if ((await $.ui.panes().catch(() => [])).some((p) => p.id === VIEW))
			await $.ui.close({ id: VIEW }).catch(() => undefined);
		if (view.expandedId !== undefined) await setView($, undefined, undefined);
		else if (clearFinished()) await publishCards($);
		else {
			view.selectedKey = undefined;
			layouts.clear();
			firstPage();
			await setPinned($, !view.isPinned);
		}
		await syncTyping($);
		$.ui.invalidate("ui.render");
		return {};
	});

	on("prompt.submit", async ($, e, next) => {
		const kind = e.origin?.kind;
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
		const r = await stream.result;
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
				(e.message.content ?? [])
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
		if (e.origin?.kind === "task-notification") {
			const text = e.message.content.map((b) => b?.text ?? "").join("");
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
		const count = e.props.hasSurvey || view.isTyping ? 0 : (await readCards($)).length;
		const isUp = count > 0 || (!e.props.hasSurvey && !view.isTyping && (await readPinned($)));
		if (e.surface === "terminal") {
			view.bandDrawn = isUp;
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
