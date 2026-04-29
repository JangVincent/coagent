export const MSG = {
  HELLO: "hello",
  ROSTER: "roster",
  MESSAGE: "message",
  SYSTEM: "system",
  CONTROL: "control",
  CONTROL_ACK: "control_ack",
  ACTIVITY: "activity",
} as const;

export type ActivityKind =
  | "idle"
  | "thinking"
  | "tool"
  | "compact"
  | "usage";

export const CONTROL_OPS = [
  "clear",
  "compact",
  "status",
  "usage",
  "mode",
  "model",
  "pause",
  "resume",
  "kill",
] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export type Role = "human" | "agent";

export interface Participant {
  name: string;
  role: Role;
}

export interface HelloMsg {
  type: "hello";
  name: string;
  role: Role;
}

export interface ChatMsg {
  type: "message";
  from: string;
  content: string;
  mentions: string[];
  ts: number;
}

export interface OutgoingMsg {
  type: "message";
  content: string;
}

export interface RosterMsg {
  type: "roster";
  participants: Participant[];
}

export interface SystemMsg {
  type: "system";
  text: string;
  participants?: Participant[];
}

export interface ControlMsg {
  type: "control";
  target: string;
  op: ControlOp;
  arg?: string;
  from?: string;
}

export interface ControlAckMsg {
  type: "control_ack";
  target: string;
  op: ControlOp;
  from: string;
  ok: boolean;
  info?: string;
  ts: number;
}

export interface ActivityMsg {
  type: "activity";
  name: string;
  kind: ActivityKind;
  tool?: string;
  ts: number;
}

export type ServerMsg =
  | ChatMsg
  | RosterMsg
  | SystemMsg
  | ControlMsg
  | ControlAckMsg
  | ActivityMsg;
export type ClientMsg =
  | HelloMsg
  | OutgoingMsg
  | ControlMsg
  | ControlAckMsg
  | ActivityMsg;

export const MENTION_ALL = "all";

// Reject any trailing identifier/path char so `@vincent.com`, `@foo/bar`,
// `@vincent_v2` (when partial match would shorten) don't sneak through via
// backtracking. Use newMentionRegex() at each call site — the /g flag is
// stateful (lastIndex) so a shared instance can't be reused safely.
export const newMentionRegex = () =>
  /@([A-Za-z][A-Za-z0-9_-]*)(?![\w.\-/~])/g;

export function parseMentions(
  text: string,
  validNames?: Set<string>,
): string[] {
  const names = new Set<string>();
  const re = newMentionRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = m[1];
    if (n === MENTION_ALL) {
      names.add(MENTION_ALL);
    } else if (!validNames || validNames.has(n)) {
      names.add(n);
    }
  }
  return [...names];
}

export function encode(obj: unknown): string {
  return JSON.stringify(obj);
}

export function decode<T = unknown>(buf: string | Buffer): T {
  return JSON.parse(typeof buf === "string" ? buf : buf.toString()) as T;
}
