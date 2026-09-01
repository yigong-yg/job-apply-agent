[CmdletBinding()]
param(
  [switch]$DryRun,
  [int]$MaxApplications = 0,
  [switch]$Headless,
  [switch]$SkipWindowGuard,
  # Slots this invocation may run. The default keeps legacy triggers (daily
  # 18:00 + user logon) evening-only; morning/midday tasks must opt in with
  # -Slots morning / -Slots midday so a daytime logon cannot silently start
  # a production run.
  [string[]]$Slots = @('evening')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogsDir = Join-Path $RepoRoot 'logs'
$StatePath = Join-Path $LogsDir 'autorun-state.json'
$LockPath = Join-Path $LogsDir 'autorun.lock.json'
$UtcNow = [DateTime]::UtcNow
$LauncherLogPath = Join-Path $LogsDir ("launcher-{0}.log" -f $UtcNow.ToString('yyyy-MM-dd'))
$DenverTz = [TimeZoneInfo]::FindSystemTimeZoneById('Mountain Standard Time')
$UseAutorunState = -not $DryRun

if (-not (Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

function Write-LauncherLog {
  param(
    [string]$Message,
    [string]$Level = 'INFO'
  )

  $timestamp = [DateTime]::UtcNow.ToString('o')
  $line = "[{0}] [{1}] {2}" -f $timestamp, $Level.ToUpperInvariant(), $Message
  Write-Host $line
  Add-Content -Path $LauncherLogPath -Value $line -Encoding UTF8
}

function Read-AutorunState {
  if (-not (Test-Path $StatePath)) {
    return @{
      lastScheduledDateDenver = $null
      lastScheduledSlotKey = $null
      lastLaunchUtc = $null
      lastResult = $null
      lastExitCode = $null
    }
  }

  try {
    $raw = Get-Content -Path $StatePath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) {
      throw 'empty state file'
    }
    $state = $raw | ConvertFrom-Json -ErrorAction Stop
    $slotKey = $null
    if ($state.PSObject.Properties.Name -contains 'lastScheduledSlotKey') {
      $slotKey = $state.lastScheduledSlotKey
    }
    return @{
      lastScheduledDateDenver = $state.lastScheduledDateDenver
      lastScheduledSlotKey = $slotKey
      lastLaunchUtc = $state.lastLaunchUtc
      lastResult = $state.lastResult
      lastExitCode = $state.lastExitCode
    }
  } catch {
    Write-LauncherLog "Ignoring unreadable autorun state at ${StatePath}: $($_.Exception.Message)" 'WARN'
    return @{
      lastScheduledDateDenver = $null
      lastScheduledSlotKey = $null
      lastLaunchUtc = $null
      lastResult = $null
      lastExitCode = $null
    }
  }
}

function Write-AutorunState {
  param(
    [hashtable]$State
  )

  ($State | ConvertTo-Json) | Set-Content -Path $StatePath -Encoding UTF8
}

function Remove-AutorunLock {
  if (Test-Path $LockPath) {
    Remove-Item -Path $LockPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-AutorunLockFresh {
  if (-not (Test-Path $LockPath)) {
    return $false
  }

  try {
    $lock = (Get-Content -Path $LockPath -Raw -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop
    $startedUtc = [DateTime]::Parse($lock.startedUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $ageHours = ([DateTime]::UtcNow - $startedUtc).TotalHours
    if ($ageHours -lt 6) {
      return $true
    }
    Write-LauncherLog "Removing stale autorun lock older than 6 hours ($([math]::Round($ageHours, 2))h)." 'WARN'
  } catch {
    Write-LauncherLog "Removing unreadable autorun lock at ${LockPath}: $($_.Exception.Message)" 'WARN'
  }

  Remove-AutorunLock
  return $false
}

$denverNow = [TimeZoneInfo]::ConvertTimeFromUtc($UtcNow, $DenverTz)
$scheduledDateDenver = $denverNow.ToString('yyyy-MM-dd')
# Daily-quota slots: each slot may produce one successful run per Denver day,
# so extra Task Scheduler triggers (morning/midday) add scans of the rolling
# 24h posting window instead of being deduplicated against the evening run.
$slotName = if ($denverNow.Hour -lt 12) { 'morning' } elseif ($denverNow.Hour -lt 18) { 'midday' } else { 'evening' }
$scheduledSlotKey = "{0}#{1}" -f $scheduledDateDenver, $slotName
$principalUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-LauncherLog ("Launcher invoked by {0}; utcNow={1}; denverNow={2}; slot={3}" -f $principalUser, $UtcNow.ToString('o'), $denverNow.ToString('yyyy-MM-ddTHH:mm:ssK'), $slotName)

if (-not $SkipWindowGuard) {
  if ($denverNow.Hour -lt 8 -or $denverNow.Hour -ge 23) {
    Write-LauncherLog ("Outside autorun window for scheduledDateDenver={0}; allowed window is 08:00-22:59 America/Denver." -f $scheduledDateDenver) 'INFO'
    exit 0
  }
  if ($Slots -notcontains $slotName) {
    Write-LauncherLog ("Current slot {0} is not in this trigger's allowed slots ({1}); skipping." -f $slotName, ($Slots -join ', ')) 'INFO'
    exit 0
  }
}

if ($UseAutorunState) {
  if (Test-AutorunLockFresh) {
    Write-LauncherLog 'Another autorun appears to be in progress; skipping duplicate launch.' 'WARN'
    exit 0
  }

  $state = Read-AutorunState
  $stateSlotKey = $null
  if ($state.ContainsKey('lastScheduledSlotKey')) { $stateSlotKey = $state.lastScheduledSlotKey }
  # Pre-slot state files recorded only the date; treat a same-day legacy
  # success as an evening-slot success so the transition day cannot double-run.
  if (-not $stateSlotKey -and $state.lastScheduledDateDenver -eq $scheduledDateDenver) {
    $stateSlotKey = "{0}#evening" -f $state.lastScheduledDateDenver
  }
  if ($stateSlotKey -eq $scheduledSlotKey -and $state.lastResult -eq 'success') {
    Write-LauncherLog ("Autorun already succeeded for slot={0}; skipping." -f $scheduledSlotKey) 'INFO'
    exit 0
  }

  $lockPayload = @{
    startedUtc = [DateTime]::UtcNow.ToString('o')
    scheduledDateDenver = $scheduledDateDenver
    scheduledSlotKey = $scheduledSlotKey
    user = $principalUser
  }
  # CreateNew is atomic: two triggers racing past the freshness check cannot
  # both win the lock the way check-then-Set-Content allowed.
  try {
    $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $lockBytes = [System.Text.Encoding]::UTF8.GetBytes(($lockPayload | ConvertTo-Json))
      $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    } finally {
      $lockStream.Dispose()
    }
  } catch [System.IO.IOException] {
    Write-LauncherLog 'Another autorun grabbed the lock concurrently; skipping duplicate launch.' 'WARN'
    exit 0
  }

  $startState = @{
    lastScheduledDateDenver = $scheduledDateDenver
    lastScheduledSlotKey = $scheduledSlotKey
    lastLaunchUtc = [DateTime]::UtcNow.ToString('o')
    lastResult = 'started'
    lastExitCode = $null
  }
  Write-AutorunState -State $startState
} else {
  Write-LauncherLog 'Dry run detected; skipping autorun state and duplicate-run guards.' 'INFO'
}

$nodeArgs = @('index.js')
if ($DryRun) {
  $nodeArgs += '--dry-run'
}
if ($Headless) {
  $nodeArgs += '--headless'
}
if ($MaxApplications -gt 0) {
  $nodeArgs += '--max'
  $nodeArgs += [string]$MaxApplications
}

Write-LauncherLog ("Starting node {0}" -f ($nodeArgs -join ' '))

$previousAutoRun = $env:AUTO_RUN
$env:AUTO_RUN = 'true'
# A stray DRY_RUN=true left in .env would silently turn a production slot
# into a dry run and record the slot as succeeded. dotenv never overrides an
# existing environment variable, so pin the intended mode here.
$previousDryRunEnv = $env:DRY_RUN
$env:DRY_RUN = if ($DryRun) { 'true' } else { 'false' }
$exitCode = 1

Push-Location $RepoRoot
try {
  # Under ErrorActionPreference=Stop, 2>&1 on a native command turns the FIRST
  # stderr line into a terminating exception that kills the run mid-stream and
  # hides the real error. Relax the preference around the node call and
  # stringify records so stderr lines land in the log as text; only
  # $LASTEXITCODE decides success.
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # Tee-Object writes UTF-16LE in Windows PowerShell, leaving the log a mix
    # of encodings; append explicitly as UTF-8 instead.
    & node @nodeArgs 2>&1 | ForEach-Object {
      $outputLine = "$_"
      Write-Host $outputLine
      Add-Content -Path $LauncherLogPath -Value $outputLine -Encoding UTF8
    }
  } finally {
    $ErrorActionPreference = $previousEap
  }
  $exitCode = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { 0 }
} catch {
  Write-LauncherLog ("Launcher exception: {0}" -f $_.Exception.Message) 'ERROR'
  $exitCode = 1
} finally {
  Pop-Location
  if ($null -eq $previousAutoRun) {
    Remove-Item Env:AUTO_RUN -ErrorAction SilentlyContinue
  } else {
    $env:AUTO_RUN = $previousAutoRun
  }
  if ($null -eq $previousDryRunEnv) {
    Remove-Item Env:DRY_RUN -ErrorAction SilentlyContinue
  } else {
    $env:DRY_RUN = $previousDryRunEnv
  }
  if ($UseAutorunState) {
    Remove-AutorunLock
  }
}

if ($UseAutorunState) {
  # exitCode 3 = platform session expired (index.js). Never 'success': later
  # triggers must keep retrying so the run recovers once the user re-logs in.
  $result = 'failure'
  if ($exitCode -eq 0) { $result = 'success' }
  elseif ($exitCode -eq 3) { $result = 'session_expired' }
  $finalState = @{
    lastScheduledDateDenver = $scheduledDateDenver
    lastScheduledSlotKey = $scheduledSlotKey
    lastLaunchUtc = $startState.lastLaunchUtc
    lastResult = $result
    lastExitCode = $exitCode
  }
  Write-AutorunState -State $finalState
}

if ($exitCode -eq 0) {
  Write-LauncherLog ("Launcher completed successfully with exitCode={0}" -f $exitCode) 'INFO'
} elseif ($exitCode -eq 3) {
  Write-LauncherLog "Platform session expired (exitCode=3); re-login required. Retries continue until re-login or window end." 'WARN'
} else {
  Write-LauncherLog ("Launcher failed with exitCode={0}" -f $exitCode) 'ERROR'
}

exit $exitCode
