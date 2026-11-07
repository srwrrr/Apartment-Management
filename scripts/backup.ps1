# NFR-15: one backup of the database and the uploaded files, keeping the last 7 days.
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
# Schedule it daily with Windows Task Scheduler (see docs/backup-and-restore.md).
param(
  [string]$DatabaseUrl = '',
  [string]$BackupDir = 'backups',
  [string]$UploadDir = '',
  [int]$KeepDays = 7
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Read-Env([string]$name) {
  $file = Join-Path $root '.env'
  if (-not (Test-Path $file)) { return '' }
  $line = Get-Content $file | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$name=", '').Trim('"', ' ') }
  return ''
}

if (-not $DatabaseUrl) { $DatabaseUrl = Read-Env 'DATABASE_URL' }
if (-not $DatabaseUrl) { throw 'DATABASE_URL not found. Set it in .env or pass -DatabaseUrl.' }
$DatabaseUrl = $DatabaseUrl -replace '\?.*$', ''   # pg_dump does not understand Prisma's extra options

$pgDump = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter pg_dump.exe -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $pgDump) { throw 'pg_dump.exe not found. Is PostgreSQL installed?' }

if (-not [IO.Path]::IsPathRooted($BackupDir)) { $BackupDir = Join-Path $root $BackupDir }
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd'
$dump = Join-Path $BackupDir "apartment-$stamp.dump"

& $pgDump -Fc --no-owner --dbname=$DatabaseUrl -f $dump
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed. No backup was made.' }
if ((Get-Item $dump).Length -eq 0) { throw 'The backup file is empty.' }

# The photos and receipts belong with the database that points at them.
if (-not $UploadDir) { $UploadDir = Read-Env 'UPLOAD_DIR' }
if (-not $UploadDir) { $UploadDir = './uploads' }
if (-not [IO.Path]::IsPathRooted($UploadDir)) { $UploadDir = Join-Path (Join-Path $root 'server') $UploadDir }
$files = Join-Path $BackupDir "uploads-$stamp"
if (Test-Path $UploadDir) {
  if (Test-Path $files) { Remove-Item -Recurse -Force $files }
  Copy-Item -Recurse $UploadDir $files
}

# Only after a good backup: remove what is older than the days we keep.
$cutoff = (Get-Date).AddDays(-$KeepDays)
Get-ChildItem $BackupDir | Where-Object { $_.Name -match '^(apartment-.*\.dump|uploads-.*)$' -and $_.LastWriteTime -lt $cutoff } |
  ForEach-Object { Remove-Item -Recurse -Force $_.FullName }

Write-Host "Backup done: $dump ($([math]::Round((Get-Item $dump).Length / 1KB)) KB)"
