export type GridStatus = "running" | "done" | "failed";
/** A process under a running shell or Bash call, as the activity probe (hooks/activity.py) saw it a second ago. */
export type GridProc = {
	pid: number;
	/** its command line on one row, $HOME as ~; the tool's own wrapper shell goes by its name, `root` set */
	args: string;
	root?: boolean;
	/** R running, S waiting, D in disk I/O, T stopped, Z exited */
	state: string;
	/** % of one core over the last second */
	cpu: number;
	/** bytes it has read and written (files, pipes, the network), and over the last second */
	rd: number;
	wr: number;
	rdps: number;
	wrps: number;
	/** the regular files and directories it holds open: how (r, w, rw, dir), its place in each, their size (none on a
	 * network or FUSE mount: a stat there can hang), the first few of them; `nfiles` how many it holds in all */
	files: { path: string; mode: string; pos: number; size?: number }[];
	nfiles: number;
};
/** What an agent's model is doing this moment, as its response streams: thinking, writing text, or writing a tool call. */
export type GridNow = { kind: "thinking" | "text" | "tool"; text: string; tool?: string; lines?: number };
/**
 * What is live in a running box this second, published apart from the boxes (`live`, by card id) since it changes several
 * times a second: what its model is doing while a response streams; the processes of its shell, or of the Bash call it
 * is running, and how many more the probe left out; that call's newest output lines.
 */
export type GridLive = { now?: GridNow; procs?: GridProc[]; more?: number; tail?: string[] };
/** One activity row of an agent box: `tool` set, a call (`text` its argument) and its result's first line; else a text line. */
export type GridLine = { tool?: string; text: string; result?: string; isError?: boolean };
export type GridCard = {
	/**
	 * agentId for an Agent-tool subagent; `wfa:<runId>:<key>` for a workflow agent (its journal key, so a retry
	 * keeps the box); `wf:<runId>` for a workflow run; `sh:<taskId>` for a shell
	 */
	id: string;
	/** `agent` is any model loop drawn as a box, a workflow's agents included; `workflow` is the run itself */
	kind: "agent" | "workflow" | "shell";
	title: string;
	model?: string;
	status: GridStatus;
	tokens?: number;
	/** footer text past the status: `exit 2`, `retry 1` */
	note?: string;
	lines: GridLine[];
	/** when the card started and ended (ms), for its elapsed/remaining estimate and its siblings' */
	startedAt?: number;
	endedAt?: number;
	/** background task id, matched against task notifications (a subagent, a shell, a workflow run) */
	taskId?: string;
	/** shell: its output file; workflow run: its transcript dir */
	path?: string;
	/** shell: the command it runs, its first 60 lines (each cut), and how many lines it has */
	command?: string;
	commandLines?: number;
	/** how many of its tool calls failed so far; only ever goes up (its lines drop the oldest) */
	failed?: number;
	/** workflow agent: the `wf:<runId>` card of its run, the run's name, its phase */
	run?: string;
	group?: string;
	phase?: string;
	/** workflow agent: the attempt whose events feed the box (a stall or throttle retry swaps it) and its count */
	agentId?: string;
	attempt?: number;
	/** the color its box and its Clawd (the clawd mod) wear, given when the box is made (and again when it runs
	 * again in one a running box took meanwhile) */
	color?: string;
	/** workflow run: when its journal last changed (what its own box counts "nothing new for" from) */
	lastAt?: number;
	/** workflow run: how many agents its journal lists, and how many of them have finished (result or failed) */
	listed?: number;
	done?: number;
};

declare module "claude-code" {
	interface PluginState {
		"agent-grid": {
			cards: GridCard[];
			live: Record<string, GridLive>;
			band: boolean;
			view: { expanded: string; start: number };
		};
	}
}
