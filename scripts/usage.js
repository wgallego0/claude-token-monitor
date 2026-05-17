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

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

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

function serveJson() {
    const today  = new Date().toISOString().slice(0, 10);
    const month  = today.slice(0, 7);
    const agg    = aggregate();
    const todayB = agg.byDate.get(today) || emptyBucket();
    const monthB = emptyBucket();
    for (const [d, u] of agg.byDate) if (d.startsWith(month)) addInto(monthB, u);

    return {
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
            input:       monthB.input,
            output:      monthB.output,
            cacheRead:   monthB.cacheRead,
            cacheCreate: monthB.cacheCreate,
            messages:    monthB.messages,
            cost_usd:    Number(fmtCost(monthB).slice(1)),
        },
        all: {
            tokens:      sum(agg.total),
            cost_usd:    Number(fmtCost(agg.total).slice(1)),
        },
        timestamp: new Date().toISOString(),
    };
}

function serve(port) {
    const http = require("http");
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && (req.url === "/usage" || req.url === "/usage/")) {
            const payload = JSON.stringify(serveJson());
            res.writeHead(200, {
                "Content-Type":                "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control":               "no-store",
            });
            res.end(payload);
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

    const agg = aggregate();
    if (args.includes("--json"))  return console.log(reportJson(agg));
    if (args.includes("--today")) return console.log(reportToday(agg));
    console.log(reportHuman(agg));
}

main();
