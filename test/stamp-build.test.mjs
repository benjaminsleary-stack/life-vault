/**
 * Tests for scripts/stamp-build.mjs and the staleness check it feeds.
 *
 *   node --test test/stamp-build.test.mjs
 *
 * WHY
 * ---
 * 21 August 2026: two fixes were verified in a browser, merged, and reported as
 * shipped — and the bugs were still on the phone. "The deploy never landed" and
 * "the deploy landed but the phone kept the old copy" are indistinguishable from
 * outside, and telling them apart took a round trip and a hand-written request
 * grepping the live HTML for a fragment of JavaScript.
 *
 * So the app now carries its own identity (`<meta name="lv-build">`, baked in at
 * stamp time) and the deployment publishes its own (`build.json`, read past the
 * cache). Different values mean the running tab is stale. That is only true if
 * the two are always stamped together — which is what these assert.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A throwaway copy of the app, so stamping in a test never touches the real one.
function appFixture() {
  const dir = mkdtempSync(join(tmpdir(), "lv-stamp-"));
  mkdirSync(join(dir, "dashboard"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts/stamp-build.mjs"), join(dir, "scripts/stamp-build.mjs"));
  cpSync(join(ROOT, "dashboard/index.html"), join(dir, "dashboard/index.html"));
  cpSync(join(ROOT, "dashboard/sw.js"), join(dir, "dashboard/sw.js"));
  return dir;
}
const stamp = (dir, ...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(dir, "scripts/stamp-build.mjs"), ...args],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status, out: String(e.stdout || "") }; }
};
const readApp = (dir, f) => readFileSync(join(dir, "dashboard", f), "utf8");
const metaOf = (html) => html.match(/<meta name="lv-build" content="([^"]*)"/)?.[1] || null;

test("stamping puts the same build in the page and in build.json", () => {
  const dir = appFixture();
  assert.equal(stamp(dir).code, 0);
  const meta = metaOf(readApp(dir, "index.html"));
  const json = JSON.parse(readApp(dir, "build.json"));
  assert.ok(meta, "index.html was not stamped");
  assert.equal(json.build, meta, "the page and the deployment must claim the same build");
  assert.match(meta, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  rmSync(dir, { recursive: true, force: true });
});

test("re-stamping replaces the stamp rather than adding a second one", () => {
  const dir = appFixture();
  stamp(dir);
  const first = metaOf(readApp(dir, "index.html"));
  // The stamp has one-second resolution, so wait past it before restamping —
  // otherwise "the identity changed" is untestable within the same second.
  const wait = Date.now() + 1100; while (Date.now() < wait) { /* spin */ }
  stamp(dir);
  const html = readApp(dir, "index.html");
  assert.equal((html.match(/<meta name="lv-build"/g) || []).length, 1,
    "a second stamp must not accumulate a second tag");
  assert.notEqual(metaOf(html), first, "re-stamping must produce a new identity");
  assert.equal(JSON.parse(readApp(dir, "build.json")).build, metaOf(html));
  rmSync(dir, { recursive: true, force: true });
});

test("the service worker's cache name moves with the build", () => {
  // Otherwise a new deployment can be served out of the previous shell cache.
  const dir = appFixture();
  const before = readApp(dir, "sw.js").match(/const SHELL = "([^"]*)"/)[1];
  stamp(dir);
  const after = readApp(dir, "sw.js").match(/const SHELL = "([^"]*)"/)[1];
  assert.notEqual(after, before);
  assert.match(after, /^lv-shell-\d+$/);
  rmSync(dir, { recursive: true, force: true });
});

test("--check passes when they agree and fails when they drift", () => {
  const dir = appFixture();
  stamp(dir);
  assert.equal(stamp(dir, "--check").code, 0, "a freshly stamped app must check out");

  // Simulate the drift this whole mechanism exists to detect: a page built at
  // one moment, a deployment published at another.
  const html = readApp(dir, "index.html")
    .replace(/<meta name="lv-build" content="[^"]*"/, '<meta name="lv-build" content="1999-01-01T00:00:00Z"');
  writeFileSync(join(dir, "dashboard/index.html"), html);
  const r = stamp(dir, "--check");
  assert.equal(r.code, 1, "drift must be reported, not shrugged off");
  assert.match(r.out, /1999-01-01/);
  rmSync(dir, { recursive: true, force: true });
});

test("the app reads both identities and reloads a stale tab on a notification", () => {
  // The three moving parts, asserted where they live. Verified end to end in
  // Chromium: a fresh tab handles the intent in place (0 navigations, state
  // kept); a stale tab reloads (2 navigations) and still lands on the digest
  // the notification named.
  const app = readFileSync(join(ROOT, "dashboard/index.html"), "utf8");
  assert.match(app, /<meta name="lv-build" content="[^"]*"/, "the page must carry its own build");
  assert.match(app, /fetch\("build\.json\?t="/, "and must read the deployed build past the cache");
  assert.match(app, /if\(isStale\(\)\)\{ window\.focus\(\); location\.href=d\.url; handled=true; \}/,
    "a stale tab must reload AT the intent url, not answer with old code");
});
