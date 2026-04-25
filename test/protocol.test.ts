import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMentions } from "../src/protocol.ts";

test("plain identifier mention", () => {
  assert.deepEqual(parseMentions("@vincent hi"), ["vincent"]);
});

test("@all is recognized without validNames", () => {
  assert.deepEqual(parseMentions("@all please respond"), ["all"]);
});

test("multiple mentions, deduped", () => {
  assert.deepEqual(
    parseMentions("@alice and @bob, then @alice again"),
    ["alice", "bob"],
  );
});

test("email-like @vincent.com is not a mention", () => {
  assert.deepEqual(parseMentions("write to @vincent.com"), []);
});

test("path-like @./foo is not a mention", () => {
  assert.deepEqual(parseMentions("see @./src/foo.ts"), []);
});

test("home-relative @~/foo is not a mention", () => {
  assert.deepEqual(parseMentions("see @~/notes.md"), []);
});

test("validNames filters unknown identifiers", () => {
  const valid = new Set(["vincent"]);
  assert.deepEqual(
    parseMentions("@vincent and @stranger", valid),
    ["vincent"],
  );
});

test("@all stays even with restrictive validNames", () => {
  const valid = new Set(["vincent"]);
  assert.deepEqual(
    parseMentions("@all here we go", valid),
    ["all"],
  );
});

test("trailing punctuation does not break match", () => {
  assert.deepEqual(parseMentions("hi @alice, please review"), ["alice"]);
});

test("mention with hyphen and underscore", () => {
  assert.deepEqual(parseMentions("@back-end_v2 ping"), ["back-end_v2"]);
});

test("empty input → no mentions", () => {
  assert.deepEqual(parseMentions(""), []);
});
