import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import updateNotifier from "update-notifier";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(here, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
  name: string;
  version: string;
};

const sub = process.argv[2];
const rest = process.argv.slice(3);

if (sub === "--version" || sub === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

const USAGE = `coagent — multi-participant chat for Claude Code agents and humans

usage:
  coagent hub [--host <addr>]              start the chat hub (default 127.0.0.1)
  coagent agent <name> [path] [--model <id>] [--resume]
                                           connect an agent (path defaults to cwd)
  coagent human <name>                     connect as a human
  coagent update                           install the latest version from npm
  coagent --version                        print version

hub options:
  --host <addr>                            bind address (default 127.0.0.1; use 0.0.0.0 to expose on LAN)

agent options:
  --model <id>                             pin the agent to a Claude model (e.g. claude-haiku-4-5)
  --resume                                 pick from past Claude sessions for that path

env:
  HUB_URL=ws://host:port                   override hub address (default ws://localhost:8787)
  HUB_HOST=addr                            hub bind address (overridden by --host)
  PORT=8787                                hub listen port
  AGENT_MODEL=<id>                         default agent model (--model wins)
`;

function bail(code: number, msg?: string): never {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(code);
}

if (sub === "update" || sub === "self-update" || sub === "upgrade") {
  console.log(
    `[coagent] updating ${pkg.name} from ${pkg.version} to latest…`,
  );
  // --prefer-online forces npm to revalidate registry metadata so a stale
  // local cache can't resolve "@latest" to a version that's already
  // superseded on the registry.
  const child = spawn(
    "npm",
    ["i", "-g", "--prefer-online", `${pkg.name}@latest`],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code === 0) {
      console.log(`[coagent] up to date.`);
    }
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`[coagent] failed to spawn npm: ${err.message}`);
    process.exit(1);
  });
  // keep the event loop alive — process.exit fires from child handlers above
} else if (
  sub === "hub" ||
  sub === "agent" ||
  sub === "human"
) {
  // Run update notifier (async fire-and-forget) only for normal commands.
  updateNotifier({
    pkg,
    updateCheckInterval: 1000 * 60 * 60 * 24,
    shouldNotifyInNpmScript: false,
  }).notify({
    defer: false,
    isGlobal: true,
    message:
      "Update available {currentVersion} → {latestVersion}\nRun coagent update to install.",
  });

  // Forward remaining argv to the dispatched module.
  process.argv = [process.argv[0], process.argv[1], ...rest];

  if (sub === "hub") await import("./hub.ts");
  else if (sub === "agent") await import("./agent.ts");
  else if (sub === "human") await import("./human.tsx");
} else if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
  bail(sub ? 0 : 1);
} else {
  bail(1, `unknown command: ${sub}`);
}
