# agent-grid 🧩

claude code kept doing stuff in the background and never told me what. so i made it show me

it's a grid above your prompt with one box for everything that's running: subagents, workflow agents, background shells. each box shows what it's doing right now, so the thinking and writing, its tool calls and what came back, the latest output if it's running a command, its busiest process, and which file it's reading or writing and how fast

it pops up when something starts, gets out of the way while you're typing, and finished boxes close themselves after a few seconds

works really nice with [clawd](https://github.com/v1ol3tr0se/clawd), every box gets a little crab next to it. you don't need the crabs. but you want the crabs

made with claude code, for claude code.

### before you start
- claude code 2.1.295 or newer
- linux
- node 22.18+

on macos it still works but you won't get the processes, files or command output, that stuff comes from `/proc` and macos doesn't have one. not much i can do there

### installing
```shell
/plugin install agent-grid --marketplace v1ol3tr0se/agent-grid
```

say `y` to the marketplace thing and pick **user**

you'll probably want these in `~/.claude/keybindings.json` too, unless you like looking at a grid you can't move in:

```json
{
  "bindings": [
    { "context": "AbovePrompt", "bindings": { "up": "pane:pageUp", "down": "pane:pageDown" } },
    { "context": "Chat", "bindings": { "ctrl+w": "abovePrompt:focus" } }
  ]
}
```

heads up, `ctrl+w` stops deleting the last word after this. use a different key if that bothers you, or skip that line and use `ctrl+x tab`

### moving around
- `ctrl+w` jumps into the grid
- `←` `→` between boxes
- `↑` `↓` or `PgUp` `PgDn` to change rows, or scroll inside an open box
- `Home` / `End` first and last row
- `Enter` opens a box to the full band with every process and file it touched. press it again to close
- `Esc` back to the prompt
- `/workflow` closes an open box, clears the finished ones, or pins the grid (depends on what's open)

### a few limits
it's one box per thing, so with a lot of agents it pages instead of making them tiny

typing hides it, sending or clearing the prompt brings it back. yes, on purpose

it reads claude code's transcripts and task files, so if an update moves those it'll break until i fix it

if it acts weird open an issue, i do read them
