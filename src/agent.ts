import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  MSG,
  encode,
  decode,
  type ServerMsg,
  type Participant,
  type ControlMsg,
  type ControlOp,
} from "./protocol.ts";

const args = process.argv.slice(2);
const name = args[0] ?? process.env.AGENT_NAME;
const cwdArg = args[1] ?? process.env.AGENT_CWD ?? process.cwd();
const hubUrl = process.env.HUB_URL ?? "ws://localhost:8787";

if (!name) {
  console.error("usage: agent.ts <name> [cwd]");
  process.exit(1);
}

const cwd = path.resolve(cwdArg);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
  console.error(`[${name}] cwd does not exist or is not a directory: ${cwd}`);
  console.error("  (check case — linux is case-sensitive: Dev vs dev)");
  process.exit(1);
}

type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

const MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  ask: "default",
  normal: "default",
  accept: "acceptEdits",
  acceptedits: "acceptEdits",
  acceptEdits: "acceptEdits",
  edits: "acceptEdits",
  bypass: "bypassPermissions",
  bypassPermissions: "bypassPermissions",
  auto: "bypassPermissions",
  plan: "plan",
};

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let roster: Participant[] = [];
const queue: { from: string; content: string }[] = [];
let processing = false;
let paused = false;
let totalCost = 0;
let totalTurns = 0;
let permissionMode: PermissionMode = "bypassPermissions";

type ModelStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
};
const modelStats: Record<string, ModelStats> = {};

function accumulateModelUsage(mu: unknown) {
  if (!mu || typeof mu !== "object") return;
  for (const [model, raw] of Object.entries(mu as Record<string, unknown>)) {
    const u = raw as Partial<ModelStats>;
    if (!modelStats[model]) {
      modelStats[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
      };
    }
    const s = modelStats[model];
    s.inputTokens += u.inputTokens ?? 0;
    s.outputTokens += u.outputTokens ?? 0;
    s.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    s.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    s.webSearchRequests += u.webSearchRequests ?? 0;
    s.costUSD += u.costUSD ?? 0;
  }
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatUsage(): string {
  const totals = Object.values(modelStats).reduce(
    (acc, s) => ({
      in: acc.in + s.inputTokens,
      out: acc.out + s.outputTokens,
      cr: acc.cr + s.cacheReadInputTokens,
      cw: acc.cw + s.cacheCreationInputTokens,
    }),
    { in: 0, out: 0, cr: 0, cw: 0 },
  );
  const head = `$${totalCost.toFixed(4)} · ${totalTurns} turns · in=${fmtN(totals.in)} out=${fmtN(totals.out)} cache(r/w)=${fmtN(totals.cr)}/${fmtN(totals.cw)}`;
  const models = Object.entries(modelStats);
  if (models.length === 0) return `${head} · (no model data yet)`;
  if (models.length === 1) return head;
  const perModel = models
    .map(([m, s]) => `${m}:$${s.costUSD.toFixed(4)}`)
    .join(" ");
  return `${head} · [${perModel}]`;
}

function setSessionId(id: string | null) {
  sessionId = id;
}

function sendAck(
  op: ControlOp,
  ok: boolean,
  info?: string,
  fromRequester?: string,
) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    encode({
      type: MSG.CONTROL_ACK,
      target: name,
      op,
      from: fromRequester ?? "?",
      ok,
      info,
      ts: Date.now(),
    }),
  );
}

async function runUsagePassthrough(requester: string) {
  if (processing) {
    sendAck("usage", false, "busy — try again after the current turn", requester);
    return;
  }
  processing = true;
  let resultText = "";
  try {
    const res = query({
      prompt: "/usage",
      options: {
        cwd,
        executable: "node",
        permissionMode,
        resume: sessionId ?? undefined,
        mcpServers: {
          "agent-chat": {
            type: "sdk",
            name: "agent-chat",
            instance: chatServer.instance,
          },
        },
      },
    });
    for await (const msg of res) {
      if ("session_id" in msg && msg.session_id) setSessionId(msg.session_id);
      if (msg.type === "result") {
        const r = msg as { result?: string };
        if (typeof r.result === "string" && r.result.length > 0) {
          resultText = r.result.trim();
        }
      }
    }
  } catch (e) {
    const err = e as { message?: string };
    sendAck(
      "usage",
      true,
      `${formatUsage()}\n(CLI /usage failed: ${err.message ?? String(e)})`,
      requester,
    );
    processing = false;
    if (queue.length > 0) processQueue();
    return;
  }
  processing = false;

  const combined = resultText
    ? `${formatUsage()}\n${resultText}`
    : `${formatUsage()}\n(CLI /usage returned no data — reset window info is not exposed via SDK)`;
  sendAck("usage", true, combined, requester);
  if (queue.length > 0) processQueue();
}

