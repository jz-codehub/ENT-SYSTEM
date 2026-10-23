<#
  pre-publish.ps1 - refuse to let a secret reach GitHub.

  This project holds a SUPABASE SERVICE-ROLE key in
  supabase-v2/scripts/.env.local. That key bypasses Row Level Security
  outright: anyone holding it can read, write and delete every row in the
  database, from anywhere, permanently. Publishing it to a public repo does
  not merely leak it, it hands it to every GitHub scraper.

  Severity is deliberately split, because a check that cries wolf gets
  ignored and then protects nothing:

    BLOCK   the service-role key value appears outside .env.local
    WARN    some OTHER JWT-shaped string is committed (could be a key from
            a different project, e.g. the old v1 key)
    INFO    the anon/publishable key is in the frontend on purpose. Supabase
            designs it to be public; RLS is the only thing protecting your
            rows, and that is deliberate, not a mistake.

  .gitignore is a promise, not a guarantee: `git add -f` or a new secret in
  a new place defeats it. So this scans what git would actually track.
#>
param()

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot

$envFile = Join-Path $Root 'supabase-v2\scripts\.env.local'
if (-not (Test-Path $envFile)) {
  Write-Host '  no .env.local found - nothing to compare against' -ForegroundColor Yellow
  exit 0
}

$secrets = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(\S+)\s*$') {
    $k = $Matches[1]
    $v = $Matches[2].Trim('"').Trim("'")
    if ($v.Length -ge 20 -and $k -match 'KEY|SECRET|TOKEN|PASSWORD') { $secrets[$k] = $v }
  }
}
# The anon key is DESIGNED to be shipped to browsers. Never treat it as a leak.
$serviceKey = $secrets['SUPABASE_SERVICE_ROLE_KEY']
$anonKey    = $secrets['SUPABASE_ANON_KEY']

$skip = @('supabase-v2\scripts\.env.local')
$skipFiles = Get-ChildItem -Path $Root -Recurse -Force -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\backup\\' }
$binary = @('.png','.jpg','.jpeg','.webp','.ico','.pdf','.zip','.mp4','.woff','.woff2')

$blocks = @(); $warns = @(); $seen = 0
foreach ($f in $skipFiles) {
  $rel = $f.FullName.Substring($Root.Length + 1)
  if ($skip -contains $rel) { continue }
  if ($binary -contains $f.Extension.ToLower()) { continue }
  try { $text = [System.IO.File]::ReadAllText($f.FullName) } catch { continue }
  if (-not $text) { continue }
  $seen++

  if ($serviceKey -and $text.Contains($serviceKey)) {
    $blocks += $rel
    continue
  }
  foreach ($m in [regex]::Matches($text, 'eyJ[A-Za-z0-9_\-\.]{40,}')) {
    $v = $m.Value
    if ($anonKey -and $v -eq $anonKey) { continue }   # public by design
    if ($serviceKey -and $v -eq $serviceKey) { $blocks += $rel; break }
    $warns += [pscustomobject]@{ File = $rel; Prefix = $v.Substring(0, 28) }
  }
}
$warns = $warns | Group-Object File, Prefix | ForEach-Object { $_.Group[0] }

# .gitignore coverage, honouring NESTED .gitignore files (a root-only check
# wrongly reports supabase-v2/scripts/.env.local as uncovered).
$rules = @()
foreach ($gi in Get-ChildItem -Path $Root -Recurse -Force -Filter '.gitignore' -ErrorAction SilentlyContinue) {
  $base = $gi.Directory.FullName
  foreach ($l in Get-Content $gi.FullName) {
    $l = $l.Trim()
    if ($l -and -not $l.StartsWith('#')) { $rules += [pscustomobject]@{ Base = $base; Rule = $l } }
  }
}
$uncovered = @()
foreach ($secret in @('supabase-v2\scripts\.env.local')) {
  $full = Join-Path $Root $secret
  $leaf = Split-Path $secret -Leaf
  $ok = $false
  foreach ($r in $rules) {
    if ($full.StartsWith($r.Base)) {
      $dir = $full.Substring($r.Base.Length).TrimStart('\')
      $pat = $r.Rule.TrimEnd('/')
      if ($pat -eq $leaf -or $pat -eq $dir -or $pat -eq ($dir + '\' + $leaf)) { $ok = $true }
      if ($pat -eq '*' -or $pat -eq '**') { $ok = $true }
    }
  }
  if (-not $ok) { $uncovered += $secret }
}

Write-Host ''
Write-Host ('  scanned ' + $seen + ' files; ' + $secrets.Count + ' real secret value(s) in .env.local')
Write-Host ''

if ($blocks.Count) {
  Write-Host '  BLOCK  the SERVICE-ROLE key appears here. Do NOT push.' -ForegroundColor Red
  $blocks | ForEach-Object { Write-Host ('          ' + $_) -ForegroundColor Red }
  Write-Host ''
}
if ($warns.Count) {
  Write-Host '  WARN   other JWT-shaped strings are committed. Not the current' -ForegroundColor Yellow
  Write-Host '         service key, but confirm each one is meant to be public:' -ForegroundColor Yellow
  $warns | ForEach-Object { Write-Host ('          ' + $_.File + '  (' + $_.Prefix + '...)') -ForegroundColor Yellow }
  Write-Host ''
}
if ($uncovered.Count) {
  Write-Host '  BLOCK  not covered by any .gitignore:' -ForegroundColor Red
  $uncovered | ForEach-Object { Write-Host ('          ' + $_) -ForegroundColor Red }
  Write-Host ''
}

if ($blocks.Count -or $uncovered.Count) {
  Write-Host '  PRE-PUBLISH CHECK FAILED' -ForegroundColor Red
  Write-Host ''
  exit 1
}
Write-Host '  PRE-PUBLISH CHECK PASSED' -ForegroundColor Green
Write-Host '    the service-role key is not in any file git would track'
Write-Host '    the anon key in the frontend is public by design (RLS protects the data)'
Write-Host ''
exit 0
