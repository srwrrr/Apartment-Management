# One-time local database setup. Creates the 'apt' user and 'apartment' database.
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts/setup-db.ps1
# You will be asked for the 'postgres' password you chose when installing PostgreSQL.

$ErrorActionPreference = 'Stop'

$psql = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $psql) { throw 'psql.exe not found. Is PostgreSQL installed?' }

$secure = Read-Host 'postgres password' -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

try {
  $exists = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_roles WHERE rolname='apt'"
  if ($exists -ne '1') {
    & $psql -U postgres -h localhost -c "CREATE USER apt WITH PASSWORD 'apt' CREATEDB;"
  } else { Write-Host "user 'apt' already exists" }

  $db = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='apartment'"
  if ($db -ne '1') {
    & $psql -U postgres -h localhost -c "CREATE DATABASE apartment OWNER apt;"
  } else { Write-Host "database 'apartment' already exists" }

  Write-Host 'Done. DATABASE_URL=postgresql://apt:apt@localhost:5432/apartment'
}
finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