async function runCompact(requester: string) {
  if (!sessionId) {
    sendAck("compact", false, "no active session to compact", requester);
    return;
  }
  if (processing) {
    sendAck(
      "compact",
      false,
      "busy — wait for the current turn, then retry",
      requester,
    );
    return;
  }
  processing = true;
  console.log(`[${name}] /compact starting (session=${sessionId})`);
  let acked = false;
  try {
    const res = query({
      prompt: "/compact",
      options: {
        cwd,
        executable: "node",
        permissionMode,
        resume: sessionId ?? undefined,
        mcpServers: {
          "agent-chat": {
            type: "sdk",
            name: "agent-chat",
            instance: chatServer.instance,
          },
        },
      },
    });
    for await (const msg of res) {
      if ("session_id" in msg && msg.session_id) setSessionId(msg.session_id);
      if (
        msg.type === "system" &&
        (msg as { subtype?: string }).subtype === "compact_boundary"
      ) {
        const meta = (msg as { compact_metadata?: { pre_tokens?: number } })
          .compact_metadata;
        sendAck(
          "compact",
          true,
          `compacted (pre=${meta?.pre_tokens ?? "?"} tokens)`,
          requester,
        );
        acked = true;
      }
    }
    if (!acked) sendAck("compact", true, "done", requester);
  } catch (e) {
    const err = e as { message?: string };
    sendAck("compact", false, `failed: ${err.message ?? String(e)}`, requester);
  } finally {
    processing = false;
    if (queue.length > 0) processQueue();
  }
}

function handleControl(msg: ControlMsg) {
  const op = msg.op;
  const requester = msg.from ?? "?";
  console.log(`[${name}] control from ${requester}: ${op}`);
  switch (op) {
    case "clear": {
      const prev = sessionId;
      setSessionId(null);
      queue.length = 0;
      sendAck(
        op,
        true,
        prev ? `session cleared (was ${prev.slice(0, 8)}…)` : "no prior session",
        requester,
      );
      return;
    }
    case "compact": {
      void runCompact(requester);
      return;
    }
    case "status": {
      const lines = [
        `session=${sessionId ?? "(none)"}`,
        `mode=${permissionMode}`,
        `paused=${paused}`,
        `queue=${queue.length}`,
        `turns=${totalTurns}`,
        `totalCost=$${totalCost.toFixed(4)}`,
      ];
      sendAck(op, true, lines.join(" · "), requester);
      return;
    }
    case "usage": {
      void runUsagePassthrough(requester);
      return;
    }
    case "mode": {
      const argRaw = (msg.arg ?? "").trim();
      if (!argRaw) {
        sendAck(
          op,
          true,
          `current=${permissionMode} (available: default | acceptEdits | bypassPermissions | plan)`,
          requester,
        );
        return;
      }
      const resolved = MODE_ALIASES[argRaw] ?? MODE_ALIASES[argRaw.toLowerCase()];
      if (!resolved) {
        sendAck(
          op,
          false,
          `unknown mode '${argRaw}'. try: default, acceptEdits (accept), bypassPermissions (auto), plan`,
          requester,
        );
        return;
      }
      const prev = permissionMode;
      permissionMode = resolved;
      sendAck(op, true, `${prev} → ${resolved}`, requester);
      return;
    }
    case "pause": {
      paused = true;
      sendAck(op, true, "paused", requester);
      return;
    }
    case "resume": {
      paused = false;
      sendAck(op, true, "resumed", requester);
      if (queue.length > 0) processQueue();
      return;
    }
    case "kill": {
      sendAck(op, true, "exiting", requester);
      setTimeout(() => process.exit(0), 100);
      return;
    }
    default:
      sendAck(op, false, `unknown op`, requester);
  }
}

const sendChatTool = tool(
  "send_chat",
  "Send a message to the group chat. Use @name to address a participant. This is the ONLY way to deliver a message to other participants — anything else you output stays local.",
  {
    content: z
      .string()
      .describe(
        "Message text. Use @name (pure identifier) to mention participants. For file references, just write the path (no @ needed) — absolute paths are safest for cross-project coordination.",
      ),
  },
  async ({ content }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ type: MSG.MESSAGE, content }));
      process.stdout.write(`[${name} -> chat] ${content}\n`);
      return { content: [{ type: "text" as const, text: "sent" }] };
    }
    return {
      content: [{ type: "text" as const, text: "error: not connected to hub" }],
      isError: true,
    };
  },
);

const chatServer = createSdkMcpServer({
  name: "agent-chat",
  version: "1.0.0",
  tools: [sendChatTool],
});

