import { expect, mock, test } from "claude-code/testing";

const tally = (drawn: string) => {
	const n = (word: string) => drawn.split("\n").filter((l) => l.startsWith(word)).length;
	return (["running", "done", "failed"] as const)
		.map((w) => [w, n(w)] as const)
		.filter(([, k]) => k)
		.map(([w, k]) => `${k} ${w}`)
		.join(" · ");
};

const rowsOf = (el: any): number => {
	if (!el || typeof el !== "object") return 0;
	if (el.type === "Text" || el.type === "Button") return 1;
	if (el.type !== "Box" || el.props?.display === "none") return 0;
	if (typeof el.props?.height === "number") return el.props.height;
	const kids = ((el.children ?? el.props?.children ?? []) as any[]).map(rowsOf);
	return el.props?.flexDirection === "row" ? Math.max(0, ...kids) : kids.reduce((a: number, b: number) => a + b, 0);
};

const noProbe = async function* () {
	return { value: { code: 0, signal: null } };
};

const BAND = {
	plugin: "agent-grid",
	surface: "terminal" as const,
	component: "AbovePrompt" as const,
	requestId: "above-prompt",
	props: {
		hasSurvey: false,
		isWorking: false,
		maxRows: 17,
		bodyColumns: 104,
		scroll: { offset: 0, bodyRows: 17 },
		view: {},
	},
	viewport: { columns: 104, rows: 59, isFullscreen: true },
};

test("a subagent, a background shell and a workflow run each get a live box in the view", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("agent.spawn", () => ({ model: "claude-haiku-4-5-20251001", agentId: "a1" }));
	on("tool.call", ($e: any, e: any) =>
		e.tool === "Workflow"
			? ({
					result: {
						status: "async_launched",
						taskId: "w1",
						runId: "wf_1",
						workflowName: "review",
						transcriptDir: "/nonexistent/wf_1",
					},
					text: "launched",
				} as any)
			: e.run_in_background
				? ({
						result: { backgroundTaskId: `b-${e.description}`, stdout: "", stderr: "", interrupted: false },
						text: "Output is being written to: /nonexistent/tasks/b.output.",
					} as any)
				: ({
						result: { stdout: "Compiled in 19.5s", stderr: "", interrupted: false },
						text: "Compiled in 19.5s",
					} as any),
	);
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	let view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");

	await $.agent.spawn({
		description: "build the app",
		subagentType: "general-purpose",
		prompt: "build",
		background: true,
	} as any);
	await $.tool.call({ tool: "Bash", command: "npm run build", agentId: "a1" } as any);
	await $.tool.call({ tool: "Bash", command: "sleep 9", description: "slow job", run_in_background: true } as any);
	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	await $.tool.call({
		tool: "Bash",
		command: "sleep 1",
		description: "wf shell",
		run_in_background: true,
		agentId: "wf-agent",
	} as any);
	await clock.advance(1000);

	let drawn = await texts();
	expect(drawn).toContain("build the app");
	expect(drawn).toContain("haiku");
	expect(drawn).toContain("Bash");
	expect(drawn).toContain("npm run build");
	expect(drawn).toContain("⎿ Compiled in 19.5s");
	expect(drawn).toContain("slow job");
	expect(drawn).toContain("review");
	expect(tally(drawn)).toContain("3 running");
	expect(drawn).not.toContain("wf shell");
	expect(drawn).toContain("~3m left");

	await $.turn.complete({
		turnId: "t1",
		agentId: "a1",
		answer: "shipped",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await clock.advance(300);
	drawn = await texts();
	expect(tally(drawn)).toContain("2 running · 1 done");

	await $.tool.call({ tool: "Bash", command: "sleep 9", description: "second job", run_in_background: true } as any);
	await clock.advance(300);
	await view.unmount();
	const widthsIn = async (mount: typeof BAND) => {
		const ui = await $.ui.mount(mount);
		const widths = (await ui.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.width);
		await ui.unmount();
		return widths;
	};
	expect(await widthsIn(BAND)).toEqual([26, 26, 26, 26]);
	view = await $.ui.mount(BAND);

	await $.prompt.submit({ text: "next thing", origin: { kind: "composer" } } as any);
	await clock.advance(1100);
	drawn = await texts();
	expect(drawn).not.toContain("build the app");
	expect(drawn).toContain("slow job");
	await view.unmount();
});

test("each agent of a workflow run gets its own live box, kept across a retry", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on, { now: 1_000_000 });
	const DIR = "/runs/wf_9";
	const KEY_A = `v2:${"a".repeat(64)}`;
	const KEY_B = `v2:${"b".repeat(64)}`;
	const started = (key: string, agentId: string, label: string) =>
		`${JSON.stringify({ type: "started", key, agentId, label, phase: "Lenses" })}\n`;
	let journal = '{"type":"launched"}\n';
	const files: Record<string, number> = {};
	on(
		"agent.spawn",
		($e: any, e: any) =>
			({ model: "claude-haiku-4-5-20251001", agentId: e.description === "lens:alpha" ? "aA1" : "aB1" }) as any,
	);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on(
		"fs.list",
		($e: any, e: any) =>
			({
				value:
					e.path === DIR
						? [
								{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false },
								...Object.entries(files).map(([name, mtimeMs]) => ({
									name,
									kind: "file",
									size: 100,
									mtimeMs,
									isLink: false,
								})),
							]
						: [],
			}) as any,
	);
	on(
		"process.run",
		($e: any, e: any) =>
			({
				value: {
					exitCode: 0,
					stdout: e.argv?.[0] === "cut" ? journal : "",
					stderr: "",
					isStdoutTruncated: false,
					isStderrTruncated: false,
				},
			}) as any,
	);
	on("tool.call", ($e: any, e: any) =>
		e.tool === "Workflow"
			? ({
					result: { status: "async_launched", taskId: "w9", runId: "wf_9", workflowName: "review", transcriptDir: DIR },
					text: "launched",
				} as any)
			: e.tool === "Read"
				? ({ result: {}, text: "1\tone\n2\ttwo" } as any)
				: ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" } as any),
	);
	on("turn.step", async function* ($e: any, e: any) {
		return {
			turnId: e.turnId,
			index: e.index,
			answer: "",
			toolUses: [],
			stopReason: "tool_use",
			usage: {
				input_tokens: 10,
				cache_read_input_tokens: 20000,
				cache_creation_input_tokens: 0,
				output_tokens: 90,
				model: e.model,
			},
		} as any;
	});
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");

	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	for (const [label, agentIndex] of [
		["lens:alpha", 1],
		["lens:beta", 2],
	] as const)
		await $.agent.spawn({
			description: label,
			subagentType: "workflow-subagent",
			prompt: label,
			background: false,
			workflow: { runId: "wf_9", agentIndex },
		} as any);
	journal += started(KEY_A, "aA1", "lens:alpha") + started(KEY_B, "aB1", "lens:beta");
	files["agent-aA1.meta.json"] = clock.now();
	files["agent-aB1.meta.json"] = clock.now();
	const step = $.turn.step({
		turnId: "t1",
		index: 0,
		model: "claude-haiku-4-5-20251001",
		messageCount: 11,
		agentId: "aA1",
	} as any);
	for await (const _ of step) void _;
	await $.tool.call({ tool: "Read", file_path: "/w/input.txt", agentId: "aA1" } as any);
	await clock.advance(1000);

	let drawn = await texts();
	expect((drawn.match(/lens:alpha/g) ?? []).length).toBe(1);
	expect((drawn.match(/lens:beta/g) ?? []).length).toBe(1);
	expect(drawn).not.toContain("⧉ review");
	expect(drawn).toContain("/w/input.txt");
	expect(drawn).toContain("⎿ Read 2 lines");
	expect(drawn).toContain("haiku");
	expect(drawn).toContain("running · ~3m left · 20.1k tokens · review");
	expect(drawn).toContain("20.1k tokens");
	expect(tally(drawn)).toContain("2 running");
	expect(drawn).toContain("~3m left");

	await clock.advance(59_000);
	await $.turn.complete({
		turnId: "t1",
		agentId: "aA1",
		answer: "",
		durationMs: 60_000,
		isAborted: false,
		reason: "answer",
	} as any);
	journal += `${JSON.stringify({ type: "result", key: KEY_A, agentId: "aA1", result: { ok: true } })}\n`;
	await clock.advance(1000);
	drawn = await texts();
	expect(tally(drawn)).toContain("1 running · 1 done");
	expect(drawn).toContain("done · 20.1k tokens · review");

	journal += started(KEY_B, "aB2", "lens:beta");
	files["agent-aB2.meta.json"] = clock.now();
	await $.turn.complete({
		turnId: "t2",
		agentId: "aB1",
		answer: "",
		durationMs: 61_000,
		isAborted: true,
		reason: "aborted",
	} as any);
	await clock.advance(1000);
	await $.tool.call({ tool: "Bash", command: "ls /w", agentId: "aB2" } as any);
	await $.tool.call({ tool: "Bash", command: "echo late", agentId: "aB1" } as any);
	await clock.advance(300);
	drawn = await texts();
	expect(drawn).toContain("retry 1");
	expect(drawn).toContain("ls /w");
	expect(drawn).not.toContain("echo late");
	expect((drawn.match(/lens:beta/g) ?? []).length).toBe(1);

	journal += `${JSON.stringify({ type: "result", key: KEY_B, agentId: "aB2", result: { ok: true } })}\n`;
	await clock.advance(1000);
	drawn = await texts();
	expect(tally(drawn)).toContain("2 done");
	await view.unmount();
});

