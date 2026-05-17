#!/usr/bin/env node
/**
 * Claude Code Token Monitor
 *
 * Reads ~/.claude/projects/<project>/<session>.jsonl, sums usage tokens from
 * assistant messages, and prints daily / monthly / lifetime totals plus a
 * per-project breakdown. No network calls, no API key required.
 *
 * Run via the /usage slash command (this plugin) or directly:
 *     node scripts/usage.js          # human report
 *     node scripts/usage.js --json   # machine output (for statusline)
 *     node scripts/usage.js --today  # one-line: today's totals only
 */

const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const https = require("https");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CREDS_PATH   = path.join(os.homedir(), ".claude", ".credentials.json");

// ──────────────────────────────────────────────────────────────────────────
// Anthropic plan-usage probe
//
// Claude Code's internal "5h / weekly" panel reads the unified rate-limit
// headers that come back on every /v1/messages response. There's no dedicated
// GET endpoint that returns the same numbers. So we make a 1-token request
// (literally "1" → 1 output token) and parse the headers. Costs ~$0.00005 per
// poll and gives us exactly the percentages and reset timestamps Anthropic's
// backend computes.
// ──────────────────────────────────────────────────────────────────────────

let planCache       = null;        // last parsed plan-limits object
let planCacheUntil  = 0;           // monotonic ms; refresh after this

function readOauthToken() {
    try {
        const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
        return c.claudeAiOauth?.accessToken || null;
    } catch { return null; }
}

