/**
 * Tests for the unlock-token gate.
 *
 *   node --test 'test/*.test.mjs'
 *
 * WHY THIS EXISTS
 * ---------------
 * tokenOk() is the single gate on every authenticated Worker route, and it had
 * no test at all. On 4 Aug 2026 it returned 401 to the scheduled runner for a
 * whole day: the morning brief was written, committed and pushed, the delivery
 * backstop correctly found it and tried to send it, and the Worker rejected the
 * credential. From the outside a wrong token and a right token carrying one
 * trailing newline are the same 401 — and a newline is exactly what you get
 * pasting a secret into the GitHub secrets box or `wrangler secret put`.
 *
 * So the trimming is now load-bearing on both sides, and these lock it in.
 * The timing-safety property matters too: the comparison must not return early
 * on the first differing byte, or the token is guessable one character at a
 * time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenOk } from "../worker/worker.js";

const req = (auth) => ({
  headers: { get: (h) => (h.toLowerCase() === "authorization" ? auth : null) },
});
const env = (t) => ({ UNLOCK_TOKEN: t });

const SECRET = "s3cr3t-unlock-token";

test("accepts the exact token", () => {
  assert.equal(tokenOk(req(`Bearer ${SECRET}`), env(SECRET)), true);
});

test("rejects a different token", () => {
  assert.equal(tokenOk(req("Bearer nope"), env(SECRET)), false);
});

test("rejects a token differing only in the last character", () => {
  assert.equal(tokenOk(req(`Bearer ${SECRET.slice(0, -1)}X`), env(SECRET)), false);
});

// The twelve-day failure, and then the one-day repeat of it, both reduce to
// these four. Each was a 401 indistinguishable from a wrong credential.
test("trailing newline on the sent token still authenticates", () => {
  assert.equal(tokenOk(req(`Bearer ${SECRET}\n`), env(SECRET)), true);
});

test("trailing newline on the stored secret still authenticates", () => {
  assert.equal(tokenOk(req(`Bearer ${SECRET}`), env(`${SECRET}\n`)), true);
});

test("whitespace on both sides at once still authenticates", () => {
  assert.equal(tokenOk(req(`Bearer  ${SECRET}\r\n`), env(`  ${SECRET}  `)), true);
});

test("a CR alone does not break the match", () => {
  assert.equal(tokenOk(req(`Bearer ${SECRET}\r`), env(SECRET)), true);
});

// Trimming must not become a way in.
test("an unset secret rejects everything, including an empty bearer", () => {
  assert.equal(tokenOk(req("Bearer "), env(undefined)), false);
  assert.equal(tokenOk(req("Bearer anything"), env(undefined)), false);
});

test("a whitespace-only secret is treated as unset, not as a matchable value", () => {
  assert.equal(tokenOk(req("Bearer "), env("   ")), false);
  assert.equal(tokenOk(req("Bearer    "), env("   ")), false);
});

test("a missing Authorization header rejects", () => {
  assert.equal(tokenOk(req(null), env(SECRET)), false);
});

test("the Bearer prefix is optional and case-insensitive", () => {
  assert.equal(tokenOk(req(SECRET), env(SECRET)), true);
  assert.equal(tokenOk(req(`bearer ${SECRET}`), env(SECRET)), true);
});

// Not a timing measurement — that would be flaky in CI. This asserts the
// structural property that makes the compare safe: every byte is examined, so
// the loop cannot bail on the first mismatch and leak the position.
test("compares every byte rather than stopping at the first difference", () => {
  const body = tokenOk.toString();
  // From the loop up to (not including) the function's final `return diff…`.
  const loop = body.slice(body.indexOf("for ("), body.lastIndexOf("return"));
  assert.ok(loop.startsWith("for ("), "expected a comparison loop");
  assert.match(loop, /\|=/, "expected the loop to accumulate differences with |=");
  assert.doesNotMatch(loop, /\breturn\b/, "the loop must not return early on a differing byte");
});
