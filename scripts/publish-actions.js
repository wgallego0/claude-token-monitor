#!/usr/bin/env node
/**
 * publish-actions.js — used by the GitHub Actions workflow.
 *
 * Two modes:
 *   1. INPUT_PAYLOAD env var is set  → write that JSON to usage.json on data branch
 *   2. ANTHROPIC_OAUTH_TOKEN is set  → probe Anthropic API and commit fresh data
 *   3. Neither                       → skip (nothing to publish)
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: repoRoot, stdio: "inherit", ...opts });

async function switchToDataBranch() {
  try {
    sh("git fetch origin data --depth=1");
    sh("git checkout data");
  } catch {
    sh("git checkout --orphan data");
    try { sh("git rm -rf . --quiet"); } catch {}
  }
}

async function commitAndPush(json) {
  const dest = path.join(repoRoot, "usage.json");
  fs.writeFileSync(dest, json);
  sh('git config user.email "bot@claude-token-monitor"');
  sh('git config user.name "token-monitor"');
  sh("git add usage.json");
  try {
    sh(`git commit -m "data: snapshot ${new Date().toISOString()}"`);
    sh("git push origin data");
    console.log("[actions] snapshot pushed");
  } catch {
    console.log("[actions] no changes since last snapshot — skipped");
  }
}

async function main() {
  const payload     = (process.env.INPUT_PAYLOAD || "").trim();
  const oauthToken  = (process.env.ANTHROPIC_OAUTH_TOKEN || "").trim();

  if (payload) {
    console.log("[actions] using payload from workflow_dispatch input");
    await switchToDataBranch();
    await commitAndPush(payload);
    return;
  }

  if (oauthToken) {
    console.log("[actions] probing Anthropic API with stored OAuth token");
    // Write temporary credentials so usage.js can pick them up
    const credsDir  = path.join(os.homedir(), ".claude");
    const credsPath = path.join(credsDir, ".credentials.json");
    fs.mkdirSync(credsDir, { recursive: true });
    fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: oauthToken } }));

    const json = execSync("node scripts/usage.js --json", { cwd: repoRoot }).toString();
    await switchToDataBranch();
    await commitAndPush(json);
    return;
  }

  console.log("[actions] no INPUT_PAYLOAD and no ANTHROPIC_OAUTH_TOKEN — skipping");
}

main().catch(err => { console.error(err); process.exit(1); });
