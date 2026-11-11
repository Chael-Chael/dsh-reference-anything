param([switch]$InspectOnly, [ValidateSet('web', 'desktop', 'all')][string]$Targets = 'web')
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$desktopExe = 'D:\Coding\dsh\DeepSeek Harness.exe'
$cli = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$nodeExe = (Get-Command node.exe).Source
$workspace = Join-Path $repo '.codex-tmp\agent-browser-test\workspace'
$logs = Join-Path $repo '.codex-tmp\agent-workflow'
$doWeb = $Targets -ne 'desktop'
# Daily development refreshes only the test Web; Desktop restarts for releases or Desktop-specific changes.
$doDesktop = $Targets -ne 'web'

# Validate everything before stopping either environment.
$profiles = @()
if ($doWeb) { $profiles += 'agent-browser-test' }
if ($doDesktop) { $profiles += 'desktop' }
foreach ($profileName in $profiles) {
    $profile = Join-Path $dshRoot "profiles\$profileName"
    $link = Get-Item -LiteralPath (Join-Path $profile 'node_modules\dsh-reference-anything')
    if (-not $link.LinkType -or [IO.Path]::GetFullPath($link.Target[0]) -ne $repo) {
        throw "$profileName does not link to $repo"
    }
}
$required = @((Join-Path $repo 'lib\index.js'))
if ($doWeb) { $required += $cli }
if ($doDesktop) { $required += $desktopExe }
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing required file: $path" }
}
$testProcesses = @()
if ($doWeb) {
    $testProfile = Join-Path $dshRoot 'profiles\agent-browser-test'
    $patch = Get-Content -LiteralPath (Join-Path $testProfile 'cordis.patch.yml') -Raw
    foreach ($entry in @(@('storage-json', 'storages'), @('session-persistence-jsonl', 'sessions'))) {
        $expectedRoot = (Join-Path $testProfile $entry[1]).Replace('\','/')
        $pattern = '(?m)^- id: ' + [regex]::Escape($entry[0]) + '\r?\n  config:\r?\n    root: ' + [regex]::Escape($expectedRoot) + '\s*$'
        if ($patch -notmatch $pattern) { throw "Missing isolated $($entry[0]) root: $expectedRoot" }
    }
    $testProcesses = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match '(?:--profile\s+|\s)agent-browser-test(?:\s|$)' -and
        $_.CommandLine.Replace('\','/').Contains($cli.Replace('\','/'))
    })
    $listeners = @(Get-NetTCPConnection -LocalPort 3081 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -notin $testProcesses.ProcessId) { throw 'Port 3081 belongs to another process; will not stop it' }
    }
}
$desktopProcesses = if ($doDesktop) { @(Get-Process | Where-Object { $_.Path -eq $desktopExe }) } else { @() }
if ($InspectOnly) {
    [pscustomobject]@{ Repository = $repo; Targets = $Targets; TestPids = $testProcesses.ProcessId; DesktopPids = $desktopProcesses.Id; Port = 3081 } | ConvertTo-Json
    exit 0
}
New-Item -ItemType Directory -Force -Path $workspace, $logs | Out-Null
$instancesPath = Join-Path $logs 'instances.json'
# Keep the other environment's entries when only one is refreshed (Windows PowerShell 5.1 has no -AsHashtable).
$instances = @{}
if (Test-Path -LiteralPath $instancesPath) {
    (Get-Content -LiteralPath $instancesPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $instances[$_.Name] = $_.Value }
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
if ($doDesktop) {
    foreach ($process in $desktopProcesses) { $null = $process.CloseMainWindow() }
    if ($desktopProcesses.Count) {
        Wait-Process -Id $desktopProcesses.Id -Timeout 8 -ErrorAction SilentlyContinue
        # Tray processes can survive closing the last window; match exact executable only.
        Get-Process | Where-Object { $_.Path -eq $desktopExe } | Stop-Process -Force
    }
}
if ($doWeb) {
    foreach ($process in $testProcesses) { Stop-Process -Id $process.ProcessId }
    $stdout = Join-Path $logs "web-$stamp.stdout.log"
    $stderr = Join-Path $logs "web-$stamp.stderr.log"
    $web = Start-Process -FilePath $nodeExe -ArgumentList "`"$cli`" --profile agent-browser-test --host 127.0.0.1 --port 3081 --no-open" -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
}
if ($doDesktop) {
    $desktop = Start-Process -FilePath $desktopExe -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "desktop-$stamp.stdout.log") -RedirectStandardError (Join-Path $logs "desktop-$stamp.stderr.log") -PassThru
}
if ($doWeb) {
    $ready = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        $web.Refresh()
        if ($web.HasExited) { throw "Web exited: inspect $stderr" }
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3081/' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $ready) { throw "Web did not become ready: inspect $stderr" }
    $instances.WebPid = $web.Id; $instances.Url = 'http://127.0.0.1:3081/'; $instances.LoginLog = $stdout; $instances.ErrorLog = $stderr
}
if ($doDesktop) {
    if (-not (Get-Process | Where-Object { $_.Path -eq $desktopExe })) { throw 'Desktop did not remain running' }
    $instances.DesktopPid = $desktop.Id
}
$instances.Refreshed = $Targets; $instances.Acceptance = 'NOT_RUN'
$instances | ConvertTo-Json | Set-Content -LiteralPath $instancesPath -Encoding utf8
$what = @{ web = 'Test Web'; desktop = 'Desktop'; all = 'Test Web and Desktop' }[$Targets]
Write-Output "$what refreshed. Perform real UI acceptance.$(if ($doWeb) { " Login URL remains in local log: $stdout" })"
