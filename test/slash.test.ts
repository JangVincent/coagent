import { test } from "node:test";
import assert from "node:assert/strict";
import { completeSlash, longestCommonPrefix } from "../src/human/slash.ts";

test("longestCommonPrefix basic", () => {
  assert.equal(longestCommonPrefix(["clear", "compact"]), "c");
  assert.equal(longestCommonPrefix(["pause", "paste"]), "pa");
  assert.equal(longestCommonPrefix(["abc"]), "abc");
  assert.equal(longestCommonPrefix([]), "");
  assert.equal(longestCommonPrefix(["abc", "xyz"]), "");
});

test("non-slash input returns null", () => {
  assert.equal(completeSlash("hello", []), null);
});

test("unique command prefix completes with trailing space (needs arg)", () => {
  // /st → only /status
  assert.equal(completeSlash("/st", []), "/status ");
});

test("unique command prefix without args (quit)", () => {
  // /qu → /quit (no args)
  assert.equal(completeSlash("/qu", []), "/quit");
});

test("ambiguous prefix advances to LCP", () => {
  // /c → clear, compact → LCP "c" = same as input → null
  assert.equal(completeSlash("/c", []), null);
  // /cl → only clear
  assert.equal(completeSlash("/cl", []), "/clear ");
});

test("/pa is ambiguous (pause)", () => {
  // /pa → only pause (resume starts with re)
  assert.equal(completeSlash("/pa", []), "/pause ");
});

test("agent name completes uniquely", () => {
  assert.equal(
    completeSlash("/clear ali", ["alice", "bob"]),
    "/clear alice",
  );
});

test("ambiguous agent name returns null when LCP equals input", () => {
  // /clear b → bob, brad → LCP "b" same as input → null
  assert.equal(completeSlash("/clear b", ["bob", "brad"]), null);
});

test("agent name advances when LCP is longer than input", () => {
  // /clear bo → bob, brad → bob (only bob starts with "bo")
  assert.equal(
    completeSlash("/clear bo", ["bob", "brad"]),
    "/clear bob",
  );
});

test("unknown command does not complete agent name", () => {
  assert.equal(completeSlash("/nope al", ["alice"]), null);
});

test("local command (quit) does not match agents", () => {
  // /quit a → /quit has no op so agent completion is skipped
  assert.equal(completeSlash("/quit a", ["alice"]), null);
});

test("case-insensitive agent matching", () => {
  // ALI is unambiguous — "all" doesn't match this prefix, only alice does.
  assert.equal(
    completeSlash("/clear ALI", ["alice"]),
    "/clear alice",
  );
});

test("/clear AL is ambiguous between 'all' and 'alice' (returns null)", () => {
  // Both candidates start with "al" — LCP equals input → no progress.
  assert.equal(completeSlash("/clear AL", ["alice"]), null);
});

test("'all' is a virtual fan-out target — completes when unambiguous", () => {
  // No real agents — only "all" matches "al".
  assert.equal(completeSlash("/clear al", []), "/clear all");
});

test("'all' competes with agent names and yields LCP", () => {
  // "all" + "alice" both start with "a" → LCP "al" → advance.
  assert.equal(completeSlash("/clear a", ["alice"]), "/clear al");
});

test("/clear all completes when fully typed and unique", () => {
  // "alice" no longer matches "all", so only "all" remains → unique completion.
  assert.equal(completeSlash("/clear all", ["alice"]), "/clear all");
});
