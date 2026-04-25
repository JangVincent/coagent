#!/usr/bin/env node

// Push the kitty keyboard "disambiguate escape codes" flag as early as
// possible so the terminal has time to switch modes before the user
// types. This is what makes Shift+Enter detectable from the very first
// keystroke. Pushing on a non-TTY or non-supporting terminal is a no-op.
const ESC = String.fromCharCode(27);
const KITTY_PUSH = ESC + "[>1u";
const KITTY_POP = ESC + "[<u";

if (process.stdout.isTTY) {
  process.stdout.write(KITTY_PUSH);
  const pop = () => {
    try {
      process.stdout.write(KITTY_POP);
    } catch {}
  };
  process.on("exit", pop);
  process.on("SIGINT", () => {
    pop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    pop();
    process.exit(143);
  });
}

await import("../dist/cli.js");
