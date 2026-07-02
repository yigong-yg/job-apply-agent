[CmdletBinding()]
param(
  [switch]$DryRun,
  [int]$MaxApplications = 0,
  [switch]$Headless,
  [switch]$SkipWindowGuard
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
  Add-Content -Path $LauncherLogPath -Value $line
}

function Read-AutorunState {
  if (-not (Test-Path $StatePath)) {
    return @{
      lastScheduledDateDenver = $null
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
    return @{
      lastScheduledDateDenver = $state.lastScheduledDateDenver
      lastLaunchUtc = $state.lastLaunchUtc
      lastResult = $state.lastResult
      lastExitCode = $state.lastExitCode
    }
  } catch {
    Write-LauncherLog "Ignoring unreadable autorun state at ${StatePath}: $($_.Exception.Message)" 'WARN'
    return @{
      lastScheduledDateDenver = $null
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
$principalUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-LauncherLog ("Launcher invoked by {0}; utcNow={1}; denverNow={2}" -f $principalUser, $UtcNow.ToString('o'), $denverNow.ToString('yyyy-MM-ddTHH:mm:ssK'))

if (-not $SkipWindowGuard) {
  if ($denverNow.Hour -lt 18 -or $denverNow.Hour -ge 23) {
    Write-LauncherLog ("Outside autorun window for scheduledDateDenver={0}; allowed window is 18:00-22:59 America/Denver." -f $scheduledDateDenver) 'INFO'
    exit 0
  }
}

if ($UseAutorunState) {
  if (Test-AutorunLockFresh) {
    Write-LauncherLog 'Another autorun appears to be in progress; skipping duplicate launch.' 'WARN'
    exit 0
  }

  $state = Read-AutorunState
  if ($state.lastScheduledDateDenver -eq $scheduledDateDenver -and $state.lastResult -eq 'success') {
    Write-LauncherLog ("Autorun already succeeded for scheduledDateDenver={0}; skipping." -f $scheduledDateDenver) 'INFO'
    exit 0
  }

  $lockPayload = @{
    startedUtc = [DateTime]::UtcNow.ToString('o')
    scheduledDateDenver = $scheduledDateDenver
    user = $principalUser
  }
  ($lockPayload | ConvertTo-Json) | Set-Content -Path $LockPath -Encoding UTF8

  $startState = @{
    lastScheduledDateDenver = $scheduledDateDenver
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
$exitCode = 1

Push-Location $RepoRoot
try {
  & node @nodeArgs 2>&1 | Tee-Object -FilePath $LauncherLogPath -Append
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
  if ($UseAutorunState) {
    Remove-AutorunLock
  }
}

if ($UseAutorunState) {
  $finalState = @{
    lastScheduledDateDenver = $scheduledDateDenver
    lastLaunchUtc = $startState.lastLaunchUtc
    lastResult = if ($exitCode -eq 0) { 'success' } else { 'failure' }
    lastExitCode = $exitCode
  }
  Write-AutorunState -State $finalState
}

if ($exitCode -eq 0) {
  Write-LauncherLog ("Launcher completed successfully with exitCode={0}" -f $exitCode) 'INFO'
} else {
  Write-LauncherLog ("Launcher failed with exitCode={0}" -f $exitCode) 'ERROR'
}

exit $exitCode