test("the grid shows itself in the band while anything is in it, steps aside while you type, and /workflow closes or pins", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	const closed: any[] = [];
	const panes: any[] = [];
	let draft = "";
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }) as any);
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
	const order: string[] = [];
	on("prompt.read", () => {
		order.push("read draft");
		return { value: { text: draft } } as any;
	});
	on("state.set", ($e: any, e: any, next: any) => {
		if (e.key === "cards") order.push("write cards");
		return next(e);
	});
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: panes.map((p) => ({ ...p })) }) as any);
	on("ui.close", ($e: any, e: any) => {
		closed.push(e);
		panes.splice(0, panes.length);
		return { value: undefined } as any;
	});
	on("ui.render", ($e: any, e: any) => {
		const { Text } = $e.ui.resolve(e);
		return <Text>engine band</Text>;
	});

	panes.push({ id: "grid", title: "Agents", isShown: true, isFocused: true, isPlaced: true });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	expect(closed).toEqual([expect.objectContaining({ id: "grid" })]);
	const workflow = () =>
		$.command.run({
			command: "workflow",
			args: "",
			origin: { kind: "composer" },
			presentation: { isFullscreen: true, columns: 104 },
		} as any);
	const band = async (props: object = {}) => {
		const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } });
		const text = [
			...(await ui.findAll({ type: "Text" })).map((t) => t.text),
			...(await ui.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
		await ui.unmount();
		return text;
	};

	expect(await band()).toBe("engine band");
	expect((await workflow()).text).toBeUndefined();
	expect(await band()).toContain("no subagents, workflows or background shells yet · /workflow hides it");
	await workflow();
	expect(await band()).toBe("engine band");

	await $.agent.spawn({ description: "a1", subagentType: "general-purpose", prompt: "x", background: true } as any);
	await clock.advance(300);
	const drawn = await band();
	expect(tally(drawn)).toBe("1 running");
	expect(drawn).toContain("1 agent");
	expect(drawn).not.toMatch(/agents · \d+ running/);
	expect(await band({ hasSurvey: true })).toBe("engine band");
	draft = "hello";
	await clock.advance(400);
	expect(await band()).toBe("engine band");
	draft = "";
	await clock.advance(400);
	expect(tally(await band())).toBe("1 running");
	draft = "something";
	await clock.advance(400);
	expect(await band()).toBe("engine band");
	draft = "";
	await $.prompt.submit({ text: "something", origin: { kind: "composer" } } as any);
	expect(tally(await band())).toBe("1 running");

	draft = "half-typed";
	await clock.advance(400);
	expect(await band()).toBe("engine band");
	await $.prompt.submit({ text: "from the phone", origin: { kind: "bridge" } } as any);
	expect(await band()).toBe("engine band");
	draft = "";
	await clock.advance(400);

	await $.turn.complete({
		turnId: "t1",
		agentId: "a1",
		answer: "ok",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await clock.advance(300);
	expect(tally(await band())).toBe("1 done");
	await workflow();
	expect(await band()).toBe("engine band");

	await $.agent.spawn({ description: "a2", subagentType: "general-purpose", prompt: "y", background: true } as any);
	await clock.advance(300);
	const opener = await $.ui.mount(BAND);
	await opener.press({ key: "box:a2" });
	await clock.advance(10);
	expect((await opener.findAll({ type: "Button" })).map((b) => b.props.key)).toEqual(["open:a2"]);
	await workflow();
	await clock.advance(10);
	expect((await opener.findAll({ type: "Button" })).map((b) => b.props.key)).toEqual(["box:a2"]);
	await opener.unmount();

	await $.turn.complete({
		turnId: "t2",
		agentId: "a2",
		answer: "ok",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await clock.advance(300);
	draft = "next";
	await clock.advance(400);
	expect(await band()).toBe("engine band");
	draft = "";
	order.length = 0;
	await $.prompt.submit({ text: "next", origin: { kind: "composer" } } as any);
	expect(order).toEqual(["write cards", "read draft"]);
	expect(await band()).toBe("engine band");

	await $.agent.spawn({ description: "a3", subagentType: "general-purpose", prompt: "z", background: true } as any);
	await $.turn.complete({
		turnId: "t3",
		agentId: "a3",
		answer: "ok",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await clock.advance(300);
	expect(tally(await band())).toBe("1 done");
	await $.prompt.submit({ text: "/etc/hosts what is this?", origin: { kind: "composer" } } as any);
	expect(await band()).toBe("engine band");

	await workflow();
	expect(await band({ hasSurvey: true })).toBe("engine band");
	await $.prompt.submit({ text: "more", origin: { kind: "composer" } } as any);
	expect(await band()).toBe("engine band");

	panes.push({ id: "grid", title: "Agents", isShown: true, isFocused: false, isPlaced: true });
	await workflow();
	expect(closed).toEqual([expect.objectContaining({ id: "grid" }), expect.objectContaining({ id: "grid" })]);
});

test(
	"a running run keeps every box through a prompt, a retry reuses its box (one 45 s later gets one again), a resumed key runs again, and time left stays honest",
	{ timeoutMs: 20_000 },
	async ($, on) => {
		on("process.spawn", noProbe);
		const clock = mock.clock(on, { now: 2_000_000 });
		const DIR = "/runs/wf_7";
		const KEY_A = `v2:${"c".repeat(64)}`;
		const KEY_B = `v2:${"d".repeat(64)}`;
		const row = (o: object) => `${JSON.stringify(o)}\n`;
		let journal = row({ type: "launched" });
		const state: Record<string, unknown> = {};
		on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
		on("command.register", () => ({ value: undefined }) as any);
		on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
		on("prompt.read", () => ({ value: { text: "" } }) as any);
		on("env.get", () => ({ value: "/home/t" }) as any);
		on(
			"fs.list",
			($e: any, e: any) =>
				({
					value:
						e.path === DIR
							? [{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false }]
							: [],
				}) as any,
		);
		on(
			"process.run",
			($e: any, e: any) =>
				({
					value: {
						exitCode: 0,
						stdout: e.argv?.[0] === "cut" ? journal : "",
						stderr: "",
						isStdoutTruncated: false,
						isStderrTruncated: false,
					},
				}) as any,
		);
		on("state.set", ($e: any, e: any, next: any) => {
			state[`${e.plugin}.${e.key}`] = e.value;
			return next(e);
		});
		let opens = 0;
		on("ui.open", () => {
			opens++;
			return { value: { isPlaced: true } } as any;
		});
		on("ui.panes", () => ({ value: [] }) as any);
		on("ui.close", () => ({ value: undefined }) as any);
		on("tool.call", ($e: any, e: any) =>
			e.tool === "Workflow"
				? ({
						result: {
							status: "async_launched",
							taskId: "w7",
							runId: "wf_7",
							workflowName: "audit",
							transcriptDir: DIR,
						},
						text: "launched",
					} as any)
				: ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" } as any),
		);
		on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
		on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

		await $.session.start({ source: "startup", cwd: "/tmp" } as any);
		let view = await $.ui.mount(BAND);
		const texts = async () =>
			[
				...(await view.findAll({ type: "Text" })).map((t) => t.text),
				...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
			].join("\n");

		await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
		journal += row({ type: "started", key: KEY_A, agentId: "aA1", label: "scan:alpha", phase: "Scan" });
		journal +=
			row({ type: "started", key: KEY_B, agentId: "bB1", label: "scan:beta", phase: "Scan" }) +
			row({ type: "failed", key: KEY_B, agentId: "bB1" });
		journal += row({ type: "started", key: KEY_B, agentId: "bB2", label: "scan:beta", phase: "Scan" });
		await clock.advance(1000);
		let drawn = await texts();
		expect(drawn).toContain("scan:alpha");
		expect(tally(drawn)).toContain("2 running");
		expect(drawn).not.toContain("failed");
		expect(drawn).toContain("retry 1");

		await $.turn.complete({
			turnId: "t1",
			agentId: "aA1",
			answer: "",
			durationMs: 9000,
			isAborted: true,
			reason: "aborted",
		} as any);
		await $.prompt.submit({ text: "meanwhile", origin: { kind: "composer" } } as any);
		await clock.advance(1000);
		drawn = await texts();
		expect(drawn).toContain("scan:alpha");
		expect(tally(drawn)).toContain("1 failed");
		journal += row({ type: "started", key: KEY_A, agentId: "aA2", label: "scan:alpha", phase: "Scan" });
		await clock.advance(1000);
		drawn = await texts();
		expect(tally(drawn)).toContain("2 running");
		expect((drawn.match(/scan:alpha/g) ?? []).length).toBe(1);
		await $.turn.complete({
			turnId: "t2",
			agentId: "aA2",
			answer: "",
			durationMs: 9000,
			isAborted: true,
			reason: "aborted",
		} as any);
		await clock.advance(45_000);
		expect(await texts()).not.toContain("scan:alpha");
		journal += row({ type: "started", key: KEY_A, agentId: "aA3", label: "scan:alpha", phase: "Scan" });
		await clock.advance(1000);
		drawn = await texts();
		expect(tally(drawn)).toContain("2 running");
		expect(drawn).toContain("retry 2");

		await view.unmount();
		await clock.advance(200_000);
		view = await $.ui.mount(BAND);
		drawn = await texts();
		expect(drawn).toMatch(/running \dm/);
		expect(drawn).not.toContain("~60s left");
		await view.unmount();

		for (const presentation of [
			{ isFullscreen: true, columns: 104 },
			{ isFullscreen: false, columns: 104 },
			{ isFullscreen: true, columns: 200 },
		]) {
			const run = () =>
				$.command.run({ command: "workflow", args: "", origin: { kind: "composer" }, presentation } as any);
			await run();
			expect(state["agent-grid.band"]).toBe(true);
			await run();
			expect(state["agent-grid.band"]).toBe(false);
		}
		expect(opens).toBe(0);
	},
);

test("each frame wears its own color, the one its Clawd wears: no two boxes share one; red when it failed", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	const MODEL: Record<string, string> = {
		op: "claude-opus-5-5",
		so: "claude-sonnet-5-5",
		ha: "claude-haiku-4-5-20251001",
		fa: "claude-fable-5-1",
		no: "mystery-model-1",
		ne: "claude-haiku-4-5-20251001",
	};
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: MODEL[e.description], agentId: e.description }) as any);
	on("tool.call", () => ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }) as any);
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["op", "so", "ha", "fa", "no"])
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await $.turn.complete({
		turnId: "t",
		agentId: "ha",
		answer: "",
		durationMs: 5,
		isAborted: true,
		reason: "aborted",
	} as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const colors = Object.fromEntries(
		(await view.findAll({ type: "Box" }))
			.filter((b) => b.props.borderStyle)
			.map((b) => [String(b.key ?? b.props.key), b.props.borderColor]),
	);
	expect(colors["frame:ha"]).toBe("error");
	const own = ["frame:op", "frame:so", "frame:fa", "frame:no"].map((k) => colors[k] as string);
	expect(own.every((c) => /^rgb\(\d+,\d+,\d+\)$/.test(c))).toBe(true);
	expect(new Set(own).size).toBe(4);
	await $.agent.spawn({ description: "ne", subagentType: "general-purpose", prompt: "ne", background: true } as any);
	await $.tool.call({ tool: "Bash", command: "echo again", agentId: "ha" } as any);
	await clock.advance(300);
	const again = (await view.findAll({ type: "Box" }))
		.filter((b) => b.props.borderStyle)
		.map((b) => b.props.borderColor as string);
	expect(again.length).toBe(6);
	expect(new Set(again).size).toBe(6);
	await view.unmount();
});

