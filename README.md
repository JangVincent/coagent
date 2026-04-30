# coagent

[English](./README.md) · [한국어](./README.ko.md)

Multi-participant chat hub for Claude Code agents and humans.

Spin up a chat room, add a Claude Code agent for each project you're juggling,
and coordinate them from a single terminal. Each agent runs in its own working
directory with full Claude Code tools (Read, Grep, Bash, Edit…). You direct
them with `@name` mentions, share files with absolute paths, and control
sessions with slash commands.

## Install

### npm

```bash
npm i -g @vincentjang/coagent
```

### Homebrew (macOS)

```bash
brew tap JangVincent/tap
brew install coagent-cli
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
coagent hub [--host <addr>]
coagent agent <name> [path] [--model <id>] [--resume]
coagent human <name>
```

`--resume` opens a picker over your past Claude Code sessions for that
directory (read from `~/.claude/projects/`), letting you continue an
existing conversation instead of starting fresh.

`--model <id>` pins the agent to a specific Claude model
(e.g. `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`).
Equivalent to setting `AGENT_MODEL=<id>` in the environment — the flag
wins if both are set. Omit both to use the SDK default. The model can
also be changed at runtime with `/model <agent> <id>` from a human TUI.

`path` for an agent can be relative (resolved against your shell's cwd) or
absolute. Defaults to the current directory.

### Networking & safety

By default the hub binds to `127.0.0.1` only — connections come from the
same machine. To expose it on your LAN explicitly, pass `--host 0.0.0.0`
(or set `HUB_HOST=0.0.0.0`). The hub has no auth, so anyone who can reach
the port can join the room.

When an agent's `HUB_URL` points at a non-local host, it automatically
starts in `acceptEdits` mode (Bash/network tools still ask for permission)
instead of the default `bypassPermissions`. Use `/mode <agent> auto` from
a trusted human to opt back in.

Only humans may issue slash-command control ops. Agents are not allowed
to `/kill` or `/mode` other agents.

### Slash commands (in human TUI)

Every op-bearing command takes either a single agent name or `all`
(equivalently `@all`) to fan out to every agent in the room. Each
target replies with its own ack, so you'll see one line per agent.

- `/clear <agent|all>` — wipe an agent's Claude session (aborts any in-flight turn)
- `/compact <agent|all>` — summarise & compact session to free context
- `/status <agent|all>` — session id, mode, current task, queue, turns, cost
- `/usage <agent|all>` — cumulative tokens & cost
- `/mode <agent|all> <plan|accept|auto|default>` — change permission mode
- `/model <agent|all> [<id>|default]` — show or change the agent's model (applies to next turn)
- `/pause <agent|all>` / `/resume <agent|all>` — hold or release the queue (in-flight turn keeps running)
- `/kill <agent|all>` — terminate the agent process (aborts any in-flight turn)
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

If the hub disconnects (restart, network blip), agents and humans
automatically reconnect with backoff and resume their existing Claude
session. Fatal rejections (name conflict, bad handshake) exit instead.

## How it fits with Claude Code

Each agent is just a `claude-agent-sdk` instance pinned to a working
directory. The chat hub is a tiny WebSocket router. Mentions translate to
"who gets to take a turn" — only mentioned agents process the message.

The chat infrastructure is JavaScript/Node. The projects your agents work in
can be any language (Python, Go, Rust, Terraform, anything Claude Code can
read and edit).

## License

MIT
