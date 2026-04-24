export const MSG = {
  HELLO: "hello",
  ROSTER: "roster",
  MESSAGE: "message",
  SYSTEM: "system",
  CONTROL: "control",
  CONTROL_ACK: "control_ack",
  BACKLOG: "backlog",
} as const;

export const CONTROL_OPS = [
  "clear",
  "compact",
  "status",
  "usage",
  "mode",
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

export interface BacklogMsg {
  type: "backlog";
  messages: ChatMsg[];
}

export type ServerMsg =
  | ChatMsg
  | RosterMsg
  | SystemMsg
  | ControlMsg
  | ControlAckMsg
  | BacklogMsg;
export type ClientMsg =
  | HelloMsg
  | OutgoingMsg
  | ControlMsg
  | ControlAckMsg;

export const MENTION_ALL = "all";

export function parseMentions(
  text: string,
  validNames?: Set<string>,
): string[] {
  const names = new Set<string>();
  const re = /@([A-Za-z][A-Za-z0-9_-]*)(?![/~]|\.[\w/])/g;
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
