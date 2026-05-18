#!/usr/bin/env node
/**
 * publish-actions.js — executado pelo GitHub Actions workflow.
 *
 * Modos (em ordem de prioridade):
 *   1. INPUT_PAYLOAD definido  → grava esse JSON diretamente (push da máquina local)
 *   2. ANTHROPIC_OAUTH_TOKEN   → probe autônomo: atualiza plan/% e preserva tokens
 *   3. Nenhum                  → skip
 */
const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const https = require("https");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: repoRoot, stdio: "inherit", ...opts });

// ── Git helpers ─────────────────────────────────────────────────────────────

function switchToDataBranch() {
  try {
    sh("git fetch origin data --depth=1");
    sh("git checkout data");
  } catch {
    sh("git checkout --orphan data");
    try { sh("git rm -rf . --quiet"); } catch {}
  }
}

function commitAndPush(json) {
  fs.writeFileSync(path.join(repoRoot, "usage.json"), json);
  sh('git config user.email "bot@claude-token-monitor"');
  sh('git config user.name "token-monitor"');
  sh("git add usage.json");
  try {
    sh(`git commit -m "data: snapshot ${new Date().toISOString()}"`);
    sh("git push origin data");
    console.log("[actions] snapshot enviado");
  } catch {
    console.log("[actions] sem mudanças — skipped");
  }
}

// ── Probe Anthropic rate-limit headers ─────────────────────────────────────

function probePlanLimits(token) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "1" }] });
    const req = https.request({
      host: "api.anthropic.com", port: 443, path: "/v1/messages", method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-token-monitor/0.2",
        "Content-Type": "application/json",
      }, timeout: 12000,
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        const h = res.headers;
        const num = k => { const v = h[k]; return v == null ? null : Number(v); };
        resolve({
          fiveh: { utilization: num("anthropic-ratelimit-unified-5h-utilization"), resetEpoch: num("anthropic-ratelimit-unified-5h-reset"), status: h["anthropic-ratelimit-unified-5h-status"] || null },
          week:  { utilization: num("anthropic-ratelimit-unified-7d-utilization"), resetEpoch: num("anthropic-ratelimit-unified-7d-reset"), status: h["anthropic-ratelimit-unified-7d-status"] || null },
          fallback: { percentage: num("anthropic-ratelimit-unified-fallback-percentage"), status: h["anthropic-ratelimit-unified-fallback"] || null },
          overage: { status: h["anthropic-ratelimit-unified-overage-status"] || null },
          representativeClaim: h["anthropic-ratelimit-unified-representative-claim"] || null,
          sampledAt: new Date().toISOString(),
        });
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Lê usage.json atual do branch data ─────────────────────────────────────

function readCurrentSnapshot() {
  const p = path.join(repoRoot, "usage.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const payload    = (process.env.INPUT_PAYLOAD || "").trim();
  const oauthToken = (process.env.ANTHROPIC_OAUTH_TOKEN || "").trim();

  // Modo 1: payload da máquina local
  if (payload) {
    console.log("[actions] modo: payload local");
    switchToDataBranch();
    commitAndPush(payload);
    return;
  }

  // Modo 2: probe autônomo
  if (oauthToken) {
    console.log("[actions] modo: probe autônomo");
    switchToDataBranch();

    const prev = readCurrentSnapshot() || {};
    const plan  = await probePlanLimits(oauthToken);

    if (!plan) {
      console.log("[actions] probe falhou (token expirado?) — skipped");
      process.exit(0);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const pct    = (u) => u != null ? +(u * 100).toFixed(1) : null;

    // Mescla: percentuais frescos do probe + contagens anteriores do snapshot local
    const snapshot = {
      fiveh: {
        percent:     pct(plan.fiveh.utilization) ?? prev.fiveh?.percent ?? 0,
        secondsLeft: plan.fiveh.resetEpoch ? Math.max(0, plan.fiveh.resetEpoch - nowSec) : (prev.fiveh?.secondsLeft ?? 18000),
        status:      plan.fiveh.status,
        // Mantém contagens do último snapshot local (não disponível no Actions)
        tokens:   prev.fiveh?.tokens   ?? 0,
        cost_usd: prev.fiveh?.cost_usd ?? 0,
        messages: prev.fiveh?.messages ?? 0,
      },
      week: {
        percent:     pct(plan.week.utilization) ?? prev.week?.percent ?? 0,
        secondsLeft: plan.week.resetEpoch ? Math.max(0, plan.week.resetEpoch - nowSec) : (prev.week?.secondsLeft ?? 0),
        status:      plan.week.status,
        tokens:   prev.week?.tokens   ?? 0,
        cost_usd: prev.week?.cost_usd ?? 0,
        messages: prev.week?.messages ?? 0,
      },
      plan: {
        fallback_percentage: plan.fallback?.percentage,
        fallback_status:     plan.fallback?.status,
        overage_status:      plan.overage?.status,
        representative:      plan.representativeClaim,
        sampled_at:          plan.sampledAt,
      },
      // Preserva today/month/all do último snapshot da máquina local
      today: prev.today ?? { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0, cost_usd: 0 },
      month: prev.month ?? { tokens: 0, cost_usd: 0 },
      all:   prev.all   ?? { tokens: 0, cost_usd: 0 },
      timestamp: new Date().toISOString(),
    };

    commitAndPush(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log("[actions] nenhuma credencial configurada — adicione ANTHROPIC_OAUTH_TOKEN nos secrets do repo");
}

main().catch(err => { console.error(err); process.exit(1); });