function makeIntro(): string {
  const others = roster.filter((p) => p.name !== name);
  const list = others.length
    ? others.map((p) => `${p.name} (${p.role})`).join(", ")
    : "(nobody else yet)";
  return `You are "${name}", a Claude Code agent working in the project at ${cwd}.

You are part of a multi-participant group chat with other Claude Code agents and humans.
Current other participants: ${list}.

Rules:
- To send a message to the group, use the send_chat tool.
- Use @name (pure identifier, no "/" or ".") to address a participant — e.g. @Vincent, @Alice. Use @all to address every participant at once.
- When YOU want to reference a file in send_chat content, just write its path (e.g. "check src/foo.ts" or the absolute path).
- When an incoming message mentions a filesystem path (absolute or looks like a path), treat it as a file reference and use your Read tool as appropriate. Your cwd is ${cwd}.
- Plain text you output is NOT delivered to chat — only send_chat calls reach other participants.
- You only receive messages that mention @${name}. Incoming messages are formatted as "[from <name>] <text>".
- You have full Claude Code tools (Read, Grep, Bash, etc.) for inspecting this project.
- Keep replies concise. When you need info from another agent's project, ask them via @their-name.
- Always end a turn with at least one send_chat call addressing whoever asked you.

Formatting rules for send_chat content (the human TUI renders markdown):
- Use GitHub-flavored markdown: **bold**, \`inline code\`, "# heading", bullet/numbered lists, "> quote".
- For code, file contents, or command output, ALWAYS wrap in a fenced block with a language tag:
  \`\`\`ts ... \`\`\`, \`\`\`py ... \`\`\`, \`\`\`bash ... \`\`\`, etc.
- For patches/diffs, use \`\`\`diff ... \`\`\` so "+" / "-" lines get colored.
- Prefer short excerpts. Blocks over ~30 lines are auto-collapsed in the viewer, so paste only the relevant slice and summarize the rest in prose.
- Don't paste entire large files. Reference them with @path and let the reader open the file themselves.

Begin.`;
}

async function processQueue() {
  if (processing || paused || queue.length === 0) return;
  processing = true;
  const batch = queue.splice(0, queue.length);
  const firstTurn = sessionId === null;
  const header = firstTurn ? makeIntro() + "\n\n" : "";
  const body = batch.map((m) => `[from ${m.from}] ${m.content}`).join("\n");
  const promptText = header + body;

  console.log(`\n[${name}] --- turn (${batch.length} incoming) ---`);
  try {
    const res = query({
      prompt: promptText,
      options: {
        cwd,
        executable: "node",
        permissionMode,
        resume: sessionId ?? undefined,
        mcpServers: {
          "agent-chat": {
            type: "sdk",
            name: "agent-chat",
            instance: chatServer.instance,
          },
        },
      },
    });
    for await (const msg of res) {
      if ("session_id" in msg && msg.session_id) setSessionId(msg.session_id);
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              process.stdout.write(`[${name} thinking] ${block.text}\n`);
            } else if (
              block.type === "tool_use" &&
              !String(block.name).endsWith("send_chat")
            ) {
              process.stdout.write(`[${name} tool] ${block.name}\n`);
            }
          }
        }
      } else if (msg.type === "result") {
        const r = msg as any;
        if (typeof r.total_cost_usd === "number") totalCost += r.total_cost_usd;
        totalTurns += 1;
        accumulateModelUsage(r.modelUsage);
        const cost =
          typeof r.total_cost_usd === "number"
            ? r.total_cost_usd.toFixed(4)
            : "?";
        console.log(
          `[${name}] turn done — cost $${cost}, turns=${r.num_turns}, session=${sessionId}`,
        );
      }
    }
  } catch (e: any) {
    console.error(`[${name}] turn error:`, e?.message ?? e);
    if (e?.stack) console.error(e.stack);
  } finally {
    processing = false;
    if (queue.length > 0) processQueue();
  }
}

function connect() {
  ws = new WebSocket(hubUrl);
  ws.addEventListener("open", () => {
    ws!.send(encode({ type: MSG.HELLO, name, role: "agent" }));
    console.log(`[${name}] connected to ${hubUrl} (cwd=${cwd})`);
  });
  ws.addEventListener("message", (ev) => {
    let msg: ServerMsg;
    try {
      msg = decode<ServerMsg>(ev.data as string);
    } catch {
      return;
    }
    if (msg.type === MSG.ROSTER) {
      roster = msg.participants;
    } else if (msg.type === MSG.SYSTEM) {
      if (Array.isArray(msg.participants)) roster = msg.participants;
      console.log(`[${name}] -- ${msg.text}`);
    } else if (msg.type === MSG.MESSAGE) {
      if (msg.from === name) return;
      const addressed =
        msg.mentions?.includes(name) || msg.mentions?.includes("all");
      if (!addressed) return;
      queue.push({ from: msg.from, content: msg.content });
      processQueue();
    } else if (msg.type === MSG.CONTROL) {
      if (msg.target !== name) return;
      handleControl(msg);
    }
  });
  ws.addEventListener("close", (ev) => {
    console.log(
      `[${name}] disconnected (code=${ev.code}, reason=${ev.reason || "(none)"})`,
    );
    process.exit(0);
  });
  ws.addEventListener("error", (ev) => {
    console.error(`[${name}] ws error`, ev);
  });
}

connect();

process.on("uncaughtException", (e) => {
  console.error(`[${name}] UNCAUGHT`, e);
});
process.on("unhandledRejection", (e) => {
  console.error(`[${name}] UNHANDLED REJECTION`, e);
});