test("the arrows walk the boxes: each title is a stop, the first takes the ring, the chosen box keeps the ring and is scrolled into view", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on(
		"agent.spawn",
		($e: any, e: any) =>
			({ model: "claude-haiku-4-5-20251001", agentId: e.description === "one" ? "a1" : "a2" }) as any,
	);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.agent.spawn({ description: "one", subagentType: "general-purpose", prompt: "x", background: true } as any);
	await $.agent.spawn({ description: "two", subagentType: "general-purpose", prompt: "y", background: true } as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const buttons = await view.findAll({ type: "Button" });
	expect(buttons.map((b) => b.props.key)).toEqual(["box:a1", "box:a2"]);
	expect(buttons[0]!.props.autoFocus).toBe(true);
	expect(buttons[1]!.props.autoFocus).toBeUndefined();
	const frames = async () =>
		(await view.findAll({ type: "Box" }))
			.filter((b) => b.props.borderStyle)
			.map((b) => `${b.props.borderStyle}:${b.props.borderColor}`);
	const [c1, c2] = (await frames()).map((f) => f.split(":").slice(1).join(":"));
	expect(c1).not.toBe(c2);
	expect(await frames()).toEqual([`round:${c1}`, `round:${c2}`]);

	await $.ui.focus({
		component: "AbovePrompt",
		requestId: "above-prompt",
		element: "box:a2",
		origin: { kind: "person" },
	} as any);
	await clock.advance(10);
	expect(await frames()).toEqual([`round:${c1}`, `round:${c2}`]);

	await $.ui.focus({
		component: "AbovePrompt",
		requestId: "above-prompt",
		element: "box:a1",
		origin: { kind: "person" },
	} as any);
	await clock.advance(10);
	expect(await frames()).toEqual([`round:${c1}`, `round:${c2}`]);
	await view.unmount();
});

