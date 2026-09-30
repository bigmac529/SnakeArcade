// Resolve the "build" input of the production deploy workflow to one release.
//
// Builds are GitHub Releases created by .github/workflows/build-and-deploy-test.yml,
// tagged build-<build number>-<7-char commit sha>. Each successful deploy to the
// test site appends a line to the release notes:
//   - 2026-09-28 12:38 UTC: deployed to **test** (<run url>)
// Only the notes and title are edited after publishing, so this works with
// GitHub's immutable releases turned on. Inputs:
//
//   latest-test (or empty)   the build currently on test (most recent test deploy)
//   build-42-1a2b3c4         that release tag
//   42                       build number 42
//   1a2b3c4 / full sha       the newest build of that commit
//
// Only releases published by github-actions[bot] with the build-N-sha tag format
// count. A build that never deployed to test is refused unless allowUntested.
//
// CLI (used by the workflow): env GITHUB_REPOSITORY, GITHUB_TOKEN, BUILD_INPUT,
// ALLOW_UNTESTED; writes tag/sha/number/tested/zip_name/zip_url/sha256_url to GITHUB_OUTPUT.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const TAG_RE = /^build-(\d+)-([0-9a-f]{7})$/;
export const BOT = "github-actions[bot]";
// Written by the mark-tested job of build-and-deploy-test.yml.
export const TESTED_RE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC: deployed to \*\*test\*\*/gm;

// Time of the most recent successful test deploy recorded in the notes, or 0.
export function lastTestedAt(body) {
  let last = 0;
  for (const m of String(body || "").matchAll(TESTED_RE)) {
    const t = Date.parse(`${m[1]}T${m[2]}:00Z`);
    if (Number.isFinite(t) && t > last) {
      last = t;
    }
  }
  return last;
}

export function toBuild(release) {
  const m = TAG_RE.exec(release.tag_name || "");
  if (!m || release.draft || !release.author || release.author.login !== BOT) {
    return null;
  }
  const zip = (release.assets || []).find((a) => a.name === `snakearcade-${release.tag_name}.zip`);
  const sum = (release.assets || []).find((a) => a.name === `snakearcade-${release.tag_name}.zip.sha256`);
  return {
    tag: release.tag_name,
    number: Number(m[1]),
    sha7: m[2],
    sha: /^[0-9a-f]{40}$/.test(release.target_commitish || "") ? release.target_commitish : "",
    testedAt: lastTestedAt(release.body),
    get tested() {
      return this.testedAt > 0;
    },
    zip,
    sum
  };
}

export function pickBuild(releases, rawInput, { allowUntested = false } = {}) {
  const builds = releases.map(toBuild).filter(Boolean);
  const input = String(rawInput || "").trim().toLowerCase();
  let matches;
  let what;
  if (input === "" || input === "latest-test") {
    what = "the build currently on test";
    // Most recent successful test deploy; same minute: the higher build number.
    matches = builds.filter((b) => b.tested).sort((a, b) => b.testedAt - a.testedAt || b.number - a.number).slice(0, 1);
    if (!matches.length) {
      throw new Error("No build has been deployed to test yet. Enter a build tag, build number or commit SHA instead.");
    }
  } else if (TAG_RE.test(input)) {
    what = `tag ${input}`;
    matches = builds.filter((b) => b.tag === input);
  } else if (/^\d+$/.test(input)) {
    what = `build number ${input}`;
    matches = builds.filter((b) => b.number === Number(input));
  } else if (/^[0-9a-f]{7,40}$/.test(input)) {
    what = `commit ${input}`;
    matches = builds.filter((b) => b.sha7 === input.slice(0, 7) && (input.length === 7 || (b.sha && b.sha.startsWith(input))));
  } else {
    throw new Error(`"${rawInput}" is not a build. Use latest-test, a tag like build-42-1a2b3c4, a build number like 42, or a commit SHA.`);
  }
  if (!matches.length) {
    throw new Error(`No build found for ${what}. See the repo's Releases page for the list of builds.`);
  }
  const build = matches.sort((a, b) => b.number - a.number)[0];
  if (!build.zip || !build.sum) {
    throw new Error(`Build ${build.tag} has no snakearcade-${build.tag}.zip / .sha256 asset.`);
  }
  if (!build.sha) {
    throw new Error(`Build ${build.tag} does not record its full commit SHA (release target).`);
  }
  if (!build.tested && !allowUntested) {
    throw new Error(`Build ${build.tag} never deployed successfully to test. Deploy it to test first, or tick "Allow a build that never deployed successfully to test".`);
  }
  return build;
}

async function api(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" }
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${repo}/releases?per_page=100&page=${page}`, token);
    releases.push(...(batch || []));
    if (!batch || batch.length < 100) {
      break;
    }
  }
  const build = pickBuild(releases, process.env.BUILD_INPUT, {
    allowUntested: process.env.ALLOW_UNTESTED === "true"
  });
  const out = {
    tag: build.tag,
    sha: build.sha,
    number: String(build.number),
    tested: String(build.tested),
    zip_name: build.zip.name,
    zip_url: build.zip.browser_download_url,
    sha256_url: build.sum.browser_download_url
  };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
  console.log(`Selected ${build.tag} (commit ${build.sha}, ${build.tested ? "deployed to test" : "NOT deployed to test"})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
