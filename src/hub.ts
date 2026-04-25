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
});
