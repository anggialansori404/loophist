# Hentikan daemon + hapus autostart. Idempoten: aman jalan ulang.
$task = "LoopHistDaemon"
& (Join-Path $PSScriptRoot "stop-daemon.ps1")
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "AUTOSTART: $task dihapus (bila ada)."
