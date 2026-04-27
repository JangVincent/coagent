#!/usr/bin/env node

// Push the kitty keyboard "disambiguate escape codes" flag as early as
// possible so the terminal has time to switch modes before user input.
// Only the human TUI needs it (Shift+Enter / disambiguated key reads via
// Ink). For hub/agent the flag would suppress the legacy Ctrl+C byte in
// kitty-aware terminals, breaking SIGINT delivery — they read no stdin
// and rely on the TTY driver to translate ^C into SIGINT.
const ESC = String.fromCharCode(27);
const KITTY_PUSH = ESC + "[>1u";
const KITTY_POP = ESC + "[<u";

if (process.argv[2] === "human" && process.stdout.isTTY) {
  process.stdout.write(KITTY_PUSH);
  process.on("exit", () => {
    try {
      process.stdout.write(KITTY_POP);
    } catch {}
  });
}

await import("../dist/cli.js");
