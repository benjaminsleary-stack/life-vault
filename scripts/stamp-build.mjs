#!/usr/bin/env node
/**
 * Stamp the app with a build identity, immediately before deploying it.
 *
 *   node scripts/stamp-build.mjs          # stamp
 *   node scripts/stamp-build.mjs --check  # print the current stamp, change nothing
 *
 * Then: cd dashboard && npx wrangler pages deploy . --project-name life-vault-app
 *
 * ## Why
 *
 * On 21 August 2026 two fixes were verified working in a browser, merged, and
 * reported as shipped — and the bugs were still on Ben's phone. The cause could
 * have been either "the deploy never landed" or "the deploy landed and the phone
 * is running a stale copy", and **those two look identical from the outside**.
 * It took a round trip and a hand-written `Invoke-WebRequest` grepping the live
 * HTML for a fragment of JavaScript to find out which. (It was the first.)
 *
 * A page that cannot say which version it is cannot be debugged remotely. So:
 *
 *   - `<meta name="lv-build">` in index.html — the identity of the page you are
 *     RUNNING, baked in at stamp time.
 *   - `dashboard/build.json` — the identity of the page that is DEPLOYED,
 *     fetched fresh past the cache.
 *
 * Different values mean the tab is stale, which the app can then say out loud
 * and act on, instead of quietly handing a notification to old code.
 *
 * The stamp is a UTC timestamp, not the commit SHA: stamping with the SHA and
 * then committing the stamp changes the SHA, so it can never be true of its own
 * commit. The SHA rides along as information.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "dashboard");
const META_RE = /<meta name="lv-build" content="([^"]*)"\s*\/?>/;

const read = (p) => readFileSync(join(APP, p), "utf8");

if (process.argv.includes("--check")) {
  const cur = read("index.html").match(META_RE);
  let deployed = null;
  try { deployed = JSON.parse(read("build.json")).build; } catch { /* not stamped yet */ }
  console.log(`index.html : ${cur ? cur[1] : "(unstamped)"}`);
  console.log(`build.json : ${deployed || "(missing)"}`);
  process.exit(cur && deployed && cur[1] === deployed ? 0 : 1);
}

const build = new Date().toISOString().replace(/\.\d+Z$/, "Z");
let sha = "";
try {
  sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch { /* deploying from a tarball is allowed; the timestamp is the identity */ }

// 1. index.html — the running page's own identity.
let html = read("index.html");
if (META_RE.test(html)) {
  html = html.replace(META_RE, `<meta name="lv-build" content="${build}" />`);
} else {
  // First run: put it directly after the viewport tag, inside the first 8KB so
  // it is cheap to find both here and by hand with curl.
  html = html.replace(/(<meta name="viewport"[^>]*>\n)/, `$1<meta name="lv-build" content="${build}" />\n`);
  if (!META_RE.test(html)) throw new Error("could not place <meta name=\"lv-build\"> — is index.html intact?");
}
writeFileSync(join(APP, "index.html"), html);

// 2. build.json — what the server is serving, read past the cache by the page.
writeFileSync(join(APP, "build.json"), JSON.stringify({ build, sha }, null, 2) + "\n");

// 3. sw.js — a new shell cache name, so the service worker installs afresh and
//    drops the previous cache rather than serving it as an offline fallback.
const swPath = join(APP, "sw.js");
const sw = readFileSync(swPath, "utf8").replace(
  /const SHELL = "[^"]*";/,
  `const SHELL = "lv-shell-${build.replace(/[^0-9]/g, "").slice(0, 14)}";`,
);
writeFileSync(swPath, sw);

console.log(`stamped ${build}${sha ? ` (${sha})` : ""}`);
console.log("now: cd dashboard && npx wrangler pages deploy . --project-name life-vault-app --branch main");
