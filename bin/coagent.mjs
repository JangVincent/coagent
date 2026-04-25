#!/usr/bin/env node

// Push the kitty keyboard "disambiguate escape codes" flag as early as
// possible so the terminal has time to switch modes before user input.
// The 'exit' handler runs on any termination path (normal, process.exit,
// signal that wasn't caught), so it's enough on its own — we don't need
// to install SIGINT/SIGTERM handlers here, which would pre-empt
// per-command cleanup (e.g. hub closing its WebSocket server).
const ESC = String.fromCharCode(27);
const KITTY_PUSH = ESC + "[>1u";
const KITTY_POP = ESC + "[<u";

if (process.stdout.isTTY) {
  process.stdout.write(KITTY_PUSH);
  process.on("exit", () => {
    try {
      process.stdout.write(KITTY_POP);
    } catch {}
  });
}

await import("../dist/cli.js");
