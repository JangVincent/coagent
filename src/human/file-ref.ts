import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Rules:
 *   1. Pure identifier ([A-Za-z][\w-]*) is left as-is — could be a participant
 *      mention, or just text like @v1.0 — never coerced into a path.
 *   2. Anything containing a slash or starting with `~` is treated as a path,
 *      so future-files (not yet on disk) still get expanded.
 *   3. Otherwise (dots, etc.) only expand when the file actually exists.
 */
export function expandFileRefsInContent(content: string): string {
  return content.replace(/@(\S+)/g, (match, partial: string) => {
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(partial)) return match;

    const looksLikePath = partial.includes("/") || partial.startsWith("~");
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
    if (looksLikePath || exists) return abs;
    return match;
  });
}
