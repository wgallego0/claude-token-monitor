# Cria uma tarefa agendada no Windows que publica o snapshot a cada 5 minutos.
# Rode UMA vez como Administrador:
#     powershell -ExecutionPolicy Bypass -File scripts\setup-scheduler.ps1

$TaskName = "ClaudeTokenMonitorPublish"
$ScriptPath = Join-Path $PSScriptRoot "publish.bat"

if (-not (Test-Path $ScriptPath)) {
    Write-Error "publish.bat nao encontrado em $ScriptPath"
    exit 1
}

# Remove tarefa existente (se houver)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action  = New-ScheduledTaskAction -Execute $ScriptPath
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries `
              -StartWhenAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 3)

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "Publica snapshot do Claude Code usage no GitHub a cada 5 minutos" `
    -User $env:USERNAME -RunLevel Limited

Write-Host "[ok] Tarefa '$TaskName' criada — publica a cada 5 minutos"
Write-Host "[ok] Logs em: $env:TEMP\claude-token-publish.log"
Write-Host ""
Write-Host "Para desabilitar: Disable-ScheduledTask -TaskName $TaskName"
Write-Host "Para remover:     Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
