import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore - ws ships its own types
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

let hub: ChildProcess;
const PORT = 18900 + Math.floor(Math.random() * 100);
const URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function hello(ws: WebSocket, name: string, role: "human" | "agent") {
  ws.send(JSON.stringify({ type: "hello", name, role }));
}

function recvOne(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (b) => resolve(JSON.parse(b.toString())));
  });
}

function collect(ws: WebSocket, ms: number): Promise<any[]> {
  const out: any[] = [];
  const onmsg = (b: WebSocket.RawData) => out.push(JSON.parse(b.toString()));
  ws.on("message", onmsg);
  return new Promise((resolve) =>
    setTimeout(() => {
      ws.off("message", onmsg);
      resolve(out);
    }, ms),
  );
}

before(async () => {
  hub = spawn("node", ["dist/hub.js"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for "listening" log
  await new Promise<void>((resolve) => {
    hub.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("listening")) resolve();
    });
  });
});

after(async () => {
  hub.kill("SIGTERM");
  await new Promise((r) => hub.once("exit", r));
});

test("hello + welcome system msg", async () => {
  const ws = await open();
  hello(ws, "vincent", "human");
  const m = await recvOne(ws);
  assert.equal(m.type, "system");
  assert.match(m.text, /welcome vincent/);
  assert.ok(Array.isArray(m.participants));
  ws.close();
  await sleep(50);
});

test("name conflict: system msg arrives before close", async () => {
  const a = await open();
  hello(a, "dup", "human");
  await recvOne(a); // welcome

  const b = await open();
  const events: { kind: string; payload?: any }[] = [];
  b.on("message", (raw) =>
    events.push({ kind: "msg", payload: JSON.parse(raw.toString()) }),
  );
  b.on("close", () => events.push({ kind: "close" }));
  hello(b, "dup", "human");
  await sleep(300);

  const msgIdx = events.findIndex((e) => e.kind === "msg");
  const closeIdx = events.findIndex((e) => e.kind === "close");
  assert.ok(msgIdx >= 0, "expected system message before close");
  assert.ok(closeIdx >= 0, "expected close after rejection");
  assert.ok(msgIdx < closeIdx, "system msg must precede close");
  assert.match(events[msgIdx].payload.text, /already taken/);

  a.close();
  await sleep(50);
});

test("control op from non-human is rejected", async () => {
  const alice = await open();
  hello(alice, "alice", "agent");
  await collect(alice, 100);

  const bob = await open();
  hello(bob, "bob", "agent");
  await collect(bob, 100);

  bob.send(
    JSON.stringify({ type: "control", target: "alice", op: "kill" }),
  );
  const replies = await collect(bob, 200);
  const sysMsg = replies.find(
    (m) => m.type === "system" && /only humans/.test(m.text),
  );
  assert.ok(sysMsg, "expected 'only humans' rejection");

  alice.close();
  bob.close();
  await sleep(50);
});

test("control op from human is delivered", async () => {
  const agent = await open();
  hello(agent, "ag1", "agent");
  await collect(agent, 100);

  const v = await open();
  hello(v, "v1", "human");
  await collect(v, 100);

  v.send(
    JSON.stringify({ type: "control", target: "ag1", op: "status" }),
  );
  const got = await collect(agent, 200);
  const ctrl = got.find((m) => m.type === "control" && m.op === "status");
  assert.ok(ctrl, "agent should receive control");
  assert.equal(ctrl.from, "v1");

  agent.close();
  v.close();
  await sleep(50);
});

test("messages are broadcast to other clients", async () => {
  const a = await open();
  hello(a, "send-a", "human");
  await collect(a, 100);

  const b = await open();
  hello(b, "send-b", "human");
  await collect(b, 100);

  a.send(JSON.stringify({ type: "message", content: "hello @send-b" }));
  const received = await collect(b, 200);
  const chat = received.find((m) => m.type === "message");
  assert.ok(chat);
  assert.equal(chat.from, "send-a");
  assert.deepEqual(chat.mentions, ["send-b"]);

  a.close();
  b.close();
  await sleep(50);
});

test("activity is broadcast to peers but not echoed to sender", async () => {
  const ag = await open();
  hello(ag, "act-ag", "agent");
  await collect(ag, 100);

  const hu = await open();
  hello(hu, "act-hu", "human");
  await collect(hu, 100);

  ag.send(
    JSON.stringify({
      type: "activity",
      name: "act-ag",
      kind: "tool",
      tool: "Bash",
      ts: Date.now(),
    }),
  );
  const [recAg, recHu] = await Promise.all([
    collect(ag, 200),
    collect(hu, 200),
  ]);
  assert.ok(
    recHu.some(
      (m) => m.type === "activity" && m.name === "act-ag" && m.tool === "Bash",
    ),
    "human should see the agent's activity",
  );
  assert.ok(
    !recAg.some((m) => m.type === "activity"),
    "agent should not receive its own activity",
  );

  ag.close();
  hu.close();
  await sleep(50);
});

test("activity with mismatched name is dropped (anti-spoof)", async () => {
  const a = await open();
  hello(a, "spoof-a", "agent");
  await collect(a, 100);

  const b = await open();
  hello(b, "spoof-b", "human");
  await collect(b, 100);

  // a claims to be b
  a.send(
    JSON.stringify({
      type: "activity",
      name: "spoof-b",
      kind: "thinking",
      ts: Date.now(),
    }),
  );
  const recB = await collect(b, 200);
  assert.ok(
    !recB.some((m) => m.type === "activity"),
    "spoofed activity must not be relayed",
  );

  a.close();
  b.close();
  await sleep(50);
});
