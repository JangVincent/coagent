# coagent

[English](./README.md) · [한국어](./README.ko.md)

Multi-participant chat hub for Claude Code agents and humans.

Spin up a chat room, add a Claude Code agent for each project you're juggling,
and coordinate them from a single terminal. Each agent runs in its own working
directory with full Claude Code tools (Read, Grep, Bash, Edit…). You direct
them with `@name` mentions, share files with absolute paths, and control
sessions with slash commands.

## Install

```bash
npm i -g @vincentjang/coagent
```

Provides the `coagent` command. Requires Node 20+.

## Quick start

```bash
# 1) Start the hub
coagent hub

# 2) In another terminal, attach an agent to a project
coagent agent backend ~/Dev/api-server
coagent agent frontend ~/Dev/web-app

# 3) Connect as a human
coagent human vincent
```

In the human TUI:

```
@backend show me the auth middleware
@frontend look at /home/vincent/Dev/web-app/src/api/client.ts and tell me
  if it matches what backend just described
@all summarize what each of you found
```

## Commands

```
coagent hub
coagent agent <name> [path] [--resume]
coagent human <name>
```

`--resume` opens a picker over your past Claude Code sessions for that
directory (read from `~/.claude/projects/`), letting you continue an
existing conversation instead of starting fresh.

`path` for an agent can be relative (resolved against your shell's cwd) or
absolute. Defaults to the current directory.

### Slash commands (in human TUI)

- `/clear <agent>` — wipe an agent's Claude session
- `/compact <agent>` — summarise & compact session to free context
- `/status <agent>` — session id, mode, queue, turns, cost
- `/usage <agent>` — cumulative tokens & cost
- `/mode <agent> <plan|accept|auto|default>` — change permission mode
- `/pause <agent>` / `/resume <agent>` — hold or release the queue
- `/kill <agent>` — terminate the agent process
- `/quit` — leave the chat

### Mentions

- `@alice` — address a specific participant
- `@all` — broadcast to everyone
- Type `@` in the input to get an autocomplete popup of participants and
  files in the current directory. Tab/Enter to insert.

### File references

Type a path in your message — relative or absolute, with or without a leading
`@` for autocompletion. The TUI expands relative paths to absolute before
sending so every agent reads the same file.

```
@alice please review @./src/auth.ts and compare with /home/vincent/notes.md
```

## State

coagent itself stores nothing on disk. Each agent and the hub are pure
processes — start them, use them, kill them. Every Claude session is
created fresh on each agent launch; if you want continuity across
restarts, leave the agent running.

If you want to "remember" what a chat covered while the agents are still
alive, ask them — each remembers its own thread.

## How it fits with Claude Code

Each agent is just a `claude-agent-sdk` instance pinned to a working
directory. The chat hub is a tiny WebSocket router. Mentions translate to
"who gets to take a turn" — only mentioned agents process the message.

The chat infrastructure is JavaScript/Node. The projects your agents work in
can be any language (Python, Go, Rust, Terraform, anything Claude Code can
read and edit).

## License

MIT
