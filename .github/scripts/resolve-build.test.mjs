// node --test .github/scripts/resolve-build.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pickBuild, lastTestedAt } from "./resolve-build.mjs";

const sha = (c) => c.repeat(40);
const run = "https://github.com/bigmac529/SnakeArcade/actions/runs/1";
const testedLine = (when) => `- ${when} UTC: deployed to **test** (${run})`;
function rel(n, c, { tested = [], author = "github-actions[bot]", draft = false, assets = true, extra = "" } = {}) {
  const tag = `build-${n}-${sha(c).slice(0, 7)}`;
  return {
    tag_name: tag, draft, author: { login: author }, target_commitish: sha(c),
    body: ["Build notes", "", "#### Deployments", ...tested.map(testedLine), extra].join("\n"),
    assets: assets ? [{ name: `snakearcade-${tag}.zip`, browser_download_url: `https://x/${tag}.zip` }, { name: `snakearcade-${tag}.zip.sha256`, browser_download_url: `https://x/${tag}.zip.sha256` }] : []
  };
}
const releases = [
  rel(12, "c"),                                                      // built, test deploy failed
  rel(11, "b", { tested: ["2026-09-28 10:00"] }),
  rel(10, "a", { tested: ["2026-09-27 09:00"], extra: "- 2026-09-27 12:00 UTC: deployed to **production** by @x (u)" }),
  rel(9, "b", { tested: ["2026-09-26 09:00"] }),
  rel(8, "d", { author: "someone", tested: ["2026-09-28 23:00"] }),  // not published by the workflow
  { tag_name: "v1.0", author: { login: "github-actions[bot]" } }
];

test("lastTestedAt reads the newest test deploy line only", () => {
  assert.equal(lastTestedAt(""), 0);
  assert.equal(lastTestedAt("- 2026-09-27 12:00 UTC: deployed to **production** by @x"), 0);
  assert.equal(lastTestedAt([testedLine("2026-09-27 09:00"), testedLine("2026-09-28 10:30")].join("\n")), Date.parse("2026-09-28T10:30:00Z"));
});
test("latest-test (and empty) picks the most recent successful test deploy", () => {
  assert.equal(pickBuild(releases, "latest-test").tag, "build-11-bbbbbbb");
  assert.equal(pickBuild(releases, "  ").tag, "build-11-bbbbbbb");
  // An older build redeployed to test later is the one on test now.
  const redeployed = [...releases.slice(0, 2), rel(10, "a", { tested: ["2026-09-27 09:00", "2026-09-28 11:00"] })];
  assert.equal(pickBuild(redeployed, "latest-test").tag, "build-10-aaaaaaa");
  assert.throws(() => pickBuild([rel(12, "c")], "latest-test"), /No build has been deployed to test/);
});
test("tag, build number, short and full SHA", () => {
  assert.equal(pickBuild(releases, "build-10-aaaaaaa").tag, "build-10-aaaaaaa");
  assert.equal(pickBuild(releases, "BUILD-10-AAAAAAA").tag, "build-10-aaaaaaa");
  assert.equal(pickBuild(releases, "10").tag, "build-10-aaaaaaa");
  assert.equal(pickBuild(releases, "bbbbbbb").tag, "build-11-bbbbbbb", "newest build of a commit");
  assert.equal(pickBuild(releases, sha("a")).tag, "build-10-aaaaaaa");
  assert.equal(pickBuild(releases, "9").tested, true);
});
test("untested builds need allowUntested", () => {
  assert.throws(() => pickBuild(releases, "12"), /never deployed successfully to test/);
  const b = pickBuild(releases, "12", { allowUntested: true });
  assert.equal(b.tag, "build-12-ccccccc");
  assert.equal(b.tested, false);
});
test("only bot-published build-N-sha releases count; bad input is explained", () => {
  assert.throws(() => pickBuild(releases, "8"), /No build found/);
  assert.throws(() => pickBuild(releases, "v1.0"), /is not a build/);
  assert.throws(() => pickBuild(releases, "99"), /No build found/);
  assert.throws(() => pickBuild([rel(5, "e", { assets: false, tested: ["2026-09-28 10:00"] })], "5"), /no snakearcade-build-5-eeeeeee.zip/);
  assert.throws(() => pickBuild(releases, "x; rm -rf /"), /is not a build/);
});
