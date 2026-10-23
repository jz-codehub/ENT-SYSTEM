<#
  dev.ps1 - one command to run and test this app locally.

    .\dev.ps1            start the server, check it, open the browser
    .\dev.ps1 -Check     just report status, change nothing
    .\dev.ps1 -Stop      stop the server
    .\dev.ps1 -Copy      copy the Edge Function bundle to the clipboard

  WHY A SERVER IS REQUIRED
  Opening login.html by double-clicking serves the page as file://. A
  browser sends "Origin: null" for such a page, which can never match the
  Edge Function's origin allowlist, so every call is discarded and the page
  shows only "Failed to fetch". Serving the same folder over http:// gives
  the page a real origin, which is what the allowlist expects.
#>
param(
  [switch]$Check,
  [switch]$Stop,
  [switch]$Copy,
  [switch]$Wait
)

$ErrorActionPreference = 'Continue'
# Invoke-WebRequest renders a progress bar that buries the actual report.
$ProgressPreference = 'SilentlyContinue'
$Root    = $PSScriptRoot
$Scripts = Join-Path $Root 'supabase-v2\scripts'
$Bundle  = Join-Path $Root 'supabase-v2\dist\auth-admin.bundle.ts'
$Port    = 5500
$Origin  = "http://localhost:$Port"
$Log     = Join-Path $Root 'dev-server.log'

function Say($msg) { Write-Host $msg }
function Ok($msg)  { Write-Host "  OK    $msg" -ForegroundColor Green }
function No($msg)  { Write-Host "  BLOCK $msg" -ForegroundColor Red }
function Warn($msg){ Write-Host "  WARN  $msg" -ForegroundColor Yellow }

function Get-Server {
  try {
    $r = Invoke-WebRequest -Uri "$Origin/" -TimeoutSec 3 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Stop-Server {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*serve.mjs*' }
  if (-not $procs) { Say '  no dev server is running.'; return }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $n = @($procs).Count
  Say "  stopped $n dev server process(es)."
}

if ($Stop) { Stop-Server; return }
if ($Copy) {
  if (-not (Test-Path $Bundle)) { No "bundle not found: $Bundle"; return }
  $text = [System.IO.File]::ReadAllText($Bundle)
  Set-Clipboard -Value $text
  $kb = [math]::Round((Get-Item $Bundle).Length / 1kb, 1)
  Ok "copied auth-admin.bundle.ts to the clipboard ($kb kb)"
  return
}

Say ''
Say '  ENT Records v2 - local development'
Say '  ================================'
Say ''

# ---------------------------------------------------------------- 1. node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { No 'Node.js is not on PATH. Install Node 18+ and reopen PowerShell.'; return }
Ok "node $(node --version)"

# ------------------------------------------------------------- 2. server
if (Get-Server) {
  Ok "server already up at $Origin"
} elseif ($Check) {
  No "server is DOWN. Start it with: .\dev.ps1"
} else {
  Start-Process -FilePath 'node' -ArgumentList 'serve.mjs' `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
  $up = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 300
    if (Get-Server) { $up = $true; break }
  }
  if ($up) { Ok "server started at $Origin" }
  else { No "server did not come up - see $Log"; return }
}

# --------------------------------------------------- 3. edge function
Say ''

$fnUp = $false; $fnCode = ''
try {
  $s = & node (Join-Path $Scripts 'probe_preflight.mjs') 2>&1 | Out-String
  if ($s -match 'HTTP 204' -and $s -match 'ACAO\s*:\s*http') { $fnUp = $true }
  $fnCode = if ($s -match 'HTTP (\d+)') { $Matches[1] } else { '?' }
} catch { $fnCode = 'ERR' }

if ($fnUp) {
  Ok "auth-admin preflight returns 204 with the right origin"
} else {
  No "auth-admin preflight is HTTP $fnCode - the browser cannot call it yet"
}

# -Wait: poll until the deploy lands, so there is never a question of "did it
# work yet?". Run it, paste the bundle in the browser meanwhile, and it
# reports the moment the admin console becomes usable.
if ($Wait -and -not $fnUp) {
  Say ''
  Say '  Waiting for the deploy. Paste the bundle in the browser meanwhile.'
  Say '  Ctrl+C stops waiting.'
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    try {
      $s2 = & node (Join-Path $Scripts 'probe_preflight.mjs') 2>&1 | Out-String
      if ($s2 -match 'HTTP 204' -and $s2 -match 'ACAO\s*:\s*http') { $fnUp = $true; break }
    } catch { }
    if ($i % 15 -eq 14) { Say ('    still waiting, ' + (($i + 1) * 2) + 's elapsed') }
  }
}

# ----------------------------------------------------------- 4. verdict
Say ''
if ($fnUp) {
  Ok ('READY. Open: ' + "$Origin/")
  Say ''
  Say '  Sign in as testadmin, then Admin -> Users -> Add user.'
  Say ''
  Start-Process "$Origin/"
} else {
  Say '  ONE STEP LEFT - deploy the Edge Function. Nothing else fixes it:'
  Say '  the same crash blocks a real browser, a GitHub Pages deploy, and'
  Say '  every other machine. It is one paste.'
  Say ''
  Say '  1. Run:  .\dev.ps1 -Copy     (copies the bundle to your clipboard)'
  Say '  2. Supabase dashboard -> Edge Functions -> auth-admin -> Edit'
  Say ('  3. Ctrl+A, Delete.  Ctrl+V.  (file: ' + $Bundle + ')')
  Say '  4. Deploy.   Keep "Verify JWT" OFF.'
  Say '  5. Repeat for patient-photos (it shares the same preflight bug).'
  Say ''
  Say '  Then run .\dev.ps1 -Wait - it confirms the moment it goes live.'
  Say ''
  Say ('  Or just: ' + "$Origin/")
}
Say ''
