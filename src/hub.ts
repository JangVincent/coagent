import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MSG,
  parseMentions,
  encode,
  decode,
  type ChatMsg,
  type ClientMsg,
  type Participant,
  type Role,
} from "./protocol.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".data", "coagent");
const LEGACY_DATA_DIR = path.join(os.homedir(), ".data", "agent-chat-cowork");
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? DEFAULT_DATA_DIR);
const LOG_PATH = path.join(DATA_DIR, "chat.jsonl");
const BACKLOG_SIZE = Number(process.env.BACKLOG_SIZE ?? 200);
const freshStart =
  process.argv.includes("--fresh") || process.argv.includes("--new");

// One-time migration: if the new dir doesn't exist but the legacy one does,
// move it so existing users keep their chat log and agent sessions.
if (
  !process.env.DATA_DIR &&
  !fs.existsSync(DATA_DIR) &&
  fs.existsSync(LEGACY_DATA_DIR)
) {
  try {
    fs.renameSync(LEGACY_DATA_DIR, DATA_DIR);
    console.log(`[hub] migrated ${LEGACY_DATA_DIR} → ${DATA_DIR}`);
  } catch (e) {
    console.error(`[hub] migration failed:`, e);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });

if (freshStart && fs.existsSync(LOG_PATH)) {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const archivePath = path.join(DATA_DIR, `chat-${ts}.jsonl.bak`);
  fs.renameSync(LOG_PATH, archivePath);
  console.log(`[hub] --fresh: archived old log to ${archivePath}`);
}

const recent: ChatMsg[] = [];

function loadRecent() {
  if (!fs.existsSync(LOG_PATH)) return;
  try {
    const content = fs.readFileSync(LOG_PATH, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    for (const line of lines.slice(-BACKLOG_SIZE)) {
      try {
        const m = JSON.parse(line) as ChatMsg;
        if (m.type === "message") recent.push(m);
      } catch {}
    }
    console.log(`[hub] loaded ${recent.length} messages from ${LOG_PATH}`);
  } catch (e) {
    console.error(`[hub] failed to load log:`, e);
  }
}

function appendToLog(msg: ChatMsg) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(msg) + "\n");
  } catch (e) {
    console.error(`[hub] failed to append log:`, e);
  }
}

loadRecent();

interface WsState {
  name: string | null;
  role: Role | null;
}

const states = new WeakMap<WebSocket, WsState>();
const clients = new Map<string, WebSocket>();

function roster(): Participant[] {
  return [...clients.entries()].map(([name, ws]) => ({
    name,
    role: states.get(ws)!.role!,
  }));
}

function broadcast(obj: unknown, except?: WebSocket) {
  const payload = encode(obj);
  for (const ws of clients.values()) {
    if (ws === except) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function sendRoster() {
  broadcast({ type: MSG.ROSTER, participants: roster() });
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  states.set(ws, { name: null, role: null });

  ws.on("message", (raw) => {
    const data = states.get(ws)!;
    let msg: ClientMsg;
    try {
      msg = decode<ClientMsg>(raw.toString());
    } catch {
      return;
    }

    if (!data.name) {
      if (msg.type !== MSG.HELLO || !msg.name || !msg.role) {
        ws.send(
          encode({ type: MSG.SYSTEM, text: "expected hello { name, role }" }),
        );
        ws.close();
        return;
      }
      if (clients.has(msg.name)) {
        ws.send(
          encode({
            type: MSG.SYSTEM,
            text: `name '${msg.name}' already taken`,
          }),
        );
        ws.close();
        return;
      }
      data.name = msg.name;
      data.role = msg.role;
      clients.set(msg.name, ws);
      ws.send(
        encode({
          type: MSG.SYSTEM,
          text: `welcome ${msg.name}`,
          participants: roster(),
        }),
      );
      if (recent.length > 0) {
        ws.send(encode({ type: MSG.BACKLOG, messages: recent }));
      }
      broadcast(
        { type: MSG.SYSTEM, text: `${msg.name} (${msg.role}) joined` },
        ws,
      );
      sendRoster();
      console.log(`[hub] + ${msg.name} (${msg.role})`);
      return;
    }

    if (msg.type === MSG.MESSAGE && typeof msg.content === "string") {
      const knownNames = new Set([...clients.keys(), "all"]);
      const out: ChatMsg = {
        type: "message",
        from: data.name,
        content: msg.content,
        mentions: parseMentions(msg.content, knownNames),
        ts: Date.now(),
      };
      console.log(
        `[hub] ${out.from} -> ${out.mentions.join(",") || "*"}: ${out.content}`,
      );
      broadcast(out);
      appendToLog(out);
      recent.push(out);
      if (recent.length > BACKLOG_SIZE) recent.shift();
      return;
    }

    if (msg.type === MSG.CONTROL) {
      const targetWs = clients.get(msg.target);
      const targetState = targetWs ? states.get(targetWs) : undefined;
      if (!targetWs || targetState?.role !== "agent") {
        ws.send(
          encode({
            type: MSG.SYSTEM,
            text: `control: no agent named '${msg.target}'`,
          }),
        );
        return;
      }
      const out = { ...msg, from: data.name };
      targetWs.send(encode(out));
      console.log(`[hub] control ${out.from} -> ${out.target} :: ${out.op}`);
      return;
    }

    if (msg.type === MSG.CONTROL_ACK) {
      broadcast({ ...msg, ts: Date.now() });
      console.log(`[hub] ack from ${data.name} op=${msg.op} ok=${msg.ok}`);
      return;
    }
  });

  ws.on("close", () => {
    const data = states.get(ws);
    if (!data) return;
    const { name } = data;
    if (name && clients.get(name) === ws) {
      clients.delete(name);
      console.log(`[hub] - ${name}`);
      broadcast({ type: MSG.SYSTEM, text: `${name} left` });
      sendRoster();
    }
  });
});

wss.on("listening", () => {
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`[hub] listening on ws://localhost:${port}`);
  console.log(`[hub] data dir: ${DATA_DIR}`);
});
