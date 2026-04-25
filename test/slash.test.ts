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
  assert.equal(
    completeSlash("/clear AL", ["alice"]),
    "/clear alice",
  );
});
