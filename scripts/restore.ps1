# NFR-16: restores a backup into a NEW database, so a mistake can never overwrite live data.
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/restore.ps1 backups/apartment-2026-11-07.dump -Target apartment_restored
# Then point DATABASE_URL at the new database and copy the matching uploads-YYYY-MM-DD folder to UPLOAD_DIR.
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Dump,
  [string]$Target = 'apartment_restored',
  [string]$DatabaseUrl = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($Target -notmatch '^[a-z_][a-z0-9_]*$') { throw 'The target name may use only lower-case letters, digits and underscores.' }
if (-not (Test-Path $Dump)) { throw "Backup not found: $Dump" }

if (-not $DatabaseUrl) {
  $line = Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  $DatabaseUrl = ($line -replace '^DATABASE_URL=', '').Trim('"', ' ')
}
$DatabaseUrl = $DatabaseUrl -replace '\?.*$', ''

$bin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter pg_restore.exe -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty DirectoryName
if (-not $bin) { throw 'pg_restore.exe not found. Is PostgreSQL installed?' }
$psql = Join-Path $bin 'psql.exe'
$pgRestore = Join-Path $bin 'pg_restore.exe'

$exists = & $psql --dbname=$DatabaseUrl -tAc "SELECT 1 FROM pg_database WHERE datname = '$Target'"
if ($exists -eq '1') { throw "Database '$Target' already exists. Choose a new name: this script never overwrites." }

& $psql --dbname=$DatabaseUrl -c "CREATE DATABASE $Target" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create database '$Target'." }

$targetUrl = $DatabaseUrl -replace '/[^/]+$', "/$Target"
& $pgRestore --no-owner --exit-on-error --dbname=$targetUrl $Dump
if ($LASTEXITCODE -ne 0) { throw "Restore failed. Database '$Target' is incomplete: drop it before trying again." }

Write-Host "Restored into '$Target'."
Write-Host "To use it: set DATABASE_URL to $($targetUrl -replace '//[^@]*@', '//...@') and copy the matching uploads folder."
