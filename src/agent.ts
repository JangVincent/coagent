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
import { makeIntro } from "./agent/intro.ts";
import { accumulateModelUsage, formatUsage } from "./agent/usage.ts";
import { runResumePicker } from "./agent/session-picker.ts";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const name = positional[0] ?? process.env.AGENT_NAME;
const cwdArg = positional[1] ?? process.env.AGENT_CWD ?? process.cwd();
const wantsResume = args.includes("--resume");
const hubUrl = process.env.HUB_URL ?? "ws://localhost:8787";

if (!name) {
  console.error("usage: agent.ts <name> [cwd] [--resume]");
  process.exit(1);
}

const cwd = path.resolve(cwdArg);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
  console.error(`[${name}] cwd does not exist or is not a directory: ${cwd}`);
  console.error("  (check case — linux is case-sensitive: Dev vs dev)");
  process.exit(1);
}

let initialSessionId: string | undefined;

if (wantsResume) {
  try {
    initialSessionId = await runResumePicker(name, cwd);
  } catch (e) {
    const err = e as { message?: string };
    console.warn(
      `[${name}] could not read Claude session history (${err.message ?? e}); starting fresh`,
    );
  }
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

function isLocalHubUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]"
    );
  } catch {
    return false;
  }
}
const hubIsLocal = isLocalHubUrl(hubUrl);
if (!hubIsLocal) {
  console.warn(
    `[${name}] hub at ${hubUrl} is non-local — defaulting permissionMode to acceptEdits.\n` +
    `  any chat participant can direct this agent; bypassPermissions is unsafe over the network.\n` +
    `  use /mode ${name} auto from a trusted human to override.`,
  );
}

let ws: WebSocket | null = null;
let sessionId: string | null = initialSessionId ?? null;
let introSent = false;
let roster: Participant[] = [];
const queue: { from: string; content: string }[] = [];
type TaskKind = "turn" | "compact" | "usage";
let currentTask: TaskKind | null = null;
let currentAbort: AbortController | null = null;
let paused = false;
let totalCost = 0;
let totalTurns = 0;

function startTask(kind: TaskKind): AbortController | null {
  if (currentTask !== null) return null;
  const controller = new AbortController();
  currentTask = kind;
  currentAbort = controller;
  return controller;
}

function finishTask(controller: AbortController) {
  if (currentAbort === controller) {
    currentAbort = null;
    currentTask = null;
  }
}
let permissionMode: PermissionMode = hubIsLocal
  ? "bypassPermissions"
  : "acceptEdits";

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
  const controller = startTask("usage");
  if (!controller) {
    sendAck("usage", false, `busy: in ${currentTask}`, requester);
    return;
  }
  let resultText = "";
  let failure: string | null = null;
  try {
    const res = query({
      prompt: "/usage",
      options: {
        cwd,
        executable: "node",
        permissionMode,
        resume: sessionId ?? undefined,
        abortController: controller,
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
    failure = controller.signal.aborted
      ? "aborted"
      : `CLI /usage failed: ${err.message ?? String(e)}`;
  } finally {
    finishTask(controller);
  }

  if (failure) {
    sendAck("usage", true, `${formatUsage(totalCost, totalTurns)}\n(${failure})`, requester);
  } else {
    const combined = resultText
      ? `${formatUsage(totalCost, totalTurns)}\n${resultText}`
      : `${formatUsage(totalCost, totalTurns)}\n(CLI /usage returned no data — reset window info is not exposed via SDK)`;
    sendAck("usage", true, combined, requester);
  }
  if (queue.length > 0) processQueue();
}

async function runCompact(requester: string) {
  if (!sessionId) {
    sendAck("compact", false, "no active session to compact", requester);
    return;
  }
  const controller = startTask("compact");
  if (!controller) {
    sendAck("compact", false, `busy: in ${currentTask}`, requester);
    return;
  }
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
        abortController: controller,
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
    if (controller.signal.aborted) {
      sendAck("compact", false, "aborted", requester);
    } else {
      sendAck("compact", false, `failed: ${err.message ?? String(e)}`, requester);
    }
  } finally {
    finishTask(controller);
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
      const inflight = currentTask;
      currentAbort?.abort();
      setSessionId(null);
      introSent = false;
      queue.length = 0;
      const note = prev
        ? `session cleared (was ${prev.slice(0, 8)}…)${inflight ? `, ${inflight} aborted` : ""}`
        : "no prior session";
      sendAck(op, true, note, requester);
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
        `task=${currentTask ?? "idle"}`,
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
      currentAbort?.abort();
      sendAck(op, true, "exiting", requester);
      setTimeout(() => process.exit(0), KILL_GRACE_MS);
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


async function processQueue() {
  if (paused || queue.length === 0) return;
  const controller = startTask("turn");
  if (!controller) return;
  const batch = queue.splice(0, queue.length);
  const header = introSent ? "" : makeIntro(name, cwd, roster) + "\n\n";
  introSent = true;
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
        abortController: controller,
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
    if (controller.signal.aborted) {
      console.log(`[${name}] turn aborted`);
    } else {
      console.error(`[${name}] turn error:`, e?.message ?? e);
      if (e?.stack) console.error(e.stack);
    }
  } finally {
    finishTask(controller);
    if (queue.length > 0) processQueue();
  }
}

// Reconnect backoff: 0.5s, 1s, 2s, 4s, 8s, 16s, then 30s cap.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_BACKOFF_CAP = 6;
// Grace period after /kill ack so SDK has time to clean up child processes.
const KILL_GRACE_MS = 300;
// Grace period after SIGINT/SIGTERM before forced exit.
const SHUTDOWN_GRACE_MS = 500;

let shuttingDown = false;
let reconnectAttempt = 0;
let fatalReason: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function reconnectDelay(attempt: number): number {
  const exp = Math.min(attempt - 1, RECONNECT_BACKOFF_CAP);
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (fatalReason) {
    console.error(`[${name}] not reconnecting: ${fatalReason}`);
    process.exit(1);
    return;
  }
  reconnectAttempt += 1;
  const delay = reconnectDelay(reconnectAttempt);
  console.log(
    `[${name}] reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempt})`,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!shuttingDown) connect();
  }, delay);
}

function connect() {
  ws = new WebSocket(hubUrl);
  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
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
      const t = msg.text;
      if (t.includes("already taken") || t.includes("expected hello")) {
        fatalReason = t;
      }
      console.log(`[${name}] -- ${t}`);
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
    scheduleReconnect();
  });
  ws.addEventListener("error", (ev) => {
    console.error(`[${name}] ws error`, ev);
  });
}

connect();

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    process.exit(130);
  }
  shuttingDown = true;
  console.log(`[${name}] received ${signal}, exiting…`);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {}
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (e) => {
  console.error(`[${name}] UNCAUGHT`, e);
});
process.on("unhandledRejection", (e) => {
  console.error(`[${name}] UNHANDLED REJECTION`, e);
});
