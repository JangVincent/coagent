import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandFileRefsInContent } from "../src/human/file-ref.ts";

let tmp: string;
let prevCwd: string;

before(() => {
  prevCwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coagent-fileref-"));
  fs.writeFileSync(path.join(tmp, "existing.md"), "x");
  fs.mkdirSync(path.join(tmp, "src"));
  fs.writeFileSync(path.join(tmp, "src", "auth.ts"), "x");
  process.chdir(tmp);
});

after(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("pure identifier mention is preserved", () => {
  assert.equal(expandFileRefsInContent("hello @vincent"), "hello @vincent");
});

test("dotted bare token (e.g. version) is preserved when missing", () => {
  assert.equal(expandFileRefsInContent("on @v1.0"), "on @v1.0");
});

test("email-like @vincent.com is preserved", () => {
  assert.equal(
    expandFileRefsInContent("mail @vincent.com"),
    "mail @vincent.com",
  );
});

test("slashed path is expanded even when file does not exist", () => {
  const out = expandFileRefsInContent("create @src/newfile.ts");
  assert.equal(out, `create ${path.join(tmp, "src", "newfile.ts")}`);
});

test("explicit ./ prefix is expanded for missing file", () => {
  const out = expandFileRefsInContent("see @./futurefile.md");
  assert.equal(out, `see ${path.join(tmp, "futurefile.md")}`);
});

test("absolute path is preserved as-is", () => {
  assert.equal(
    expandFileRefsInContent("@/etc/hosts please"),
    "/etc/hosts please",
  );
});

test("~/foo is expanded to homedir", () => {
  const out = expandFileRefsInContent("@~/notes.md");
  assert.equal(out, path.join(os.homedir(), "notes.md"));
});

test("bare ~ expands to homedir", () => {
  assert.equal(expandFileRefsInContent("@~"), os.homedir());
});

test("bare dotted token whose file exists IS expanded", () => {
  const out = expandFileRefsInContent("read @existing.md");
  assert.equal(out, `read ${path.join(tmp, "existing.md")}`);
});

test("bare dotted token whose file does NOT exist stays as-is", () => {
  assert.equal(
    expandFileRefsInContent("read @missing.md"),
    "read @missing.md",
  );
});
