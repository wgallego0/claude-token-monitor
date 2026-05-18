# publish-via-api.ps1
# Generates usage JSON locally and triggers the GitHub Actions workflow.
# Schedule this with Task Scheduler every 5 minutes as a replacement for publish.bat.
#
# Requires: PUBLISH_PAT environment variable (or hardcode below)

param(
  [string]$Pat = $env:PUBLISH_PAT
)

if (-not $Pat) {
  Write-Error "Set PUBLISH_PAT env var or pass -Pat <token>"
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

# Generate JSON from local JSONL files + Anthropic probe
$json = node "$RepoRoot\scripts\usage.js" --json 2>$null
if (-not $json) { Write-Warning "usage.js returned empty output"; exit 0 }

# Trigger GitHub Actions workflow_dispatch with the payload
$body = @{
  ref    = "main"
  inputs = @{ payload = $json }
} | ConvertTo-Json -Depth 5

$headers = @{
  Authorization         = "Bearer $Pat"
  Accept                = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$uri = "https://api.github.com/repos/wgallego0/claude-token-monitor/actions/workflows/publish-usage.yml/dispatches"

try {
  Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body -ContentType "application/json"
  Write-Host "[publish] workflow triggered at $(Get-Date -Format u)"
} catch {
  Write-Error "[publish] workflow trigger failed: $_"
}