test("↑ ↓ go to the box above or below, ← → to the one beside; a redraw that moves the chosen box keeps it chosen", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	const engineScrolls: any[] = [];
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }) as any);
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", ($e: any, e: any) => {
		engineScrolls.push(e);
		return {} as any;
	});
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["a1", "a2", "a3", "a4", "a5"])
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const titles = async () => (await view.findAll({ type: "Button" })).map((b) => String(b.props.key));
	expect(await titles()).toEqual(["box:a1", "box:a2", "box:a3", "box:a4", "box:a5"]);
	const chosen = async () =>
		(await view.findAll({ type: "Button" }))
			.filter((b) => b.props.autoFocus)
			.map((b) => `frame:${String(b.props.key).slice(4)}`);
	const widths = (await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.width);
	expect(widths).toEqual([34, 34, 36, 34, 34]);
	expect((await view.findAll({ type: "Button" })).filter((b) => b.props.autoFocus).map((b) => b.props.key)).toEqual([
		"box:a1",
	]);
	const arrow = (by: number) =>
		$.ui.scroll({
			component: "AbovePrompt",
			requestId: "above-prompt",
			offset: 0,
			by,
			bodyRows: 17,
			contentRows: 30,
			origin: { kind: "person" },
		} as any);
	const beside = (key: string) =>
		$.ui.focus({
			component: "AbovePrompt",
			requestId: "above-prompt",
			element: key,
			origin: { kind: "person" },
		} as any);

	await arrow(17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a4"]);
	expect(engineScrolls.filter((s) => s.origin?.kind === "person")).toEqual([]);
	await beside("box:a5");
	await arrow(-17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a2"]);
	await beside("box:a3");
	await arrow(17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a5"]);
	await arrow(17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a5"]);
	await arrow(-17);
	await arrow(-17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a2"]);
	await $.ui.scroll({
		component: "AbovePrompt",
		requestId: "above-prompt",
		offset: 1,
		by: 1,
		bodyRows: 17,
		contentRows: 30,
		origin: { kind: "person" },
		pointer: { row: 3, column: 40 },
	} as any);
	expect(engineScrolls.filter((s) => s.origin?.kind === "person" && s.pointer)).toHaveLength(1);

	await $.turn.complete({
		turnId: "t1",
		agentId: "a1",
		answer: "ok",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await clock.advance(600);
	expect(await titles()).toEqual(["box:a2", "box:a3", "box:a4", "box:a5", "box:a1"]);
	expect(await chosen()).toEqual(["frame:a2"]);

	await $.prompt.submit({ text: "next", origin: { kind: "composer" } } as any);
	await clock.advance(600);
	expect(await titles()).toEqual(["box:a2", "box:a3", "box:a4", "box:a5"]);
	await beside("box:a3");
	await $.turn.complete({
		turnId: "t2",
		agentId: "a3",
		answer: "ok",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await $.prompt.submit({ text: "again", origin: { kind: "composer" } } as any);
	await clock.advance(600);
	expect(await titles()).toEqual(["box:a2", "box:a4", "box:a5"]);
	expect(await chosen()).toEqual(["frame:a4"]);
	await view.unmount();
});

test("Home and End go to the first and last row, ↓ one row, with the numbers the band sends", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["a1", "a2", "a3", "a4", "a5"])
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await clock.advance(300);
	const view = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 52 } });
	expect((await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.width)).toEqual([
		28, 29, 28, 29, 28,
	]);
	expect(rowsOf(await view.drawn())).toBe(16);
	const chosen = async () =>
		(await view.findAll({ type: "Button" }))
			.filter((b) => b.props.autoFocus)
			.map((b) => `frame:${String(b.props.key).slice(4)}`);
	const key = (by: number, bodyRows: number, contentRows: number) =>
		$.ui.scroll({
			component: "AbovePrompt",
			requestId: "above-prompt",
			offset: 0,
			by,
			bodyRows,
			contentRows,
			origin: { kind: "person" },
		} as any);

	await key(41, 30, 41);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a5"]);
	await key(-41, 30, 41);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a1"]);
	await key(16, 17, 16);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a5"]);
	await key(-16, 17, 16);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a1"]);
	await key(17, 17, 16);
	await clock.advance(10);
	expect(await chosen()).toEqual(["frame:a3"]);
	await view.unmount();
});

test("an opened box that leaves the drawing puts the view back on the grid", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on, { now: 4_000_000 });
	const DIR = "/runs/wf_9";
	const row = (o: object) => `${JSON.stringify(o)}\n`;
	let journal = row({ type: "launched" });
	const state: Record<string, unknown> = {};
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on(
		"fs.list",
		($e: any, e: any) =>
			({
				value:
					e.path === DIR
						? [{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false }]
						: [],
			}) as any,
	);
	on(
		"process.run",
		($e: any, e: any) =>
			({
				value: {
					exitCode: 0,
					stdout: e.argv?.[0] === "cut" ? journal : "",
					stderr: "",
					isStdoutTruncated: false,
					isStderrTruncated: false,
				},
			}) as any,
	);
	on(
		"tool.call",
		() =>
			({
				result: { status: "async_launched", taskId: "w9", runId: "wf_9", workflowName: "sweep", transcriptDir: DIR },
				text: "launched",
			}) as any,
	);
	on("state.set", ($e: any, e: any, next: any) => {
		state[`${e.plugin}.${e.key}`] = e.value;
		return next(e);
	});
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	await view.press({ key: "box:wf:wf_9" });
	await clock.advance(10);
	expect((await view.findAll({ type: "Button" })).map((b) => b.props.key)).toEqual(["open:wf:wf_9"]);
	expect(state["agent-grid.view"]).toEqual({ expanded: "wf:wf_9", start: -1 });
	journal += row({ type: "started", key: `v2:${"e".repeat(64)}`, agentId: "aX1", label: "sweep:one", phase: "Go" });
	await clock.advance(1300);
	const drawn = await texts();
	expect((await view.findAll({ type: "Button" })).map((b) => b.props.key)[0]).toMatch(/^box:/);
	expect(drawn).toContain("sweep:one");
	expect(state["agent-grid.view"]).toEqual({ expanded: "", start: -1 });
	await view.unmount();
});

test("Enter opens a box to the whole view: all its rows, scrolled by the arrows and the wheel; Enter goes back to the grid", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	const engineScrolls: any[] = [];
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on(
		"agent.spawn",
		($e: any, e: any) =>
			({ model: "claude-haiku-4-5-20251001", agentId: e.description === "one" ? "a1" : "a2" }) as any,
	);
	on(
		"tool.call",
		($e: any, e: any) =>
			({ result: { stdout: `out ${e.command}`, stderr: "", interrupted: false }, text: `out ${e.command}` }) as any,
	);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", ($e: any, e: any) => {
		engineScrolls.push(e);
		return {} as any;
	});
	on("ui.close", () => ({ value: undefined }) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.agent.spawn({ description: "one", subagentType: "general-purpose", prompt: "x", background: true } as any);
	await $.agent.spawn({ description: "two", subagentType: "general-purpose", prompt: "y", background: true } as any);
	for (let i = 1; i <= 20; i++) await $.tool.call({ tool: "Bash", command: `step ${i}`, agentId: "a1" } as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	expect((await view.findAll({ type: "Button" })).map((b) => b.props.key)).toEqual(["box:a1", "box:a2"]);
	expect((await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.height)).toEqual([
		15, 15,
	]);
	expect(rowsOf(await view.drawn())).toBe(16);

	await view.press({ key: "box:a1" });
	await clock.advance(10);
	let drawn = await texts();
	expect(drawn).toContain("28–40 of 40");
	expect(drawn).toContain("⎿ out step 20");
	expect(drawn).not.toContain("two");
	expect((await view.findAll({ type: "Button" })).map((b) => b.props.key)).toEqual(["open:a1"]);

	const key = (by: number) =>
		$.ui.scroll({
			component: "AbovePrompt",
			requestId: "above-prompt",
			offset: 0,
			by,
			bodyRows: 17,
			contentRows: 17,
			origin: { kind: "person" },
		} as any);
	await key(-17);
	await clock.advance(10);
	expect(await texts()).toContain("27–39 of 40");
	expect(engineScrolls).toEqual([]);
	await key(17);
	await clock.advance(10);
	expect(await texts()).toContain("28–40 of 40");
	await key(-34);
	await clock.advance(10);
	expect(await texts()).toContain("26–38 of 40");
	await key(34);
	await clock.advance(10);
	expect(await texts()).toContain("28–40 of 40");
	await $.ui.scroll({
		component: "AbovePrompt",
		requestId: "above-prompt",
		offset: 0,
		by: -3,
		bodyRows: 17,
		contentRows: 17,
		origin: { kind: "person" },
		pointer: { row: 4, column: 10 },
	} as any);
	await clock.advance(10);
	expect(await texts()).toContain("25–37 of 40");
	await key(17);
	await key(17);
	await key(17);
	await clock.advance(10);
	expect(await texts()).toContain("28–40 of 40");

	await view.press({ key: "open:a1" });
	await clock.advance(10);
	drawn = await texts();
	expect((await view.findAll({ type: "Button" })).map((b) => b.props.key)).toEqual(["box:a1", "box:a2"]);
	expect(drawn).toContain("two");
	await view.press({ key: "box:a1" });
	await clock.advance(10);
	expect(await texts()).toContain("28–40 of 40");
	await view.unmount();
});

test("a run still going shows every agent, finished ones too, their rows read back from the agent transcripts; one long finished stays closed", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on, { now: 3_000_000 });
	const DIR = "/runs/wf_5";
	const row = (o: object) => `${JSON.stringify(o)}\n`;
	const KEY = (c: string) => `v2:${c.repeat(64)}`;
	const journal =
		row({ type: "launched" }) +
		row({ type: "started", key: KEY("d"), agentId: "aD1", label: "check:old", phase: "Check" }) +
		row({ type: "result", key: KEY("d"), agentId: "aD1", result: { ok: true } }) +
		row({ type: "started", key: KEY("e"), agentId: "aE1", label: "check:early", phase: "Check" }) +
		row({ type: "result", key: KEY("e"), agentId: "aE1", result: { ok: true } }) +
		row({ type: "started", key: KEY("f"), agentId: "aF1", label: "check:late", phase: "Check" });
	const transcript =
		"cut first line\n" +
		row({
			type: "assistant",
			message: {
				model: "claude-haiku-4-5-20251001",
				usage: { input_tokens: 5, output_tokens: 7 },
				content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls /srv" } }],
			},
		}) +
		row({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "srv-a\nsrv-b", is_error: false }] },
		}) +
		row({
			type: "assistant",
			message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Two servers found." }] },
		});
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on(
		"fs.list",
		($e: any, e: any) =>
			({
				value:
					e.path === DIR
						? [
								{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false },
								{ name: "agent-aD1.jsonl", kind: "file", size: transcript.length, mtimeMs: 2_900_000, isLink: false },
								{ name: "agent-aE1.jsonl", kind: "file", size: transcript.length, mtimeMs: 2_999_000, isLink: false },
							]
						: [],
			}) as any,
	);
	const tailed: string[] = [];
	on("process.run", ($e: any, e: any) => {
		if (e.argv?.[0] === "tail") tailed.push(String(e.argv.at(-1)));
		const out =
			e.argv?.[0] === "cut"
				? journal
				: e.argv?.[0] === "tail" && String(e.argv.at(-1)).endsWith("agent-aE1.jsonl")
					? transcript
					: "";
		return {
			value: { exitCode: 0, stdout: out, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
		} as any;
	});
	on(
		"tool.call",
		($e: any, e: any) =>
			({
				result: { status: "async_launched", taskId: "w5", runId: "wf_5", workflowName: "audit", transcriptDir: DIR },
				text: "launched",
			}) as any,
	);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	await clock.advance(1000);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	let drawn = await texts();
	expect(tally(drawn)).toContain("1 running · 1 done");
	expect(drawn).toContain("check:early");
	expect(drawn).toContain("check:late");
	expect(drawn).not.toContain("check:old");
	expect(tailed.some((f) => f.endsWith("agent-aD1.jsonl"))).toBe(false);
	expect(drawn).toContain("ls /srv");
	expect(drawn).toContain("⎿ srv-a");
	expect(drawn).toContain("Two servers found.");
	expect(drawn).toContain("haiku");

	await $.prompt.submit({ text: "and now?", origin: { kind: "composer" } } as any);
	await clock.advance(300);
	drawn = await texts();
	expect(drawn).toContain("check:early");
	await view.unmount();
});

