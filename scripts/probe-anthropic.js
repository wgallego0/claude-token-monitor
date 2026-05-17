#!/usr/bin/env node
/**
 * Probes Anthropic OAuth endpoints to find which one returns plan usage
 * (5h rolling, weekly limits) that match what Claude Code's internal
 * /usage panel displays. Uses the user's existing access token from
 * ~/.claude/.credentials.json — same auth Claude Code itself uses.
 *
 * Token never appears on the command line or in process args.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const https = require("https");

const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
const token = creds.claudeAiOauth.accessToken;

function probe(host, urlPath) {
    return new Promise((resolve) => {
        const req = https.request({
            host, port: 443, path: urlPath, method: "GET",
            headers: {
                "Authorization":       `Bearer ${token}`,
                "anthropic-version":   "2023-06-01",
                "anthropic-beta":      "oauth-2025-04-20",
                "User-Agent":          "claude-cli/2.1.143 (probe)",
                "Accept":              "application/json",
            },
            timeout: 8000,
        }, (res) => {
            let body = "";
            res.on("data", c => body += c);
            res.on("end", () => resolve({
                url: `https://${host}${urlPath}`,
                status: res.statusCode,
                body: body.slice(0, 500),
            }));
        });
        req.on("error", e => resolve({ url: `https://${host}${urlPath}`, error: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ url: `https://${host}${urlPath}`, error: "timeout" }); });
        req.end();
    });
}

function probeHeaders(host, urlPath, method = "GET", body = null) {
    return new Promise((resolve) => {
        const req = https.request({
            host, port: 443, path: urlPath, method,
            headers: {
                "Authorization":       `Bearer ${token}`,
                "anthropic-version":   "2023-06-01",
                "anthropic-beta":      "oauth-2025-04-20",
                "User-Agent":          "claude-cli/2.1.143 (probe)",
                "Accept":              "application/json",
                "Content-Type":        "application/json",
            },
            timeout: 15000,
        }, (res) => {
            let buf = "";
            res.on("data", c => buf += c);
            res.on("end", () => resolve({
                url: `https://${host}${urlPath}`,
                status: res.statusCode,
                headers: res.headers,
                body: buf.slice(0, 800),
            }));
        });
        req.on("error", e => resolve({ url: `https://${host}${urlPath}`, error: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ url: `https://${host}${urlPath}`, error: "timeout" }); });
        if (body) req.write(body);
        req.end();
    });
}

(async () => {
    console.log("──── 1) profile ────");
    const profile = await probeHeaders("api.anthropic.com", "/api/oauth/profile");
    console.log("HTTP", profile.status);
    let orgUuid = null, accountUuid = null;
    try {
        const j = JSON.parse(profile.body);
        accountUuid = j.account?.uuid;
        orgUuid     = j.organization?.uuid;
        console.log("account uuid:", accountUuid);
        console.log("org uuid:    ", orgUuid);
        console.log("subscription:", j.organization?.organization_type || "—");
        console.log("body keys:   ", Object.keys(j));
    } catch (e) { console.log("parse err:", e.message); }

    console.log("\n──── 2) candidate usage endpoints with org/account uuid ────");
    const paths = [
        ...(orgUuid ? [
            `/api/organizations/${orgUuid}/claude_code_usage`,
            `/api/organizations/${orgUuid}/usage`,
            `/api/organizations/${orgUuid}/rate_limits`,
            `/api/organizations/${orgUuid}/limits`,
            `/api/organizations/${orgUuid}/plan_usage`,
            `/v1/organizations/${orgUuid}/usage`,
        ] : []),
        ...(accountUuid ? [
            `/api/accounts/${accountUuid}/usage`,
            `/api/accounts/${accountUuid}/limits`,
        ] : []),
    ];
    for (const p of paths) {
        const r = await probeHeaders("api.anthropic.com", p);
        const m = r.status === 200 ? "✅" : (r.status === 404 ? "❌" : "  ");
        console.log(`${m} ${r.status} ${p}`);
        if (r.status === 200) console.log(`   ${r.body.replace(/\n/g, " ").slice(0, 300)}`);
    }

    console.log("\n──── 3) /v1/messages minimal call — check response headers for rate-limit info ────");
    const msgBody = JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "1" }],
    });
    const m = await probeHeaders("api.anthropic.com", "/v1/messages", "POST", msgBody);
    console.log("HTTP", m.status);
    const rlHeaders = Object.entries(m.headers || {})
        .filter(([k]) => /ratelimit|usage|quota|tier/i.test(k));
    console.log("rate-limit headers:");
    for (const [k, v] of rlHeaders) console.log(`  ${k}: ${v}`);
    if (m.status !== 200 && m.body) console.log("body:", m.body.slice(0, 200));
})();
