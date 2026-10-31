# Hentikan daemon. Idempoten: aman jalan ulang.
$p = Get-Process loophist-daemon -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "NOT RUNNING: daemon tidak jalan."; exit 0 }
Stop-Process -Name loophist-daemon -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if (Get-Process loophist-daemon -ErrorAction SilentlyContinue) {
  Write-Output "WARN: proses masih jalan, tutup manual via Task Manager."
  exit 1
}
Write-Output "STOPPED: daemon mati."