test("a grid taller than the band pages whole rows itself, under a row of its own: ↑ N more, what it holds in the middle, ↓ N more", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }) as any);
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("prompt.submit", ($e: any, e: any) => ({ text: e.text }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const ids = Array.from({ length: 20 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`);
	for (const id of ids)
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await clock.advance(300);
	let view = await $.ui.mount(BAND);

	const frames = async () =>
		(await view.findAll({ type: "Box" }))
			.filter((b) => b.props.borderStyle)
			.map((b) => String(b.key ?? b.props.key ?? "").slice(6));
	const chosen = async () =>
		(await view.findAll({ type: "Button" })).filter((b) => b.props.autoFocus).map((b) => String(b.props.key).slice(4));
	const titles = async () => (await view.findAll({ type: "Button" })).map((b) => String(b.props.key).slice(4));
	const cue = async () => (await view.find({ type: "Text", text: /agents/ }))?.text;
	const arrow = (by: number, contentRows = 16) =>
		$.ui.scroll({
			component: "AbovePrompt",
			requestId: "above-prompt",
			offset: 0,
			by,
			bodyRows: 17,
			contentRows,
			origin: { kind: "person" },
		} as any);

	expect(rowsOf(await view.drawn())).toBe(16);
	expect(await frames()).toEqual(ids.slice(0, 12));
	expect(await titles()).toEqual(ids);
	let line = (await cue())!;
	expect(line).toHaveLength(104);
	expect(line.indexOf("20 agents")).toBe(Math.floor((104 - "20 agents".length) / 2));
	expect(line.trimStart().startsWith("20 agents")).toBe(true);
	expect(line.endsWith("↓ 8 more")).toBe(true);
	await view.unmount();
	view = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 20, scroll: { offset: 0, bodyRows: 20 } } });
	expect((await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.height)).toEqual(
		Array(12).fill(6),
	);
	expect(rowsOf(await view.drawn())).toBe(19);
	await view.unmount();
	view = await $.ui.mount(BAND);

	await arrow(17);
	await arrow(17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a09"]);
	expect(await frames()).toEqual(ids.slice(0, 12));
	await arrow(17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a13"]);
	expect(await frames()).toEqual(ids.slice(4, 16));
	line = (await cue())!;
	expect(line.startsWith("↑ 4 more")).toBe(true);
	expect(line.endsWith("↓ 4 more")).toBe(true);
	expect(line.indexOf("20 agents")).toBe(47);
	expect(rowsOf(await view.drawn())).toBe(16);
	await arrow(-17);
	await arrow(-17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a05"]);
	expect(await frames()).toEqual(ids.slice(4, 16));
	await view.unmount();
	view = await $.ui.mount({ ...BAND, surface: "desktop" as any, props: { ...BAND.props, bodyColumns: 52 } });
	expect(await frames()).toEqual(ids.slice(4, 10));
	await view.unmount();
	view = await $.ui.mount(BAND);
	expect(await frames()).toEqual(ids.slice(4, 16));

	await $.ui.focus({
		component: "AbovePrompt",
		requestId: "above-prompt",
		element: "box:a20",
		origin: { kind: "person" },
	} as any);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a20"]);
	expect(await frames()).toEqual(ids.slice(8, 20));
	line = (await cue())!;
	expect(line.startsWith("↑ 8 more")).toBe(true);
	expect(line.trimEnd().endsWith("20 agents")).toBe(true);
	await arrow(-16);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a04"]);
	expect(await frames()).toEqual(ids.slice(0, 12));
	await arrow(16);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a20"]);
	await arrow(-17);
	await clock.advance(10);
	expect(await chosen()).toEqual(["a16"]);
	expect(await frames()).toEqual(ids.slice(8, 20));

	for (const id of ids.slice(0, 16))
		await $.turn.complete({
			turnId: `t-${id}`,
			agentId: id,
			answer: "ok",
			durationMs: 5,
			isAborted: false,
			reason: "answer",
		} as any);
	await $.prompt.submit({ text: "next", origin: { kind: "composer" } } as any);
	await clock.advance(600);
	expect(await frames()).toEqual(ids.slice(16));
	line = (await cue())!;
	expect(line).toHaveLength(104);
	expect(line.indexOf("4 agents")).toBe(Math.floor((104 - "4 agents".length) / 2));
	expect(line.trim()).toBe("4 agents");
	expect((await view.findAll({ type: "Text" })).filter((t) => /more/.test(t.text))).toEqual([]);
	expect((await view.findAll({ type: "Box" })).filter((b) => b.props.display === "none")).toEqual([]);
	await view.unmount();
});

test("all of them in sight, a wide band too: the tally row under the boxes still says what the grid holds", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-opus-5-5", agentId: e.description }) as any);
	on("tool.call", ($e: any, e: any) =>
		e.tool === "Workflow"
			? ({
					result: {
						status: "async_launched",
						taskId: "w1",
						runId: "wf_1",
						workflowName: "sweep",
						transcriptDir: "/nonexistent/wf_1",
					},
					text: "launched",
				} as any)
			: ({
					result: { backgroundTaskId: `b-${e.description}`, stdout: "", stderr: "", interrupted: false },
					text: "Output is being written to: /nonexistent/tasks/b.output.",
				} as any),
	);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["c1", "c2", "c3", "c4", "c5"])
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	await $.tool.call({ tool: "Bash", command: "sleep 9", description: "slow job", run_in_background: true } as any);
	await clock.advance(300);
	const view = await $.ui.mount({
		...BAND,
		props: { ...BAND.props, bodyColumns: 230 },
		viewport: { ...BAND.viewport, columns: 235 },
	});
	expect((await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.width)).toEqual([
		33, 33, 33, 33, 33, 33, 37,
	]);
	const line = (await view.find({ type: "Text", text: /agents/ }))!.text;
	expect(line).toHaveLength(235);
	expect(line.trim()).toBe("1 workflow · 5 agents · 1 shell");
	expect(line.indexOf("1 workflow")).toBe(Math.floor((235 - "1 workflow · 5 agents · 1 shell".length) / 2));
	expect(line).not.toMatch(/more/);
	const root = (await view.drawn()) as any;
	expect((root.children ?? root.props?.children ?? []).at(-1)?.type).toBe("Text");
	await view.unmount();
});

test("busy boxes in a 99-column, 17-row band page two rows at a time, and the band comes back on the first page", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	let draft = "";
	on("prompt.read", () => ({ value: { text: draft } }) as any);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }) as any);
	on("tool.call", () => ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const ids = Array.from({ length: 10 }, (_, i) => `b${String(i + 1).padStart(2, "0")}`);
	for (const id of ids) {
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
		for (const n of [1, 2, 3, 4]) await $.tool.call({ tool: "Bash", command: `step ${n}`, agentId: id } as any);
	}
	await clock.advance(300);
	const NARROW = { ...BAND, props: { ...BAND.props, bodyColumns: 99 } };
	const view = await $.ui.mount(NARROW);
	const frames = async () =>
		(await view.findAll({ type: "Box" }))
			.filter((b) => b.props.borderStyle)
			.map((b) => `${String(b.key ?? b.props.key ?? "").slice(6)}:${b.props.height}`);
	const cue = async () => (await view.find({ type: "Text", text: /agents/ }))?.text;
	const arrow = (by: number) =>
		$.ui.scroll({
			component: "AbovePrompt",
			requestId: "above-prompt",
			offset: 0,
			by,
			bodyRows: 17,
			contentRows: 16,
			origin: { kind: "person" },
		} as any);

	expect(await frames()).toEqual(["b01:8", "b02:8", "b03:8", "b04:7", "b05:7", "b06:7"]);
	expect((await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.width)).toEqual([
		34, 34, 36, 34, 34, 36,
	]);
	expect((await cue())!).toHaveLength(104);
	expect((await cue())!.endsWith("↓ 4 more")).toBe(true);
	for (const _ of [1, 2, 3]) await arrow(17);
	await clock.advance(10);
	expect(await frames()).toEqual(["b07:8", "b08:8", "b09:8", "b10:7"]);
	expect((await cue())!.startsWith("↑ 6 more")).toBe(true);

	draft = "hello";
	await clock.advance(400);
	expect(await frames()).toEqual([]);
	draft = "";
	await clock.advance(400);
	expect(await frames()).toEqual(["b01:8", "b02:8", "b03:8", "b04:7", "b05:7", "b06:7"]);
	expect((await cue())!.trimStart().startsWith("10 agents")).toBe(true);
	await view.unmount();

	const short = await $.ui.mount({
		...NARROW,
		props: { ...NARROW.props, maxRows: 6, scroll: { offset: 0, bodyRows: 6 } },
	});
	expect((await short.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.height)).toEqual(
		Array(10).fill(8),
	);
	expect(await short.find({ type: "Text", text: /agents/ })).toBeUndefined();
	await short.unmount();
});

test("a band too short for the tally row and a box gives the box all of it; one row taller, the tally row is back", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on);
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }) as any);
	on("tool.call", () => ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.panes", () => ({ value: [] }) as any);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.agent.spawn({ description: "d1", subagentType: "general-purpose", prompt: "x", background: true } as any);
	for (const n of [1, 2, 3, 4, 5]) await $.tool.call({ tool: "Bash", command: `step ${n}`, agentId: "d1" } as any);
	await clock.advance(300);
	const heightsIn = async (maxRows: number) => {
		const ui = await $.ui.mount({
			...BAND,
			props: { ...BAND.props, maxRows, scroll: { offset: 0, bodyRows: maxRows } },
		});
		const out = {
			heights: (await ui.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.height),
			row: (await ui.find({ type: "Text", text: /agent/ }))?.text.trim(),
			rows: rowsOf(await ui.drawn()),
		};
		await ui.unmount();
		return out;
	};
	expect(await heightsIn(5)).toEqual({ heights: [5], row: undefined, rows: 5 });
	expect(await heightsIn(3)).toEqual({ heights: [5], row: undefined, rows: 5 });
	const short = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 5, scroll: { offset: 0, bodyRows: 5 } } });
	await short.press({ key: "box:d1" });
	await clock.advance(10);
	expect(rowsOf(await short.drawn())).toBe(5);
	await short.press({ key: "open:d1" });
	await short.unmount();
	expect(await heightsIn(6)).toEqual({ heights: [6], row: undefined, rows: 6 });
	expect(await heightsIn(7)).toEqual({ heights: [5], row: "1 agent", rows: 6 });
});

test("every box says what is happening as it happens: the model thinking and writing, a call's live output and processes, a shell's command and the files it reads and writes", async ($, on) => {
	const clock = mock.clock(on);
	const spawned: string[][] = [];
	let release = () => {};
	const built = new Promise<void>((resolve) => {
		release = resolve;
	});
	const proc = (pid: number, args: string, more: Record<string, unknown> = {}) => ({
		pid,
		args,
		state: "S",
		cpu: 0,
		rd: 0,
		wr: 0,
		rdps: 0,
		wrps: 0,
		files: [],
		nfiles: 0,
		...more,
	});
	const looks = {
		tasks: [
			{
				id: "bt1",
				cmd: "python3 - <<'EOF'\nimport re\nEOF",
				tail: [],
				more: 0,
				procs: [
					proc(10, "zsh", { root: true, rd: 100 }),
					proc(11, "python3 -", {
						state: "R",
						cpu: 99,
						rd: 123 << 20,
						wr: 2048,
						rdps: 20 << 20,
						files: [
							{ path: "/home/t/.local/share/claude/versions/2.1.289", mode: "r", pos: 123 << 20, size: 246 << 20 },
							{ path: "/home/t/out.txt", mode: "w", pos: 2048, size: 2048 },
							{ path: "/home/t/caf\udce9.txt", mode: "r", pos: 0, size: 10 },
						],
						nfiles: 12,
					}),
				],
			},
			{
				id: "fg1",
				cmd: "cargo build",
				tail: ["Compiling serde v1.0", "Compiling tokio v1.38"],
				more: 0,
				procs: [
					proc(20, "zsh", { root: true }),
					proc(21, "cargo build"),
					proc(22, "rustc --crate-name tokio\nsrc/lib.rs", { state: "R", cpu: 180 }),
				],
			},
			{
				id: "fg2",
				cmd: "cargo build",
				tail: ["Compiling clap v4.5"],
				more: 3,
				procs: [
					proc(30, "zsh", { root: true }),
					proc(31, "cargo build"),
					proc(32, "rustc --crate-name clap", { state: "R", cpu: 95 }),
				],
			},
		],
	};
	let wake = () => {};
	on("process.spawn", async function* ($e: any, e: any) {
		spawned.push([...e.argv]);
		for (;;) {
			yield { stream: "stdout", text: `${JSON.stringify(looks)}\n` };
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	} as any);
	const lookAgain = async () => {
		wake();
		await clock.advance(300);
	};
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on(
		"agent.spawn",
		($e: any, e: any) =>
			({ model: "claude-sonnet-4-5", agentId: e.description === "fix the build" ? "a1" : "a2" }) as any,
	);
	on("tool.call", async ($e: any, e: any) => {
		if (e.run_in_background)
			return {
				result: { backgroundTaskId: "bt1", stdout: "", stderr: "", interrupted: false },
				text: "Output is being written to: /nonexistent/tasks/bt1.output.",
			} as any;
		if (e.command === "cargo build") await built;
		if (e.tool === "Edit")
			return {
				result: { structuredPatch: [{ lines: [" a = 1", "-c = 3", "+c = 3", "+d = 4"] }] },
				text: "The file has been updated successfully.",
			} as any;
		return {
			result: { stdout: "ok", stderr: "", interrupted: false },
			text: e.tool === "Write" ? "File created successfully at: /home/t/app/conf.toml" : "ok",
		} as any;
	});
	on("turn.step", async function* ($e: any, e: any) {
		yield { kind: "thinking", index: 0, text: "The build is slow.\nChecking the config" };
		yield { kind: "text", index: 1, text: "Writing the " };
		yield { kind: "text", index: 1, text: "config now" };
		yield { kind: "tool", index: 2, id: "tu1", name: "Write" };
		yield { kind: "input", index: 2, json: '{"file_path":"/home/t/app/con' };
		yield { kind: "input", index: 2, json: 'f.toml","content":"a = \\"x\\\\n\\"\\nb = 2\\' };
		yield { kind: "input", index: 2, json: "nc" };
		yield { kind: "stop", stopReason: "tool_use", usage: null };
		return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "tool_use", usage: null } as any;
	} as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.focus", () => ({}) as any);
	on("ui.scroll", () => ({}) as any);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	const heights = async () =>
		(await view.findAll({ type: "Box" })).filter((b) => b.props.borderStyle).map((b) => b.props.height);

	await $.tool.call({
		tool: "Bash",
		command: "python3 - <<'EOF'\nimport re\nEOF",
		description: "search the binary",
		run_in_background: true,
	} as any);
	await clock.advance(1000);
	await clock.advance(1000);
	expect(spawned).toEqual([["node", expect.stringMatching(/\/hooks\/activity\.ts$/)]]);
	let drawn = await texts();
	expect(drawn).toContain("search the binary");
	expect(drawn).toContain("$ python3 - <<'EOF'");
	expect(drawn).toContain(" · +2 lines");
	expect(drawn).toContain("⚙ python3 -");
	expect(drawn).toContain(" · 99% CPU");
	expect(drawn).not.toContain("⚙ zsh");
	expect(drawn).toContain("  ← ~/.local/share/claude/versions/2.1.289");
	expect(drawn).toContain(" · 50% · 20.0 MB/s");
	expect(drawn).not.toContain("→ ~/out.txt");

	await $.agent.spawn({
		description: "fix the build",
		subagentType: "general-purpose",
		prompt: "x",
		background: true,
	} as any);
	const step = $.turn.step({
		turnId: "t1",
		index: 0,
		model: "claude-sonnet-4-5",
		messageCount: 3,
		agentId: "a1",
	} as any);
	const pull = async (n: number) => {
		for (let i = 0; i < n; i++) await step.next();
		await clock.advance(300);
	};
	await pull(1);
	expect(await texts()).toContain("✻ thinking: Checking the config");
	await pull(2);
	expect(await texts()).toContain("✎ Writing the config now");
	await pull(2);
	drawn = await texts();
	expect(drawn).toContain("Write");
	expect(drawn).toContain("● Write(~/app/con…)");
	expect(drawn).toContain(" · writing…");
	await pull(2);
	drawn = await texts();
	expect(drawn).toContain("● Write(~/app/conf.toml)");
	expect(drawn).toContain(" · writing 3 lines…");
	expect(drawn).not.toContain("✎ Writing the");
	await pull(2);
	expect(await texts()).not.toContain("writing 3 lines");

	await $.tool.call({
		tool: "Write",
		file_path: "/home/t/app/conf.toml",
		content: "a = 1\nb = 2\nc = 3",
		agentId: "a1",
	} as any);
	await $.tool.call({
		tool: "Edit",
		file_path: "/home/t/app/conf.toml",
		old_string: "c = 3",
		new_string: "c = 3\nd = 4",
		agentId: "a1",
	} as any);
	await clock.advance(300);
	drawn = await texts();
	expect(drawn).toContain("⎿ wrote 3 lines");
	expect(drawn).toContain("⎿ −1 +2 lines");

	await $.agent.spawn({
		description: "fix the cli",
		subagentType: "general-purpose",
		prompt: "y",
		background: true,
	} as any);
	const build = $.tool.call({ tool: "Bash", command: "cargo build", agentId: "a1" } as any);
	const build2 = $.tool.call({ tool: "Bash", command: "cargo build", agentId: "a2" } as any);
	await clock.advance(300);
	await lookAgain();
	drawn = await texts();
	expect(drawn).toContain("⎿ Compiling tokio v1.38");
	expect(drawn).not.toContain("⎿ Compiling serde v1.0");
	expect(drawn).toContain("⎿ Compiling clap v4.5");
	expect(drawn).toContain("⚙ rustc --crate-name tokio ⏎ src/lib.rs");
	expect(drawn).toContain(" · 180% CPU · +1");
	expect(drawn).toContain("⚙ rustc --crate-name clap");
	expect(drawn).toContain(" · 95% CPU · +4");
	expect(drawn).not.toContain("⚙ cargo build");

	const sized = await heights();
	looks.tasks[0]!.procs.push(proc(12, "sort", { cpu: 3 }), proc(13, "uniq -c", { cpu: 1 }));
	await lookAgain();
	expect(await texts()).toContain(" · 99% CPU · +2");
	expect(await heights()).toEqual(sized);

	await view.press({ key: "box:sh:bt1" });
	await clock.advance(10);
	drawn = await texts();
	expect(drawn).toContain("  import re");
	expect(drawn).toContain("99% CPU · read 123.0 MB (20.0 MB/s) · wrote 2.0 KB");
	expect(drawn).toContain("  → ~/out.txt");
	expect(drawn).toContain(" · 2.0 KB");
	expect(drawn).toContain("  ← ~/caf\uFFFD.txt");
	expect(drawn).toContain(" · 0% of 10 B");
	expect(drawn).toContain("+ 9 more files");
	expect(drawn).toContain("⚙ uniq -c");
	await $.ui.scroll({
		component: "AbovePrompt",
		requestId: "above-prompt",
		offset: 0,
		by: -17,
		bodyRows: 17,
		contentRows: 17,
		origin: { kind: "person" },
	} as any);
	await clock.advance(10);
	expect(await texts()).toContain("$ python3 - <<'EOF'");
	await view.press({ key: "open:sh:bt1" });

	release();
	await build;
	await build2;
	await clock.advance(1000);
	drawn = await texts();
	expect(drawn).toContain("⎿ ok");
	expect(drawn).not.toContain("Compiling tokio");
	expect(drawn).not.toContain("⚙ rustc");
	await view.unmount();
});

test("a finished box closes as its Clawd leaves: 4 s after it ends, the others stay", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on, { now: 1_000_000 });
	const DIR = "/runs/wf_7";
	const KEY_A = `v2:${"e".repeat(64)}`;
	const KEY_B = `v2:${"f".repeat(64)}`;
	const started = (key: string, agentId: string, label: string) =>
		`${JSON.stringify({ type: "started", key, agentId, label, phase: "Lenses" })}\n`;
	let journal = '{"type":"launched"}\n';
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on(
		"fs.list",
		($e: any, e: any) =>
			({
				value:
					e.path === DIR
						? [{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false }]
						: [],
			}) as any,
	);
	on(
		"process.run",
		($e: any, e: any) =>
			({
				value: {
					exitCode: 0,
					stdout: e.argv?.[0] === "cut" ? journal : "",
					stderr: "",
					isStdoutTruncated: false,
					isStderrTruncated: false,
				},
			}) as any,
	);
	on(
		"tool.call",
		() =>
			({
				result: { status: "async_launched", taskId: "w7", runId: "wf_7", workflowName: "sweep", transcriptDir: DIR },
				text: "launched",
			}) as any,
	);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	journal += started(KEY_A, "aA1", "lens:alpha") + started(KEY_B, "aB1", "lens:beta");
	await clock.advance(1000);
	expect(await texts()).toContain("lens:alpha");
	journal += `${JSON.stringify({ type: "result", key: KEY_A, agentId: "aA1", result: { ok: true } })}\n`;
	await clock.advance(1000);
	let drawn = await texts();
	expect(drawn).toContain("lens:alpha");
	await clock.advance(4000);
	drawn = await texts();
	expect(drawn).not.toContain("lens:alpha");
	expect(drawn).toContain("lens:beta");
	await view.unmount();
});

test("a subagent that runs another turn after its box closed (a message resumed it, a teammate woke) gets its box back", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on, { now: 1_000_000 });
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("agent.spawn", () => ({ model: "claude-haiku-4-5-20251001", agentId: "a1" }) as any);
	on("tool.call", () => ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }) as any);
	on("turn.complete", ($e: any, e: any) => ({ text: e.answer }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on("fs.list", () => ({ value: [] }) as any);
	on(
		"process.run",
		() =>
			({ value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) as any,
	);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	await $.agent.spawn({
		description: "triage the logs",
		subagentType: "general-purpose",
		prompt: "triage",
		background: true,
	} as any);
	await $.turn.complete({
		turnId: "t1",
		agentId: "a1",
		answer: "done",
		durationMs: 5,
		isAborted: false,
		reason: "answer",
	} as any);
	await clock.advance(6000);
	expect(await texts()).not.toContain("triage the logs");
	await $.tool.call({ tool: "Bash", command: "echo second turn", agentId: "a1" } as any);
	await clock.advance(1300);
	const drawn = await texts();
	expect(drawn).toContain("triage the logs");
	expect(drawn).toContain("echo second turn");
	expect(tally(drawn)).toContain("1 running");
	await view.unmount();
});

test("a run whose agents are done says which phase and how many; stopped with TaskStop, it says stopped", async ($, on) => {
	on("process.spawn", noProbe);
	const clock = mock.clock(on, { now: 1_000_000 });
	const DIR = "/runs/wf_8";
	const KEY_A = `v2:${"9".repeat(64)}`;
	let journal = `{"type":"launched"}\n${JSON.stringify({ type: "started", key: KEY_A, agentId: "aA1", label: "lens:alpha", phase: "Review" })}\n`;
	on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
	on("command.register", () => ({ value: undefined }) as any);
	on("env.get", () => ({ value: "/home/t" }) as any);
	on(
		"fs.list",
		($e: any, e: any) =>
			({
				value:
					e.path === DIR
						? [{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false }]
						: [],
			}) as any,
	);
	on(
		"process.run",
		($e: any, e: any) =>
			({
				value: {
					exitCode: 0,
					stdout: e.argv?.[0] === "cut" ? journal : "",
					stderr: "",
					isStdoutTruncated: false,
					isStderrTruncated: false,
				},
			}) as any,
	);
	on("tool.call", ($e: any, e: any) =>
		e.tool === "TaskStop"
			? ({
					result: { message: "Successfully stopped task: w8", task_id: "w8", task_type: "local_workflow" },
					text: "stopped",
				} as any)
			: ({
					result: { status: "async_launched", taskId: "w8", runId: "wf_8", workflowName: "review", transcriptDir: DIR },
					text: "launched",
				} as any),
	);
	on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	const view = await $.ui.mount(BAND);
	const texts = async () =>
		[
			...(await view.findAll({ type: "Text" })).map((t) => t.text),
			...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
		].join("\n");
	await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
	await clock.advance(1000);
	journal += `${JSON.stringify({ type: "result", key: KEY_A, agentId: "aA1", result: { ok: true } })}\n`;
	await clock.advance(1000);
	await clock.advance(4000);
	let drawn = await texts();
	expect(drawn).not.toContain("lens:alpha");
	expect(drawn).toContain("Review: 1 of 1 agents done · its script picks what runs next");
	await clock.advance(61_000);
	expect(await texts()).toContain("nothing new for 1m");
	expect(await texts()).toContain("running");
	await $.tool.call({ tool: "TaskStop", task_id: "w8" } as any);
	await clock.advance(300);
	drawn = await texts();
	expect(drawn).toContain("stopped · 1 of 1 agents done");
	expect(drawn).not.toContain("running");
	await view.unmount();
});

test(
	"a run that ended without a word (none of its agents running, nothing new for 10 minutes) ends and closes",
	{ timeoutMs: 20_000 },
	async ($, on) => {
		on("process.spawn", noProbe);
		const clock = mock.clock(on, { now: 1_000_000 });
		const DIR = "/runs/wf_6";
		const KEY_A = `v2:${"8".repeat(64)}`;
		const journal = `{"type":"launched"}\n${JSON.stringify({ type: "started", key: KEY_A, agentId: "aA1", label: "lens:alpha", phase: "Review" })}\n${JSON.stringify({ type: "result", key: KEY_A, agentId: "aA1", result: {} })}\n`;
		on("session.start", ($e: any, e: any) => ({ cwd: e.cwd }) as any);
		on("command.register", () => ({ value: undefined }) as any);
		on("env.get", () => ({ value: "/home/t" }) as any);
		on(
			"fs.list",
			($e: any, e: any) =>
				({
					value:
						e.path === DIR
							? [{ name: "journal.jsonl", kind: "file", size: journal.length, mtimeMs: 0, isLink: false }]
							: [],
				}) as any,
		);
		on(
			"process.run",
			($e: any, e: any) =>
				({
					value: {
						exitCode: 0,
						stdout: e.argv?.[0] === "cut" ? journal : "",
						stderr: "",
						isStdoutTruncated: false,
						isStderrTruncated: false,
					},
				}) as any,
		);
		on(
			"tool.call",
			() =>
				({
					result: { status: "async_launched", taskId: "w6", runId: "wf_6", workflowName: "sweep", transcriptDir: DIR },
					text: "launched",
				}) as any,
		);
		on("ui.render", () => ({ type: "engine", ref: 0 }) as any);

		await $.session.start({ source: "startup", cwd: "/tmp" } as any);
		const view = await $.ui.mount(BAND);
		const texts = async () =>
			[
				...(await view.findAll({ type: "Text" })).map((t) => t.text),
				...(await view.findAll({ type: "Button" })).map((b) => String(b.props.label)),
			].join("\n");
		await $.tool.call({ tool: "Workflow", script: "export const meta = {}" } as any);
		await clock.advance(6000);
		expect(await texts()).toContain("Review: 1 of 1 agents done");
		for (let i = 0; i < 61; i++) await clock.advance(10_000);
		expect(await texts()).not.toContain("sweep");
		await view.unmount();
	},
);

const ran = (stdout = "") => ({
	value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});
const answer = (on: any, own: Record<string, (...args: any[]) => any> = {}) => {
	const base: Record<string, (...args: any[]) => any> = {
		"process.spawn": noProbe,
		"session.start": ($e: any, e: any) => ({ cwd: e.cwd }),
		"command.register": () => ({ value: undefined }),
		"agent.spawn": ($e: any, e: any) => ({ model: "claude-haiku-4-5-20251001", agentId: e.description }),
		"fs.list": () => ({ value: [] }),
		"process.run": () => ran(),
		"ui.panes": () => ({ value: [] }),
		"ui.focus": () => ({}),
		"ui.scroll": () => ({}),
		"ui.render": () => ({ type: "engine", ref: 0 }),
	};
	for (const [noun, hook] of Object.entries({ ...base, ...own })) on(noun, hook);
};
const textsIn = async (view: any) =>
	[
		...(await view.findAll({ type: "Text" })).map((t: any) => t.text),
		...(await view.findAll({ type: "Button" })).map((b: any) => String(b.props.label)),
	].join("\n");

test("a background shell that redraws its progress with \\r shows what it says last", async ($, on) => {
	const clock = mock.clock(on);
	mock.env(on, { HOME: "/home/t" });
	answer(on, {
		"tool.call": () => ({
			result: { backgroundTaskId: "b1", stdout: "", stderr: "", interrupted: false },
			text: "Output is being written to: /nonexistent/tasks/b1.output.",
		}),
		"process.run": ($e: any, e: any) =>
			ran(
				e.argv?.[0] === "tail"
					? "encoding\nframe=100 time=00:00:01\rframe=200 time=00:00:02\rframe=300 time=00:00:03\r"
					: "",
			),
	});
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.tool.call({
		tool: "Bash",
		command: "ffmpeg -i in.mp4 out.webm",
		description: "encode",
		run_in_background: true,
	} as any);
	await clock.advance(1300);
	const view = await $.ui.mount(BAND);
	const drawn = await textsIn(view);
	expect(drawn).toContain("encoding");
	expect(drawn).toContain("frame=300 time=00:00:03");
	expect(drawn).not.toContain("frame=100");
	await view.unmount();
});

test("a Monitor box finds its output under CLAUDE_CODE_TMPDIR, looking again after a miss", async ($, on) => {
	const clock = mock.clock(on);
	mock.env(on, { HOME: "/home/t", CLAUDE_CODE_TMPDIR: "/ctmp" });
	let isWritten = false;
	answer(on, {
		"tool.call": () => ({ result: { taskId: "m1" }, text: "Monitor started" }),
		"process.run": ($e: any, e: any) => {
			const [cmd, ...args] = e.argv as string[];
			if (cmd === "tail") return ran("event: deploy finished\n");
			return ran(
				cmd === "find" && isWritten && args.includes("-H") && args.includes("/ctmp")
					? "/ctmp/claude-1000/-tmp/s1/tasks/m1.output\n"
					: "",
			);
		},
	});
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	await $.tool.call({ tool: "Monitor", command: "tail -f deploy.log", description: "deploy" } as any);
	await clock.advance(1300);
	isWritten = true;
	await clock.advance(11_000);
	const view = await $.ui.mount(BAND);
	expect(await textsIn(view)).toContain("event: deploy finished");
	await view.unmount();
});

test("on the main screen the grid keeps to about half the terminal, as the fullscreen slot does", async ($, on) => {
	const clock = mock.clock(on);
	mock.env(on, { HOME: "/home/t" });
	answer(on, { "tool.call": () => ({ result: { stdout: "ok", stderr: "", interrupted: false }, text: "ok" }) });
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["a1", "a2", "a3", "a4", "a5", "a6"]) {
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
		for (let n = 1; n <= 12; n++) await $.tool.call({ tool: "Bash", command: `step ${n}`, agentId: id } as any);
	}
	await clock.advance(300);
	const view = await $.ui.mount({
		...BAND,
		props: { ...BAND.props, maxRows: 50, bodyColumns: 99, scroll: { offset: 0, bodyRows: 50 } },
		viewport: { columns: 104, rows: 50, isFullscreen: false },
	});
	expect(rowsOf(await view.drawn())).toBeLessThanOrEqual(21);
	await view.unmount();
});

test("a model id that names no family shows its last part, and leaves the title its room", async ($, on) => {
	const clock = mock.clock(on);
	mock.env(on, { HOME: "/home/t" });
	answer(on, {
		"agent.spawn": ($e: any, e: any) => ({
			model: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3",
			agentId: e.description,
		}),
	});
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["build app", "two", "three"])
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	const drawn = await textsIn(view);
	expect(drawn).toContain("build app");
	expect(drawn).toContain(" a1b2c3");
	expect(drawn).not.toContain("arn:aws");
	await view.unmount();
});

test("a title of wide characters is cut to the cells its box has", async ($, on) => {
	const clock = mock.clock(on);
	mock.env(on, { HOME: "/home/t" });
	answer(on);
	await $.session.start({ source: "startup", cwd: "/tmp" } as any);
	for (const id of ["一二三四五六七八九十百千万億", "two", "three"])
		await $.agent.spawn({ description: id, subagentType: "general-purpose", prompt: id, background: true } as any);
	await clock.advance(300);
	const view = await $.ui.mount(BAND);
	expect(String((await view.findAll({ type: "Button" }))[0]!.props.label)).toBe("一二三四五六七八九十…");
	await view.unmount();
});
