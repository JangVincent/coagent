import React, { useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, Static, useInput, useApp } from "ink";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MSG,
  encode,
  decode,
  parseMentions,
  type ActivityMsg,
  type ChatMsg,
  type Participant,
  type ServerMsg,
} from "./protocol.ts";
import { ContentView } from "./render-content.tsx";
import { expandFileRefsInContent } from "./human/file-ref.ts";
import { COMMANDS, completeSlash } from "./human/slash.ts";

// Reconnect backoff: 0.5s, 1s, 2s, 4s, 8s, 16s, then 30s cap (matches agent).
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_BACKOFF_CAP = 6;
// How long to keep the fatal-disconnect message visible before auto-exit.
const FATAL_EXIT_DELAY_MS = 1500;

const args = process.argv.slice(2);
const myName =
  args.filter((a) => !a.startsWith("--"))[0] ?? process.env.CHAT_NAME;
const hubUrl = process.env.HUB_URL ?? "ws://localhost:8787";

if (!myName) {
  console.error("usage: human.tsx <name> [--no-history]");
  process.exit(1);
}

// Hue-spaced so 3-4 random picks rarely cluster. Keep clear of the yellow
// accent (#ffd66b) used for "→ you" / picker cursor.
const PALETTE = [
  "#ff6565", "#ff8a40", "#ffc79e", "#ff9e9e",
  "#ff6b9d", "#ff9ed8", "#ff70c0", "#d070e0",
  "#b8e06a", "#8ae6a7", "#4ecf8f", "#5cc070",
  "#7ee3d0", "#40d0c0", "#40b5a0", "#5cc8e8",
  "#9ec8ff", "#4fa8ff", "#7090ff", "#5b8fff",
  "#9e8aff", "#c58aff", "#e6b8ff", "#b070d0",
];