function probePlanLimits() {
    return new Promise((resolve) => {
        const token = readOauthToken();
        if (!token) return resolve(null);

        const body = JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "1" }],
        });

        const req = https.request({
            host: "api.anthropic.com",
            port: 443,
            path: "/v1/messages",
            method: "POST",
            headers: {
                "Authorization":     `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta":    "oauth-2025-04-20",
                "User-Agent":        "claude-token-monitor/0.2",
                "Content-Type":      "application/json",
            },
            timeout: 12000,
        }, (res) => {
            // Drain body but only headers matter to us
            res.on("data", () => {});
            res.on("end", () => {
                const h = res.headers;
                const num = (k) => {
                    const v = h[k];
                    return v == null ? null : Number(v);
                };
                resolve({
                    fiveh: {
                        utilization:  num("anthropic-ratelimit-unified-5h-utilization"),
                        resetEpoch:   num("anthropic-ratelimit-unified-5h-reset"),
                        status:       h["anthropic-ratelimit-unified-5h-status"] || null,
                    },
                    week: {
                        utilization:  num("anthropic-ratelimit-unified-7d-utilization"),
                        resetEpoch:   num("anthropic-ratelimit-unified-7d-reset"),
                        status:       h["anthropic-ratelimit-unified-7d-status"] || null,
                    },
                    fallback: {
                        percentage:   num("anthropic-ratelimit-unified-fallback-percentage"),
                        status:       h["anthropic-ratelimit-unified-fallback"] || null,
                    },
                    overage: {
                        status:       h["anthropic-ratelimit-unified-overage-status"] || null,
                        disabledReason: h["anthropic-ratelimit-unified-overage-disabled-reason"] || null,
                    },
                    representativeClaim: h["anthropic-ratelimit-unified-representative-claim"] || null,
                    sampledAt:    new Date().toISOString(),
                });
            });
        });
        req.on("error",   () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

async function getPlanLimits() {
    // Cache for 60s — we don't need to spam Anthropic
    const now = Date.now();
    if (planCache && now < planCacheUntil) return planCache;
    const fresh = await probePlanLimits();
    if (fresh) {
        planCache      = fresh;
        planCacheUntil = now + 60_000;
    }
    return fresh || planCache;
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────────────

function* iterSessionFiles() {
    if (!fs.existsSync(PROJECTS_DIR)) return;
    for (const project of fs.readdirSync(PROJECTS_DIR)) {
        const projPath = path.join(PROJECTS_DIR, project);
        let stat;
        try { stat = fs.statSync(projPath); } catch { continue; }
        if (!stat.isDirectory()) continue;
        for (const file of fs.readdirSync(projPath)) {
            if (file.endsWith(".jsonl")) {
                yield { project, file: path.join(projPath, file) };
            }
        }
    }
}

function emptyBucket() {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 };
}

function addInto(target, src) {
    target.input       += src.input;
    target.output      += src.output;
    target.cacheRead   += src.cacheRead;
    target.cacheCreate += src.cacheCreate;
    target.messages    += src.messages;
}

function aggregate() {
    const byDate    = new Map();   // 'YYYY-MM-DD' → bucket
    const byProject = new Map();   // projectId   → bucket
    const total     = emptyBucket();

    for (const { project, file } of iterSessionFiles()) {
        let content;
        try { content = fs.readFileSync(file, "utf8"); } catch { continue; }

        for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }

            // Only count assistant messages (they carry usage stats)
            const usage = obj?.message?.usage;
            if (!usage) continue;

            const entry = {
                input:       usage.input_tokens                || 0,
                output:      usage.output_tokens               || 0,
                cacheRead:   usage.cache_read_input_tokens     || 0,
                cacheCreate: usage.cache_creation_input_tokens || 0,
                messages:    1,
            };

            const date = obj.timestamp
                ? new Date(obj.timestamp).toISOString().slice(0, 10)
                : "unknown";

            if (!byDate.has(date))      byDate.set(date, emptyBucket());
            if (!byProject.has(project)) byProject.set(project, emptyBucket());

            addInto(byDate.get(date),    entry);
            addInto(byProject.get(project), entry);
            addInto(total, entry);
        }
    }

    return { byDate, byProject, total };
}

// ──────────────────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────────────────

const sum = b => b.input + b.output + b.cacheRead + b.cacheCreate;

function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
    return String(n);
}

function fmtCost(b) {
    // Sonnet 4.5 pricing (USD per 1M tokens): in $3, out $15, cache R $0.30, cache W $3.75
    const c = (b.input * 3 + b.output * 15 + b.cacheRead * 0.30 + b.cacheCreate * 3.75) / 1_000_000;
    return "$" + c.toFixed(2);
}

function bar(value, max, width = 24) {
    if (max <= 0) return " ".repeat(width);
    const filled = Math.min(width, Math.round((value / max) * width));
    return "█".repeat(filled) + "░".repeat(width - filled);
}

function projectShortName(id) {
    // e.g.  "D--PROJETOS-Wilton-yellowBoard"  →  "yellowBoard"
    const parts = id.split(/[-_]/);
    return parts[parts.length - 1] || id;
}

function reportHuman(agg) {
    const { byDate, byProject, total } = agg;
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const todayB = byDate.get(today) || emptyBucket();
    const monthB = emptyBucket();
    for (const [d, u] of byDate) if (d.startsWith(month)) addInto(monthB, u);

    const out = [];
    out.push("Claude Code · Token Usage");
    out.push("─".repeat(56));

    out.push("");
    out.push(`Hoje   (${today})   ${fmtTokens(sum(todayB)).padStart(8)}   ${fmtCost(todayB).padStart(7)}   ${todayB.messages} msgs`);
    out.push(`Mês    (${month})      ${fmtTokens(sum(monthB)).padStart(8)}   ${fmtCost(monthB).padStart(7)}   ${monthB.messages} msgs`);
    out.push(`Total                ${fmtTokens(sum(total)).padStart(8)}   ${fmtCost(total).padStart(7)}   ${total.messages} msgs`);

    out.push("");
    out.push("Últimos 14 dias");
    out.push("─".repeat(56));
    const sortedDates = [...byDate.keys()].filter(d => d !== "unknown").sort();
    const last14 = sortedDates.slice(-14);
    const maxDaily = Math.max(...last14.map(d => sum(byDate.get(d))), 1);
    for (const d of last14) {
        const u = byDate.get(d);
        out.push(`${d}  ${bar(sum(u), maxDaily)}  ${fmtTokens(sum(u)).padStart(7)}`);
    }

    out.push("");
    out.push("Top projetos");
    out.push("─".repeat(56));
    const projects = [...byProject.entries()]
        .sort((a, b) => sum(b[1]) - sum(a[1]))
        .slice(0, 8);
    for (const [proj, u] of projects) {
        out.push(`  ${projectShortName(proj).padEnd(28)}  ${fmtTokens(sum(u)).padStart(8)}   ${fmtCost(u).padStart(7)}`);
    }

    return out.join("\n");
}

function reportToday(agg) {
    const today  = new Date().toISOString().slice(0, 10);
    const todayB = agg.byDate.get(today) || emptyBucket();
    return `${fmtTokens(sum(todayB))} tok hoje · ${fmtCost(todayB)}`;
}

function reportJson(agg) {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const todayB = agg.byDate.get(today) || emptyBucket();
    const monthB = emptyBucket();
    for (const [d, u] of agg.byDate) if (d.startsWith(month)) addInto(monthB, u);

    return JSON.stringify({
        today:   { ...todayB, total: sum(todayB), cost: fmtCost(todayB) },
        month:   { ...monthB, total: sum(monthB), cost: fmtCost(monthB) },
        all:     { ...agg.total, total: sum(agg.total), cost: fmtCost(agg.total) },
        byDate:  Object.fromEntries(agg.byDate),
    }, null, 2);
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// HTTP server (for the ESP32 YellowBoard to poll)
// ──────────────────────────────────────────────────────────────────────────

// Default soft caps for the dashboard percentages — based on Claude Max plan
// heavy-usage estimates. The user never has to type these; if they want
// different thresholds they can set CLAUDE_LIMIT_5H / CLAUDE_LIMIT_WEEK env
// vars. The firmware just renders whatever percentage the plugin computes.
const LIMIT_5H   = parseInt(process.env.CLAUDE_LIMIT_5H   || "", 10) || 500_000_000;    // 500M tokens / 5h
const LIMIT_WEEK = parseInt(process.env.CLAUDE_LIMIT_WEEK || "", 10) || 3_000_000_000;  // 3B tokens / week

// Reset-time calculators (returns seconds until the rolling window slides out)
function secondsUntilNext5hBoundary() {
    // 5h windows reset on the hour boundary at the next multiple of 5 hours
    // (UTC). Simpler model: time-since-oldest-event-in-window. We just use a
    // sliding 5-hour reset estimate based on "now" — good enough for the UI.
    return 5 * 3600;  // always show "reinicia em 5h" — the rolling window has no hard reset
}
function secondsUntilEndOfWeek() {
    const now = new Date();
    // Week reset Monday 00:00 UTC
    const day = now.getUTCDay(); // 0 = Sunday
    const daysToMon = (day === 0 ? 1 : 8 - day);
    const next = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMon, 0, 0, 0));
    return Math.floor((next - now) / 1000);
}

// Walks raw JSONL events (instead of pre-aggregated date buckets) so we can
// compute true rolling windows like "last 5 hours" rather than "today".
function rollingBuckets() {
    const now = Date.now();
    const fiveHoursAgo  = now - 5 * 3600 * 1000;
    const sevenDaysAgo  = now - 7 * 86400 * 1000;
    const last5h = emptyBucket();
    const week   = emptyBucket();

    for (const { file } of iterSessionFiles()) {
        let content;
        try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
        for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            const usage = obj?.message?.usage;
            if (!usage || !obj.timestamp) continue;
            const t = Date.parse(obj.timestamp);
            if (isNaN(t)) continue;

            const entry = {
                input:       usage.input_tokens                || 0,
                output:      usage.output_tokens               || 0,
                cacheRead:   usage.cache_read_input_tokens     || 0,
                cacheCreate: usage.cache_creation_input_tokens || 0,
                messages:    1,
            };
            if (t >= fiveHoursAgo) addInto(last5h, entry);
            if (t >= sevenDaysAgo) addInto(week,   entry);
        }
    }
    return { last5h, week };
}

async function serveJson() {
    const today  = new Date().toISOString().slice(0, 10);
    const month  = today.slice(0, 7);
    const agg    = aggregate();
    const todayB = agg.byDate.get(today) || emptyBucket();
    const monthB = emptyBucket();
    for (const [d, u] of agg.byDate) if (d.startsWith(month)) addInto(monthB, u);

    const { last5h, week } = rollingBuckets();
    const fivehTokens = sum(last5h);
    const weekTokens  = sum(week);
    const pct = (used, lim) => lim > 0 ? Math.min(100, used / lim * 100) : 0;

    // Real plan limits from Anthropic's unified rate-limit headers (matches
    // exactly what Claude Code's internal /usage panel shows). Cached 60s.
    const plan = await getPlanLimits();
    const planFiveh =  plan?.fiveh?.utilization != null ? plan.fiveh.utilization * 100 : null;
    const planWeek  =  plan?.week?.utilization  != null ? plan.week.utilization  * 100 : null;
    const nowSec = Math.floor(Date.now() / 1000);

    return {
        // ─── Obsidian-style buckets — using REAL plan utilization from API ─
        fiveh: {
            // Anthropic-supplied numbers (authoritative, model-weighted)
            percent:     planFiveh != null ? +planFiveh.toFixed(1) : +pct(fivehTokens, LIMIT_5H).toFixed(1),
            secondsLeft: plan?.fiveh?.resetEpoch ? Math.max(0, plan.fiveh.resetEpoch - nowSec) : secondsUntilNext5hBoundary(),
            status:      plan?.fiveh?.status || null,
            // Local-derived (machine activity only — for reference)
            tokens:      fivehTokens,
            cost_usd:    Number(fmtCost(last5h).slice(1)),
            messages:    last5h.messages,
        },
        week: {
            percent:     planWeek != null ? +planWeek.toFixed(1) : +pct(weekTokens, LIMIT_WEEK).toFixed(1),
            secondsLeft: plan?.week?.resetEpoch ? Math.max(0, plan.week.resetEpoch - nowSec) : secondsUntilEndOfWeek(),
            status:      plan?.week?.status || null,
            tokens:      weekTokens,
            cost_usd:    Number(fmtCost(week).slice(1)),
            messages:    week.messages,
        },
        plan: plan ? {
            fallback_percentage: plan.fallback?.percentage,
            fallback_status:     plan.fallback?.status,
            overage_status:      plan.overage?.status,
            representative:      plan.representativeClaim,
            sampled_at:          plan.sampledAt,
        } : null,
        // ─── Legacy buckets (kept for backwards compat with older firmware) ──
        today: {
            tokens:      sum(todayB),
            input:       todayB.input,
            output:      todayB.output,
            cacheRead:   todayB.cacheRead,
            cacheCreate: todayB.cacheCreate,
            messages:    todayB.messages,
            cost_usd:    Number(fmtCost(todayB).slice(1)),
        },
        month: {
            tokens:      sum(monthB),
            cost_usd:    Number(fmtCost(monthB).slice(1)),
        },
        all: {
            tokens:      sum(agg.total),
            cost_usd:    Number(fmtCost(agg.total).slice(1)),
        },
        timestamp: new Date().toISOString(),
    };
}

// ──────────────────────────────────────────────────────────────────────────
// --publish: commit data/usage.json and push, so a remote board can fetch
// the snapshot from GitHub raw without depending on the host machine.
//
// Designed to run from a scheduled task (e.g. every 5 minutes). Idempotent
// per content: if usage.json didn't change, the git commit fails (no diff)
// and we just skip. Uses a dedicated `data` branch so main stays clean.
// ──────────────────────────────────────────────────────────────────────────

async function publish(branch) {
    const { execSync } = require("child_process");
    const repoRoot = path.resolve(__dirname, "..");
    const json     = JSON.stringify(await serveJson(), null, 2);

    const sh = (cmd, opts = {}) =>
        execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], ...opts })
            .toString().trim();

    // 1. Worktree on the data branch (avoids switching the user's current branch).
    //    Reuses the user's git auth — no PAT needed.
    const wt = path.join(os.tmpdir(), "claude-token-monitor-data-wt");
    if (fs.existsSync(wt)) {
        try { sh(`git worktree remove --force "${wt}"`); } catch {}
        if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
    }

    try {
        sh(`git fetch origin ${branch}`);
        sh(`git worktree add "${wt}" origin/${branch}`);
        sh(`git -C "${wt}" checkout -B ${branch}`);
    } catch {
        // Branch doesn't exist yet — create as orphan
        sh(`git worktree add --detach "${wt}" HEAD`);
        sh(`git -C "${wt}" checkout --orphan ${branch}`);
        try { sh(`git -C "${wt}" rm -rf .`); } catch {}
    }

    // 2. Write the snapshot
    fs.writeFileSync(path.join(wt, "usage.json"), json);

    // 3. Commit only if content changed; push the new commit
    try {
        sh(`git -C "${wt}" add usage.json`);
        sh(`git -C "${wt}" -c user.email=bot@claude-token-monitor -c user.name=token-monitor commit -m "data: snapshot ${new Date().toISOString()}"`);
        sh(`git -C "${wt}" push origin ${branch}`);
        console.log(`[publish] pushed snapshot to origin/${branch}`);
    } catch (e) {
        console.log(`[publish] no changes since last snapshot — skipped`);
    }

    // 4. Clean up worktree
    try { sh(`git worktree remove --force "${wt}"`); } catch {}
}

function serve(port) {
    const http = require("http");
    const server = http.createServer(async (req, res) => {
        if (req.method === "GET" && (req.url === "/usage" || req.url === "/usage/")) {
            try {
                const payload = JSON.stringify(await serveJson());
                res.writeHead(200, {
                    "Content-Type":                "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control":               "no-store",
                });
                res.end(payload);
            } catch (e) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("error: " + e.message);
            }
        } else if (req.url === "/health" || req.url === "/") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("claude-token-monitor OK\n");
        } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
        }
    });
    server.listen(port, "0.0.0.0", () => {
        console.log(`[claude-token-monitor] listening on http://0.0.0.0:${port}/usage`);
    });
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);

    const serveIdx = args.indexOf("--serve");
    if (serveIdx >= 0) {
        const port = parseInt(args[serveIdx + 1], 10) || 9876;
        return serve(port);
    }

    const pubIdx = args.indexOf("--publish");
    if (pubIdx >= 0) {
        const branch = args[pubIdx + 1] && !args[pubIdx + 1].startsWith("--")
            ? args[pubIdx + 1] : "data";
        return publish(branch);
    }

    const agg = aggregate();
    if (args.includes("--json"))  return console.log(reportJson(agg));
    if (args.includes("--today")) return console.log(reportToday(agg));
    console.log(reportHuman(agg));
}

main();
