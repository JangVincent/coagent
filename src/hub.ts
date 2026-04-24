import type { ServerWebSocket } from "bun";
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
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".data", "agent-chat-cowork");
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? DEFAULT_DATA_DIR);
const LOG_PATH = path.join(DATA_DIR, "chat.jsonl");
const BACKLOG_SIZE = Number(process.env.BACKLOG_SIZE ?? 200);
const freshStart =
  process.argv.includes("--fresh") || process.argv.includes("--new");

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

interface WsData {
  name: string | null;
  role: Role | null;
}

type Ws = ServerWebSocket<WsData>;

const clients = new Map<string, Ws>();

function roster(): Participant[] {
  return [...clients.entries()].map(([name, ws]) => ({
    name,
    role: ws.data.role!,
  }));
}

function broadcast(obj: unknown, except?: Ws) {
  const payload = encode(obj);
  for (const ws of clients.values()) {
    if (ws === except) continue;
    if (ws.readyState === 1) ws.send(payload);
  }
}

function sendRoster() {
  broadcast({ type: MSG.ROSTER, participants: roster() });
}

const server = Bun.serve<WsData, never>({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req, { data: { name: null, role: null } })) return;
    return new Response("expected websocket", { status: 400 });
  },
  websocket: {
    open(ws) {},

    message(ws, raw) {
      let msg: ClientMsg;
      try {
        msg = decode<ClientMsg>(raw as string);
      } catch {
        return;
      }

      if (!ws.data.name) {
        if (msg.type !== MSG.HELLO || !msg.name || !msg.role) {
          ws.send(
            encode({ type: MSG.SYSTEM, text: "expected hello { name, role }" }),
          );
          ws.close();
          return;
        }
        if (clients.has(msg.name)) {
          ws.send(
            encode({ type: MSG.SYSTEM, text: `name '${msg.name}' already taken` }),
          );
          ws.close();
          return;
        }
        ws.data.name = msg.name;
        ws.data.role = msg.role;
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
          from: ws.data.name,
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
        if (!targetWs || targetWs.data.role !== "agent") {
          ws.send(
            encode({
              type: MSG.SYSTEM,
              text: `control: no agent named '${msg.target}'`,
            }),
          );
          return;
        }
        const out = { ...msg, from: ws.data.name };
        targetWs.send(encode(out));
        console.log(`[hub] control ${out.from} -> ${out.target} :: ${out.op}`);
        return;
      }

      if (msg.type === MSG.CONTROL_ACK) {
        broadcast({ ...msg, ts: Date.now() });
        console.log(
          `[hub] ack from ${ws.data.name} op=${msg.op} ok=${msg.ok}`,
        );
        return;
      }
    },

    close(ws) {
      const { name } = ws.data;
      if (name && clients.get(name) === ws) {
        clients.delete(name);
        console.log(`[hub] - ${name}`);
        broadcast({ type: MSG.SYSTEM, text: `${name} left` });
        sendRoster();
      }
    },
  },
});

console.log(`[hub] listening on ws://localhost:${server.port}`);
console.log(`[hub] data dir: ${DATA_DIR}`);
