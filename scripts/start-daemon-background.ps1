# Jalankan daemon di latar belakang (hidden), idempoten.
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root "bin\loophist-daemon.exe"
if (-not (Test-Path $exe)) { Write-Output "MISSING binary, build dulu via daemon."; exit 1 }
try {
  $h = Invoke-RestMethod http://127.0.0.1:8765/health -TimeoutSec 2
  if ($h.status -eq "ok") { Write-Output "RUNNING: daemon sudah jalan."; exit 0 }
} catch {}
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "daemon.log"
# Rotasi: tiap start, bila >5MB simpan 7 arsip terakhir (daemon-yyyymmdd-HHMMSS.log), hapus sisa.
$maxBytes = 5MB
if ((Test-Path $log) -and ((Get-Item $log).Length -gt $maxBytes)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Move-Item $log (Join-Path $logDir "daemon-$stamp.log") -Force
  Get-ChildItem $logDir -Filter "daemon-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 7 | Remove-Item -Force
}
# Append stdout+stderr via cmd (Start-Process -Redirect* overwrite, jadi tak dipakai).
Start-Process -FilePath "$env:ComSpec" -ArgumentList "/c `"`"$exe`" -addr 127.0.0.1:8765 >> `"$log`" 2>&1`" " -WindowStyle Hidden
Start-Sleep -Seconds 2
try {
  $h = Invoke-RestMethod http://127.0.0.1:8765/health -TimeoutSec 2
  Write-Output ("STARTED: " + $h.status + " " + $h.service)
} catch { Write-Output "FAIL: daemon tidak menjawab health."; exit 1 }
