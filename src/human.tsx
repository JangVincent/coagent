import React, { useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, Static, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MSG,
  encode,
  decode,
  parseMentions,
  type ChatMsg,
  type ControlOp,
  type Participant,
  type ServerMsg,
} from "./protocol.ts";
import { ContentView } from "./render-content.tsx";

const args = process.argv.slice(2);
const myName =
  args.filter((a) => !a.startsWith("--"))[0] ?? process.env.CHAT_NAME;
const skipHistory = args.includes("--no-history");
const hubUrl = process.env.HUB_URL ?? "ws://localhost:8787";

if (!myName) {
  console.error("usage: human.tsx <name> [--no-history]");
  process.exit(1);
}

const PALETTE = [
  "#8ae6a7", "#ff6b9d", "#4fa8ff", "#ff9040", "#c58aff",
  "#b8e06a", "#ff6565", "#7ee3d0", "#ffc79e", "#9ec8ff",
  "#ff9ed8", "#40d0c0", "#ff9e9e", "#4ecf8f", "#e6b8ff",
];

function longestCommonPrefix(strs: string[]): string {
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

function hashIndex(who: string): number {
  let h = 0;
  for (let i = 0; i < who.length; i++) h = (h * 31 + who.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

function fallbackColorFor(who: string): string {
  return PALETTE[hashIndex(who)];
}

function assignColors(names: string[]): Map<string, string> {
  const sorted = [...names].sort();
  const taken = new Set<string>();
  const map = new Map<string, string>();
  for (const n of sorted) {
    const start = hashIndex(n);
    let color = PALETTE[start];
    if (taken.has(color)) {
      for (let k = 1; k <= PALETTE.length; k++) {
        const c = PALETTE[(start + k) % PALETTE.length];
        if (!taken.has(c)) {
          color = c;
          break;
        }
      }
    }
    taken.add(color);
    map.set(n, color);
  }
  return map;
}

interface LocalEntry {
  kind: "chat" | "system";
  id: string;
  from?: string;
  content: string;
  mentions?: string[];
  ts: number;
}

interface FileEntry {
  name: string;
  isDir: boolean;
}

type PopupItem =
  | { kind: "participant"; name: string; role: "human" | "agent" | "all" }
  | { kind: "file"; entry: FileEntry };

interface FileRefContext {
  active: boolean;
  baseDir: string;
  baseDisplay: string;
  filter: string;
  entries: FileEntry[];
  participants: { name: string; role: "human" | "agent" | "all" }[];
  items: PopupItem[];
  matchLen: number;
  partial: string;
}

const INACTIVE_FILEREF: FileRefContext = {
  active: false,
  baseDir: "",
  baseDisplay: "",
  filter: "",
  entries: [],
  participants: [],
  items: [],
  matchLen: 0,
  partial: "",
};

function computeFileRefContext(
  draft: string,
  roster: Participant[],
  me: string,
): FileRefContext {
  const m = draft.match(/@(\S*)$/);
  if (!m) return INACTIVE_FILEREF;
  const partial = m[1];
  const isPureName = /^[A-Za-z][A-Za-z0-9_-]*$/.test(partial);
  const participants: { name: string; role: "human" | "agent" | "all" }[] =
    isPureName || partial === ""
      ? roster
          .filter((p) => p.name !== me)
          .filter(
            (p) =>
              partial === "" ||
              p.name.toLowerCase().startsWith(partial.toLowerCase()),
          )
          .map((p) => ({ name: p.name, role: p.role as "human" | "agent" }))
      : [];
  if (
    (partial === "" || "all".startsWith(partial.toLowerCase())) &&
    roster.length > 1
  ) {
    participants.unshift({ name: "all", role: "all" });
  }

  const wantsDirListing = partial === "" || partial.endsWith("/");
  const expanded =
    partial === "~" || partial === "~/"
      ? os.homedir()
      : partial.startsWith("~/")
        ? path.join(os.homedir(), partial.slice(2))
        : partial;

  let dir: string;
  let filter: string;
  let baseDisplay: string;

  if (partial === "") {
    dir = process.cwd();
    filter = "";
    baseDisplay = "./";
  } else if (wantsDirListing) {
    dir = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(process.cwd(), expanded);
    filter = "";
    baseDisplay = partial;
  } else {
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(process.cwd(), expanded);
    dir = path.dirname(abs);
    filter = path.basename(abs);
    const lastSlash = partial.lastIndexOf("/");
    baseDisplay = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : "./";
  }

  let entries: FileEntry[] = [];
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    entries = dirents
      .filter((e) => !e.name.startsWith(".") || filter.startsWith("."))
      .filter(
        (e) =>
          filter === "" ||
          e.name.toLowerCase().startsWith(filter.toLowerCase()),
      )
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    entries = [];
  }

  const items: PopupItem[] = [
    ...participants.map(
      (p) => ({ kind: "participant" as const, name: p.name, role: p.role }),
    ),
    ...entries.map((e) => ({ kind: "file" as const, entry: e })),
  ];

  return {
    active: true,
    baseDir: dir,
    baseDisplay,
    filter,
    entries,
    participants,
    items,
    matchLen: m[0].length,
    partial,
  };
}

function expandFileRefsInContent(
  content: string,
  knownNames: Set<string>,
): string {
  return content.replace(/@(\S+)/g, (match, partial: string) => {
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(partial) && knownNames.has(partial)) {
      return match;
    }
    const isExplicit = /^(\.{1,2}\/|\/|~\/|~$)/.test(partial);
    const expanded =
      partial === "~" || partial === "~/"
        ? os.homedir()
        : partial.startsWith("~/")
          ? path.join(os.homedir(), partial.slice(2))
          : partial;
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(process.cwd(), expanded);
    let exists = false;
    try {
      exists = fs.existsSync(abs);
    } catch {}
    if (isExplicit || exists) return abs;
    return match;
  });
}

function applyPopupSelection(
  draft: string,
  ctx: FileRefContext,
  item: PopupItem,
): string {
  if (item.kind === "participant") {
    return draft.slice(0, draft.length - ctx.matchLen) + "@" + item.name + " ";
  }
  const entry = item.entry;
  const lastSlash = ctx.partial.lastIndexOf("/");
  const newPartial =
    lastSlash >= 0
      ? ctx.partial.slice(0, lastSlash + 1) +
        entry.name +
        (entry.isDir ? "/" : "")
      : entry.name + (entry.isDir ? "/" : "");
  const base = draft.slice(0, draft.length - ctx.matchLen) + "@" + newPartial;
  return entry.isDir ? base : base + " ";
}

type CommandDef = {
  name: string;
  args: string;
  desc: string;
  op?: ControlOp;
  local?: "quit";
};

const COMMANDS: CommandDef[] = [
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

interface PickerState {
  open: boolean;
  index: number;
  selected: Set<string>;
  draft: string;
}

function MessageBlock({
  entry,
  me,
  colorFor,
}: {
  entry: LocalEntry;
  me: string;
  colorFor: (who: string) => string;
}) {
  if (entry.kind === "system") {
    const lines = entry.content.split("\n");
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} dimColor>
            {i === 0 ? "── " : "   "}
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  const addressed =
    entry.from !== me &&
    ((entry.mentions?.includes(me) || entry.mentions?.includes("all")) ??
      false);
  const senderColor = colorFor(entry.from ?? "?");
  const name = entry.from ?? "?";

  return (
    <Box
      borderStyle="round"
      borderColor={senderColor}
      paddingX={1}
      flexDirection="column"
      marginBottom={1}
    >
      <Text>
        <Text bold color={senderColor}>
          {name}
        </Text>
        {addressed && <Text color="#ffd66b">  → you</Text>}
      </Text>
      <Box height={1} />
      <ContentView text={entry.content} me={me} colorFor={colorFor} />
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [roster, setRoster] = useState<Participant[]>([]);
  const [draft, setDraft] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [fileRefIndex, setFileRefIndex] = useState(0);
  const [, setPickerVer] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const skipNextSubmit = useRef(false);
  const idRef = useRef(0);
  const pickerRef = useRef<PickerState>({
    open: false,
    index: 0,
    selected: new Set(),
    draft: "",
  });
  const bumpPicker = () => setPickerVer((v) => v + 1);

  const pushEntry = (e: Omit<LocalEntry, "id">) => {
    idRef.current += 1;
    const id = `${Date.now()}-${idRef.current}`;
    setEntries((prev) => [...prev, { ...e, id }]);
  };

  const colorMap = useMemo(() => {
    const names = roster.map((p) => p.name);
    if (myName && !names.includes(myName)) names.push(myName);
    return assignColors(names);
  }, [roster]);
  const colorFor = useMemo(
    () => (name: string) => colorMap.get(name) ?? fallbackColorFor(name),
    [colorMap],
  );

  useEffect(() => {
    const ws = new WebSocket(hubUrl);
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      ws.send(encode({ type: MSG.HELLO, name: myName, role: "human" }));
    });
    ws.addEventListener("message", (ev) => {
      let msg: ServerMsg;
      try {
        msg = decode<ServerMsg>(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === MSG.MESSAGE) {
        const cm = msg as ChatMsg;
        if (cm.from === myName) return;
        pushEntry({
          kind: "chat",
          from: cm.from,
          content: cm.content,
          mentions: cm.mentions,
          ts: cm.ts,
        });
      } else if (msg.type === MSG.ROSTER) {
        setRoster(msg.participants);
      } else if (msg.type === MSG.SYSTEM) {
        if (Array.isArray(msg.participants)) setRoster(msg.participants);
        pushEntry({ kind: "system", content: msg.text, ts: Date.now() });
      } else if (msg.type === MSG.BACKLOG) {
        if (skipHistory || msg.messages.length === 0) return;
        pushEntry({
          kind: "system",
          content: `history (${msg.messages.length})`,
          ts: msg.messages[0].ts,
        });
        for (const cm of msg.messages) {
          pushEntry({
            kind: "chat",
            from: cm.from,
            content: cm.content,
            mentions: cm.mentions,
            ts: cm.ts,
          });
        }
        pushEntry({ kind: "system", content: "live", ts: Date.now() });
      } else if (msg.type === MSG.CONTROL_ACK) {
        const mark = msg.ok ? "✓" : "✗";
        const info = msg.info ? ` — ${msg.info}` : "";
        pushEntry({
          kind: "system",
          content: `${mark} [${msg.target}] ${msg.op}${info}`,
          ts: msg.ts ?? Date.now(),
        });
      }
    });
    ws.addEventListener("close", () => {});
    ws.addEventListener("error", () => {});
    return () => ws.close();
  }, []);

  const shutdown = () => {
    try {
      wsRef.current?.close();
    } catch {}
    exit();
  };

  const sendNow = (content: string) => {
    const knownNames = new Set([...roster.map((p) => p.name), "all"]);
    const expanded = expandFileRefsInContent(content, knownNames);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encode({ type: MSG.MESSAGE, content: expanded }));
      pushEntry({
        kind: "chat",
        from: myName!,
        content: expanded,
        mentions: parseMentions(expanded, knownNames),
        ts: Date.now(),
      });
    }
    setDraft("");
    setInputKey((k) => k + 1);
  };

  const openPicker = (content: string) => {
    pickerRef.current = {
      open: true,
      index: 0,
      selected: new Set(),
      draft: content,
    };
    setDraft("");
    setInputKey((k) => k + 1);
    bumpPicker();
  };

  const closePicker = () => {
    pickerRef.current = {
      open: false,
      index: 0,
      selected: new Set(),
      draft: "",
    };
    bumpPicker();
  };

  const confirmPicker = () => {
    const { selected, draft: pending } = pickerRef.current;
    const namesInOrder: string[] = [];
    if (selected.has("all")) namesInOrder.push("all");
    for (const p of roster) {
      if (p.name !== myName && selected.has(p.name)) namesInOrder.push(p.name);
    }
    const prefix = namesInOrder.length
      ? namesInOrder.map((n) => `@${n}`).join(" ") + " "
      : "";
    sendNow(prefix + pending);
    closePicker();
  };

  const cancelPickerAndSend = () => {
    sendNow(pickerRef.current.draft);
    closePicker();
  };

  const completeSlash = (input: string): string | null => {
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
    const agents = roster.filter((p) => p.role === "agent");
    const matches = agents.filter((a) =>
      a.name.toLowerCase().startsWith(argPart.toLowerCase()),
    );
    if (matches.length === 0) return null;
    if (matches.length === 1) return `/${cmdName} ${matches[0].name}`;
    const lcp = longestCommonPrefix(matches.map((a) => a.name));
    return lcp.length > argPart.length ? `/${cmdName} ${lcp}` : null;
  };

  const fileRefCtx = useMemo(() => {
    if (pickerRef.current.open) return INACTIVE_FILEREF;
    return computeFileRefContext(draft, roster, myName!);
  }, [draft, roster]);

  useEffect(() => {
    setFileRefIndex(0);
  }, [fileRefCtx.baseDir, fileRefCtx.filter, fileRefCtx.items.length]);

  const slashOpen = draft.startsWith("/") && !pickerRef.current.open;
  const slashMatches = useMemo(() => {
    if (!slashOpen) return [];
    const body = draft.slice(1);
    const firstWord = body.split(/\s+/)[0] ?? "";
    const hasSpace = /\s/.test(body);
    return hasSpace
      ? COMMANDS.filter((c) => c.name === firstWord)
      : COMMANDS.filter((c) => c.name.startsWith(firstWord));
  }, [slashOpen, draft]);

  const pickables = roster.filter((p) => p.name !== myName);
  const pickerItems: { name: string; role: "human" | "agent" | "all" }[] =
    pickables.length > 1
      ? [
          { name: "all", role: "all" },
          ...pickables.map((p) => ({
            name: p.name,
            role: p.role as "human" | "agent",
          })),
        ]
      : pickables.map((p) => ({
          name: p.name,
          role: p.role as "human" | "agent",
        }));

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      shutdown();
      return;
    }
    // Newline triggers (any inserts \n instead of submitting):
    //  - Shift+Enter — works once kitty keyboard protocol negotiates
    //  - Alt/Option+Enter — works without kitty on most terminals
    //  - Ctrl+J — raw LF, distinct from Enter (CR), works everywhere
    const wantsNewline =
      !pickerRef.current.open &&
      ((key.shift && key.return) ||
        (key.meta && key.return) ||
        (key.ctrl && input === "j"));
    if (wantsNewline) {
      setDraft((d) => d + "\n");
      setInputKey((k) => k + 1);
      skipNextSubmit.current = true;
      return;
    }
    const pk = pickerRef.current;
    if (pk.open) {
      if (pickerItems.length === 0) {
        cancelPickerAndSend();
        return;
      }
      if (key.upArrow) {
        pk.index = Math.max(0, pk.index - 1);
        bumpPicker();
      } else if (key.downArrow) {
        pk.index = Math.min(pickerItems.length - 1, pk.index + 1);
        bumpPicker();
      } else if (input === " ") {
        const who = pickerItems[pk.index]?.name;
        if (who) {
          if (pk.selected.has(who)) pk.selected.delete(who);
          else pk.selected.add(who);
          bumpPicker();
        }
      } else if (key.return) {
        confirmPicker();
      } else if (key.escape) {
        cancelPickerAndSend();
      }
      return;
    }
    // File/participant popup navigation
    if (fileRefCtx.active && fileRefCtx.items.length > 0) {
      if (key.upArrow) {
        setFileRefIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setFileRefIndex((i) =>
          Math.min(fileRefCtx.items.length - 1, i + 1),
        );
        return;
      }
      if (key.tab) {
        const sel = fileRefCtx.items[fileRefIndex];
        if (sel) {
          setDraft(applyPopupSelection(draft, fileRefCtx, sel));
          setInputKey((k) => k + 1);
        }
        return;
      }
    }
    // Slash command tab complete
    if (key.tab && draft.startsWith("/")) {
      const completed = completeSlash(draft);
      if (completed && completed !== draft) {
        setDraft(completed);
        setInputKey((k) => k + 1);
      }
      return;
    }
  });

  const runCommand = (content: string): void => {
    const parts = content.slice(1).trim().split(/\s+/);
    const cmdName = parts[0] ?? "";
    const def = COMMANDS.find((c) => c.name === cmdName);
    if (!def) {
      pushEntry({
        kind: "system",
        content: `unknown command: /${cmdName} (type / to see options)`,
        ts: Date.now(),
      });
      return;
    }
    if (def.local === "quit") {
      shutdown();
      return;
    }
    if (def.op) {
      const target = parts[1];
      if (!target) {
        pushEntry({
          kind: "system",
          content: `/${def.name} needs an agent name (e.g. /${def.name} Alice)`,
          ts: Date.now(),
        });
        return;
      }
      const arg = parts.slice(2).join(" ") || undefined;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          encode({ type: MSG.CONTROL, target, op: def.op, arg }),
        );
        pushEntry({
          kind: "system",
          content: `→ /${def.name} ${target}${arg ? " " + arg : ""}`,
          ts: Date.now(),
        });
      }
    }
  };

  const sendDraft = () => {
    if (skipNextSubmit.current) {
      skipNextSubmit.current = false;
      return;
    }
    if (fileRefCtx.active && fileRefCtx.items.length > 0) {
      const sel = fileRefCtx.items[fileRefIndex];
      if (sel) {
        setDraft(applyPopupSelection(draft, fileRefCtx, sel));
        setInputKey((k) => k + 1);
        return;
      }
    }
    const content = draft.trim();
    if (!content) {
      setDraft("");
      setInputKey((k) => k + 1);
      return;
    }
    if (content.startsWith("/")) {
      runCommand(content);
      setDraft("");
      setInputKey((k) => k + 1);
      return;
    }
    if (parseMentions(content).length === 0) {
      const pickables2 = roster.filter((p) => p.name !== myName);
      if (pickables2.length > 0) {
        openPicker(content);
        return;
      }
    }
    sendNow(content);
  };

  return (
    <>
      <Static items={entries}>
        {(entry) => (
          <MessageBlock
            key={entry.id}
            entry={entry}
            me={myName!}
            colorFor={colorFor}
          />
        )}
      </Static>

      {pickerRef.current.open && (
        <Box
          borderStyle="round"
          borderColor="#ffd66b"
          paddingX={1}
          flexDirection="column"
        >
          <Text dimColor>
            mention? ↑/↓ space=toggle enter=send esc=send w/o mention
          </Text>
          <Text dimColor>
            Send:{" "}
            <Text color="#ffd66b" bold>
              {pickerRef.current.draft.slice(0, 60)}
              {pickerRef.current.draft.length > 60 ? "…" : ""}
            </Text>
          </Text>
          {pickerItems.length === 0 ? (
            <Text dimColor>(no one else — esc to send)</Text>
          ) : (
            pickerItems.map((item, i) => {
              const isSelected = pickerRef.current.selected.has(item.name);
              const isCursor = i === pickerRef.current.index;
              const marker = isSelected ? "[x]" : "[ ]";
              if (item.name === "all") {
                return (
                  <Text key="all">
                    <Text color={isCursor ? "#ffd66b" : "gray"}>
                      {isCursor ? "▶ " : "  "}
                    </Text>
                    <Text color={isSelected ? "#ffd66b" : "gray"}>
                      {marker}{" "}
                    </Text>
                    <Text color="#ffd66b">★ </Text>
                    <Text bold color="#ffd66b">all</Text>
                    <Text dimColor> (everyone)</Text>
                  </Text>
                );
              }
              const icon = item.role === "human" ? "●" : "◆";
              return (
                <Text key={item.name}>
                  <Text color={isCursor ? "#ffd66b" : "gray"}>
                    {isCursor ? "▶ " : "  "}
                  </Text>
                  <Text color={isSelected ? "#ffd66b" : "gray"}>{marker} </Text>
                  <Text color={colorFor(item.name)}>{icon} </Text>
                  <Text bold color={isCursor ? "#ffd66b" : colorFor(item.name)}>
                    {item.name}
                  </Text>
                </Text>
              );
            })
          )}
        </Box>
      )}

      <Box paddingX={1}>
        <Text>
          <Text dimColor>in room: </Text>
          {roster.length === 0 ? (
            <Text dimColor>(just you)</Text>
          ) : (
            roster.map((p, i) => {
              const icon = p.role === "human" ? "●" : "◆";
              const isYou = p.name === myName;
              const sep = i < roster.length - 1 ? "  ·  " : "";
              return (
                <Text key={p.name}>
                  <Text color={colorFor(p.name)}>{icon} </Text>
                  <Text bold color={colorFor(p.name)}>
                    {p.name}
                  </Text>
                  {isYou ? <Text dimColor> (you)</Text> : null}
                  {sep ? <Text dimColor>{sep}</Text> : null}
                </Text>
              );
            })
          )}
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold color={colorFor(myName!)}>
          {myName}
        </Text>
        <Text dimColor> › </Text>
        <TextInput
          key={inputKey}
          value={draft}
          onChange={setDraft}
          onSubmit={sendDraft}
          placeholder="message · @name mention · @path file · / commands · Tab/Enter completes"
          focus={!pickerRef.current.open}
        />
      </Box>

      {fileRefCtx.active && (
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          flexDirection="column"
        >
          <Text dimColor>
            @ participants + files in {fileRefCtx.baseDisplay} (↑/↓ · Tab/Enter
            inserts)
          </Text>
          {fileRefCtx.items.length === 0 && <Text dimColor>(no match)</Text>}
          {fileRefCtx.items.slice(0, 10).map((item, i) => {
            const isCursor = i === fileRefIndex;
            const arrow = isCursor ? "▶ " : "  ";
            if (item.kind === "participant") {
              if (item.role === "all") {
                return (
                  <Text key="p-all">
                    <Text color={isCursor ? "#ffd66b" : "gray"}>{arrow}</Text>
                    <Text color="#ffd66b">★ </Text>
                    <Text bold color="#ffd66b">
                      all
                    </Text>
                    <Text dimColor> (everyone in the room)</Text>
                  </Text>
                );
              }
              const icon = item.role === "human" ? "●" : "◆";
              return (
                <Text key={`p-${item.name}`}>
                  <Text color={isCursor ? "#ffd66b" : "gray"}>{arrow}</Text>
                  <Text color={colorFor(item.name)}>{icon} </Text>
                  <Text bold color={isCursor ? "#ffd66b" : colorFor(item.name)}>
                    {item.name}
                  </Text>
                  <Text dimColor> ({item.role})</Text>
                </Text>
              );
            }
            const e = item.entry;
            return (
              <Text key={`f-${e.name}`}>
                <Text color={isCursor ? "#ffd66b" : "gray"}>{arrow}</Text>
                <Text color={e.isDir ? "#6a9fff" : "#d0d0d0"}>
                  {e.name}
                  {e.isDir ? "/" : ""}
                </Text>
              </Text>
            );
          })}
          {fileRefCtx.items.length > 10 && (
            <Text dimColor>… and {fileRefCtx.items.length - 10} more</Text>
          )}
        </Box>
      )}

      {slashOpen && (
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          flexDirection="column"
        >
          <Text dimColor>commands (Tab completes)</Text>
          {slashMatches.length === 0 && <Text dimColor>no matching command</Text>}
          {slashMatches.map((c) => (
            <Text key={c.name}>
              <Text bold color="#ffd66b">
                /{c.name}
              </Text>
              {c.args && <Text dimColor> {c.args}</Text>}
              <Text dimColor>   — {c.desc}</Text>
            </Text>
          ))}
        </Box>
      )}
    </>
  );
}

// Kitty keyboard protocol is enabled in bin/coagent.mjs before this module
// loads, so the terminal has time to switch modes before user input. Ink's
// keypress parser detects kitty-format escapes by byte pattern regardless,
// so we don't need to pass kittyKeyboard here.
render(<App />);
