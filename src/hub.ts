import { WebSocketServer, WebSocket } from "ws";
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
// Force the close after the system message if the send callback doesn't fire
// quickly enough (e.g. peer is unresponsive).
const SEND_AND_CLOSE_TIMEOUT_MS = 500;
// Force-exit if wss.close() doesn't return (e.g. a stuck client).
const SHUTDOWN_FORCE_EXIT_MS = 1000;
// Standard SIGINT exit code.
const SIGINT_EXIT_CODE = 130;

function parseHost(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--host" && args[i + 1]) return args[i + 1];
    if (a.startsWith("--host=")) return a.slice("--host=".length);
  }
  return process.env.HUB_HOST ?? "127.0.0.1";
}
const HOST = parseHost();

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

function sendAndClose(ws: WebSocket, text: string) {
  const payload = encode({ type: MSG.SYSTEM, text });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {}
  };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(payload, () => close());
    setTimeout(close, SEND_AND_CLOSE_TIMEOUT_MS).unref();
  } else {
    close();
  }
}

function sendRoster() {
  broadcast({ type: MSG.ROSTER, participants: roster() });
}

const wss = new WebSocketServer({ port: PORT, host: HOST });

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
        sendAndClose(ws, "expected hello { name, role }");
        return;
      }
      if (clients.has(msg.name)) {
        sendAndClose(ws, `name '${msg.name}' already taken`);
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
      return;
    }

    if (msg.type === MSG.CONTROL) {
      if (data.role !== "human") {
        ws.send(
          encode({
            type: MSG.SYSTEM,
            text: `control: only humans may issue control ops`,
          }),
        );
        console.log(
          `[hub] control denied: ${data.name} (${data.role}) tried ${msg.op} on ${msg.target}`,
        );
        return;
      }
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
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "<any>" : HOST;
  console.log(`[hub] listening on ws://${displayHost}:${port}`);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    // Second Ctrl+C — force exit immediately.
    process.exit(SIGINT_EXIT_CODE);
  }
  shuttingDown = true;
  console.log(`[hub] received ${signal}, closing connections…`);
  for (const ws of clients.values()) {
    try {
      ws.close();
    } catch {}
  }
  wss.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), SHUTDOWN_FORCE_EXIT_MS).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