function hashIndex(who: string): number {
  let h = 0;
  for (let i = 0; i < who.length; i++) h = (h * 31 + who.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

// Used only for names not (yet) in the roster — e.g. mentions of someone
// who already left. Stable so the same departed name renders the same way
// across system messages.
function fallbackColorFor(who: string): string {
  return PALETTE[hashIndex(who)];
}

function pickRandomUnused(used: Set<string>): string {
  const free = PALETTE.filter((c) => !used.has(c));
  const pool = free.length > 0 ? free : PALETTE;
  return pool[Math.floor(Math.random() * pool.length)];
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

interface PickerState {
  open: boolean;
  index: number;
  selected: Set<string>;
  draft: string;
}

function ChatInput({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  focus: boolean;
  placeholder?: string;
}) {
  useInput(
    (input, key) => {
      // Newline triggers — checked before Enter so they never submit.
      const wantsNewline =
        (key.shift && key.return) ||
        (key.meta && key.return) ||
        (key.ctrl && input === "j");
      if (wantsNewline) {
        onChange(value + "\n");
        return;
      }
      if (key.return) {
        onSubmit();
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      // Pass these through to the App-level useInput.
      if (
        key.tab ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.escape ||
        key.ctrl
      ) {
        return;
      }
      if (input && input.length >= 1) {
        onChange(value + input);
      }
    },
    { isActive: focus },
  );

  if (!value) {
    if (placeholder) {
      return focus ? (
        <Text>
          <Text inverse>{placeholder[0] || " "}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      ) : (
        <Text dimColor>{placeholder}</Text>
      );
    }
    return focus ? <Text inverse> </Text> : <Text> </Text>;
  }
  return (
    <Text>
      {value}
      {focus ? <Text inverse> </Text> : null}
    </Text>
  );
}

function MessageBlock({
  entry,
  me,
  colorFor,
  isParticipant,
}: {
  entry: LocalEntry;
  me: string;
  colorFor: (who: string) => string;
  isParticipant: (who: string) => boolean;
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
      <ContentView
        text={entry.content}
        me={me}
        colorFor={colorFor}
        isParticipant={isParticipant}
      />
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [roster, setRoster] = useState<Participant[]>([]);
  const [activities, setActivities] = useState<Map<string, ActivityMsg>>(
    () => new Map(),
  );
  const [draft, setDraft] = useState("");
  const [fileRefIndex, setFileRefIndex] = useState(0);
  const [, setPickerVer] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
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

  // Colors are picked once per name when first seen this session and held
  // for the lifetime of the process — even after the participant leaves —
  // so a returning name keeps its color and existing chat bubbles never
  // change palette mid-session.
  const [colorMap, setColorMap] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    if (myName) m.set(myName, pickRandomUnused(new Set()));
    return m;
  });
  useEffect(() => {
    setColorMap((prev) => {
      let next: Map<string, string> | null = null;
      const used = new Set(prev.values());
      const ensure = (name: string) => {
        if (prev.has(name)) return;
        if (!next) next = new Map(prev);
        const c = pickRandomUnused(used);
        next.set(name, c);
        used.add(c);
      };
      for (const p of roster) ensure(p.name);
      return next ?? prev;
    });
  }, [roster]);
  const colorFor = useMemo(
    () => (name: string) => colorMap.get(name) ?? fallbackColorFor(name),
    [colorMap],
  );
  // colorMap accumulates every name we've seen this session (current roster
  // + leavers + myName), so this catches both live and historical mentions
  // while still rejecting unseen lookalikes like "@latest" in an npm command.
  const isParticipant = useMemo(
    () => (name: string) => name === "all" || colorMap.has(name),
    [colorMap],
  );

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSystem = "";

    const reconnectDelay = (n: number) => {
      const exp = Math.min(n - 1, RECONNECT_BACKOFF_CAP);
      return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
    };

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(hubUrl);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        if (attempt > 0) {
          pushEntry({
            kind: "system",
            content: `reconnected to ${hubUrl}`,
            ts: Date.now(),
          });
        }
        attempt = 0;
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
          const namesIn = new Set(msg.participants.map((p) => p.name));
          setActivities((prev) => {
            let next: Map<string, ActivityMsg> | null = null;
            for (const k of prev.keys()) {
              if (!namesIn.has(k)) {
                if (!next) next = new Map(prev);
                next.delete(k);
              }
            }
            return next ?? prev;
          });
        } else if (msg.type === MSG.SYSTEM) {
          if (Array.isArray(msg.participants)) setRoster(msg.participants);
          lastSystem = msg.text;
          pushEntry({ kind: "system", content: msg.text, ts: Date.now() });
        } else if (msg.type === MSG.ACTIVITY) {
          setActivities((prev) => {
            const next = new Map(prev);
            if (msg.kind === "idle") next.delete(msg.name);
            else next.set(msg.name, msg);
            return next;
          });
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
      ws.addEventListener("close", () => {
        if (cancelled) return;
        if (
          lastSystem.includes("already taken") ||
          lastSystem.includes("expected hello")
        ) {
          pushEntry({
            kind: "system",
            content: `${lastSystem} — exiting`,
            ts: Date.now(),
          });
          timer = setTimeout(() => {
            timer = null;
            exit();
          }, FATAL_EXIT_DELAY_MS);
          return;
        }
        attempt += 1;
        const delay = reconnectDelay(attempt);
        pushEntry({
          kind: "system",
          content: `disconnected — reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt})`,
          ts: Date.now(),
        });
        timer = setTimeout(connect, delay);
      });
      ws.addEventListener("error", () => {});
    };

    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        wsRef.current?.close();
      } catch {}
    };
  }, []);

  const shutdown = () => {
    try {
      wsRef.current?.close();
    } catch {}
    exit();
  };

  const sendNow = (content: string) => {
    const knownNames = new Set([...roster.map((p) => p.name), "all"]);
    const expanded = expandFileRefsInContent(content);
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
  };

  const openPicker = (content: string) => {
    pickerRef.current = {
      open: true,
      index: 0,
      selected: new Set(),
      draft: content,
    };
    setDraft("");
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
    // Newline detection (Shift/Alt+Enter, Ctrl+J) is owned by <ChatInput>,
    // which sees the keypress before App's useInput in the picker-closed
    // case and decides whether to call onSubmit. App only handles the
    // navigation/control keys below.
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
              }
        return;
      }
    }
    // Slash command tab complete
    if (key.tab && draft.startsWith("/")) {
      const agentNames = roster
        .filter((p) => p.role === "agent")
        .map((p) => p.name);
      const completed = completeSlash(draft, agentNames);
      if (completed && completed !== draft) {
        setDraft(completed);
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
    if (fileRefCtx.active && fileRefCtx.items.length > 0) {
      const sel = fileRefCtx.items[fileRefIndex];
      if (sel) {
        setDraft(applyPopupSelection(draft, fileRefCtx, sel));
            return;
      }
    }
    const content = draft.trim();
    if (!content) {
      setDraft("");
        return;
    }
    if (content.startsWith("/")) {
      runCommand(content);
      setDraft("");
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
            isParticipant={isParticipant}
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
              const a = activities.get(p.name);
              const activityLabel = a
                ? a.kind === "tool" && a.tool
                  ? a.tool
                  : a.kind
                : null;
              return (
                <Text key={p.name}>
                  <Text color={colorFor(p.name)}>{icon} </Text>
                  <Text bold color={colorFor(p.name)}>
                    {p.name}
                  </Text>
                  {isYou ? <Text dimColor> (you)</Text> : null}
                  {activityLabel ? (
                    <Text dimColor> ({activityLabel}…)</Text>
                  ) : null}
                  {sep ? <Text dimColor>{sep}</Text> : null}
                </Text>
              );
            })
          )}
        </Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor="gray"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        <Text bold color={colorFor(myName!)}>
          {myName}
        </Text>
        <Text dimColor> › </Text>
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSubmit={sendDraft}
          placeholder="message · @name · @path · /cmd · Shift+Enter newline · Tab completes"
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

// Kitty keyboard "disambiguate" flag is pushed in bin/coagent.mjs before this
// module loads so the terminal has time to switch modes before any input.
// We also pass kittyKeyboard:enabled to Ink so its input parser is on the
// kitty path. Pushing twice is harmless (stack-based) and pops match up.
render(<App />, { kittyKeyboard: { mode: "enabled" } });
