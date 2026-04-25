import * as clack from "@clack/prompts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Read just the head of each .jsonl to extract a preview without slurping
// huge logs. Sessions can grow to many MB; 4 KB easily covers the first
// user message in practice.
const PREVIEW_BYTES = 4 * 1024;
const PREVIEW_CHAR_LIMIT = 60;
// Heuristic for turn count from file size (one assistant+user round-trip
// is ~2 KB on average). Avoids reading the full file just for a label.
const BYTES_PER_TURN_ESTIMATE = 2 * 1024;

interface PastSession {
  sid: string;
  mtime: Date;
  preview: string;
  turns: number;
}

function encodeProjectPath(p: string): string {
  // Claude Code stores per-project sessions under ~/.claude/projects/<encoded>
  // where slashes are replaced with hyphens. Internal format, may change.
  return p.replace(/\//g, "-");
}

function listClaudeSessions(cwdPath: string): PastSession[] {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const projectDir = path.join(projectsDir, encodeProjectPath(cwdPath));
  if (!fs.existsSync(projectDir)) return [];

  const files = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"));

  const sessions: PastSession[] = [];
  for (const file of files) {
    try {
      const fullPath = path.join(projectDir, file);
      const stat = fs.statSync(fullPath);
      const sid = file.replace(/\.jsonl$/, "");

      const fd = fs.openSync(fullPath, "r");
      const buf = Buffer.alloc(Math.min(PREVIEW_BYTES, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const headLines = buf
        .toString("utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);

      let preview = "";
      for (const line of headLines) {
        try {
          const m = JSON.parse(line);
          if (m.type === "user" && m.message?.content) {
            const c = m.message.content;
            if (typeof c === "string") preview = c;
            else if (Array.isArray(c) && c[0]?.type === "text")
              preview = c[0].text ?? "";
            if (preview) break;
          }
        } catch {
          // partial JSON at the cutoff — ignore
        }
      }
      preview = preview.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHAR_LIMIT);
      const turns = Math.max(1, Math.round(stat.size / BYTES_PER_TURN_ESTIMATE));
      sessions.push({ sid, mtime: stat.mtime, preview, turns });
    } catch {
      // skip unreadable file
    }
  }

  return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function fmtAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/**
 * Show an interactive picker for past Claude sessions in cwd.
 * Returns the chosen sessionId, or undefined to start fresh.
 * Exits the process on cancel.
 */
export async function runResumePicker(
  name: string,
  cwd: string,
): Promise<string | undefined> {
  const sessions = listClaudeSessions(cwd);
  if (sessions.length === 0) {
    clack.note(
      `no past Claude sessions found for ${cwd}\nstarting fresh.`,
      `[${name}]`,
    );
    return undefined;
  }
  const choice = await clack.select({
    message: `past Claude sessions for ${cwd}`,
    options: [
      { value: "fresh", label: "new — start a fresh session" },
      ...sessions.map((s) => ({
        value: s.sid,
        label: `${fmtAgo(s.mtime).padEnd(8)} · ~${s.turns} turns · ${s.preview || "(no preview)"}`,
        hint: s.sid.slice(0, 8),
      })),
    ],
  });
  if (clack.isCancel(choice)) {
    clack.cancel("cancelled");
    process.exit(0);
  }
  return choice === "fresh" ? undefined : (choice as string);
}
