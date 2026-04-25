import type { ControlOp } from "../protocol.ts";

export type CommandDef = {
  name: string;
  args: string;
  desc: string;
  op?: ControlOp;
  local?: "quit";
};

export const COMMANDS: CommandDef[] = [
  { name: "clear", args: "<agent>", desc: "Wipe the agent's Claude session & context", op: "clear" },
  { name: "compact", args: "<agent>", desc: "Summarize & compact the agent's session to free context", op: "compact" },
  { name: "status", args: "<agent>", desc: "Show session, mode, queue, turns, cost", op: "status" },
  { name: "usage", args: "<agent>", desc: "Show cumulative tokens & cost (per-model breakdown)", op: "usage" },
  { name: "mode", args: "<agent> [default|accept|auto|plan]", desc: "Set permission mode", op: "mode" },
  { name: "pause", args: "<agent>", desc: "Stop processing messages", op: "pause" },
  { name: "resume", args: "<agent>", desc: "Resume a paused agent", op: "resume" },
  { name: "kill", args: "<agent>", desc: "Terminate an agent process", op: "kill" },
  { name: "quit", args: "", desc: "Leave the chat", local: "quit" },
  { name: "exit", args: "", desc: "Leave the chat (alias)", local: "quit" },
];

export function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  const first = strs[0];
  let i = 0;
  while (i < first.length) {
    const ch = first[i];
    let match = true;
    for (let j = 1; j < strs.length; j++) {
      if (strs[j][i] !== ch) {
        match = false;
        break;
      }
    }
    if (!match) break;
    i++;
  }
  return first.slice(0, i);
}

/**
 * Tab-complete a slash command input against COMMANDS and (optionally) a
 * roster of agent names. Returns the new input string, or null if no useful
 * completion exists.
 */
export function completeSlash(input: string, agentNames: string[]): string | null {
  if (!input.startsWith("/")) return null;
  const body = input.slice(1);
  const firstSpace = body.indexOf(" ");
  if (firstSpace < 0) {
    const matches = COMMANDS.filter((c) => c.name.startsWith(body));
    if (matches.length === 0) return null;
    if (matches.length === 1) {
      const needsArg = matches[0].args.length > 0;
      return `/${matches[0].name}${needsArg ? " " : ""}`;
    }
    const lcp = longestCommonPrefix(matches.map((c) => c.name));
    return lcp.length > body.length ? `/${lcp}` : null;
  }
  const cmdName = body.slice(0, firstSpace);
  const argPart = body.slice(firstSpace + 1);
  const def = COMMANDS.find((c) => c.name === cmdName);
  if (!def || !def.op) return null;
  const matches = agentNames.filter((a) =>
    a.toLowerCase().startsWith(argPart.toLowerCase()),
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return `/${cmdName} ${matches[0]}`;
  const lcp = longestCommonPrefix(matches);
  return lcp.length > argPart.length ? `/${cmdName} ${lcp}` : null;
}
