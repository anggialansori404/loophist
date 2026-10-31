# Autostart daemon tiap logon via Task Scheduler (user saat ini, tanpa admin).
param([switch]$Uninstall)
$task = "LoopHistDaemon"
if ($Uninstall) { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue; Write-Output "REMOVED: $task"; exit 0 }
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root "bin\loophist-daemon.exe"
if (-not (Test-Path $exe)) { Write-Output "MISSING binary, build dulu via daemon."; exit 1 }
$act = New-ScheduledTaskAction -Execute $exe -Argument "-addr 127.0.0.1:8765" -WorkingDirectory (Join-Path $root "bin")
$trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $act -Trigger $trg -Settings $set -Force | Out-Null
Start-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Write-Output "INSTALLED: LoopHistDaemon, jalan tiap logon."
Write-Output "Hapus via: uninstall.ps1 atau install-autostart.ps1 -Uninstall"
