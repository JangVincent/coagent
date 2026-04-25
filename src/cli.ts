export {};

const sub = process.argv[2];
const rest = process.argv.slice(3);

const USAGE = `coagent — multi-participant chat for Claude Code agents and humans

usage:
  coagent hub                              start the chat hub
  coagent agent <name> [path]              connect an agent (path defaults to cwd)
  coagent human <name>                     connect as a human

options (per subcommand):
  coagent hub --fresh                      archive old chat log and start clean
  coagent agent <name> [path] --new        ignore saved session, fresh Claude conversation
  coagent human <name> --no-history        skip backlog on connect

env:
  HUB_URL=ws://host:port                   override hub address (default ws://localhost:8787)
  PORT=8787                                hub listen port
  DATA_DIR=~/.data/agent-chat-cowork       override data directory
`;

function bail(code: number, msg?: string): never {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(code);
}

if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
  bail(sub ? 0 : 1);
}

// Forward remaining argv to the dispatched module.
process.argv = [process.argv[0], process.argv[1], ...rest];

switch (sub) {
  case "hub":
    await import("./hub.ts");
    break;
  case "agent":
    await import("./agent.ts");
    break;
  case "human":
    await import("./human.tsx");
    break;
  default:
    bail(1, `unknown command: ${sub}`);
}
