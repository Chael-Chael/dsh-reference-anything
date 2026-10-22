param([switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$desktopExe = 'D:\Coding\dsh\DeepSeek Harness.exe'
$cli = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$nodeExe = (Get-Command node.exe).Source
$workspace = Join-Path $repo '.codex-tmp\agent-browser-test\workspace'
$logs = Join-Path $repo '.codex-tmp\agent-workflow'

# Validate everything before stopping either environment.
foreach ($profileName in @('agent-browser-test')) {
    $profile = Join-Path $dshRoot "profiles\$profileName"
    $link = Get-Item -LiteralPath (Join-Path $profile 'node_modules\dsh-reference-anything')
    if (-not $link.LinkType -or [IO.Path]::GetFullPath(([string]@($link.Target)[0])) -ne $repo) {
        throw "$profileName does not link to $repo"
    }
}
# Desktop may use an online package after the user removes the local link.
$desktopLink = Get-Item -LiteralPath (Join-Path $dshRoot 'profiles/desktop/node_modules/dsh-reference-anything') -ErrorAction SilentlyContinue
$refreshDesktop = $desktopLink -and $desktopLink.LinkType -and [IO.Path]::GetFullPath(([string]@($desktopLink.Target)[0])) -eq $repo
if ($refreshDesktop -and -not (Test-Path -LiteralPath $desktopExe)) { throw "Missing required file: $desktopExe" }
foreach ($required in @($cli, (Join-Path $repo 'lib\index.js'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required file: $required" }
}
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
$desktopProcesses = @(if ($refreshDesktop) { Get-Process | Where-Object { $_.Path -eq $desktopExe } })
if ($InspectOnly) {
    [pscustomobject]@{ Repository = $repo; TestPids = $testProcesses.ProcessId; DesktopPids = $desktopProcesses.Id; Port = 3081 } | ConvertTo-Json
    exit 0
}
New-Item -ItemType Directory -Force -Path $workspace, $logs | Out-Null
foreach ($process in $desktopProcesses) { $null = $process.CloseMainWindow() }
if ($desktopProcesses.Count) {
    Wait-Process -Id $desktopProcesses.Id -Timeout 8 -ErrorAction SilentlyContinue
    # Tray processes can survive closing the last window; match exact executable only.
    Get-Process | Where-Object { $_.Path -eq $desktopExe } | Stop-Process -Force
}
foreach ($process in $testProcesses) { Stop-Process -Id $process.ProcessId }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout = Join-Path $logs "web-$stamp.stdout.log"
$stderr = Join-Path $logs "web-$stamp.stderr.log"
$web = Start-Process -FilePath $nodeExe -ArgumentList "`"$cli`" --profile agent-browser-test --host 127.0.0.1 --port 3081 --no-open" -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$desktop = if ($refreshDesktop) { Start-Process -FilePath $desktopExe -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "desktop-$stamp.stdout.log") -RedirectStandardError (Join-Path $logs "desktop-$stamp.stderr.log") -PassThru }
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
if ($refreshDesktop -and -not (Get-Process | Where-Object { $_.Path -eq $desktopExe })) { throw 'Desktop did not remain running' }
[pscustomobject]@{ WebPid = $web.Id; DesktopPid = $desktop.Id; Url = 'http://127.0.0.1:3081/'; LoginLog = $stdout; ErrorLog = $stderr; Acceptance = 'NOT_RUN' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'instances.json') -Encoding utf8
Write-Output "Linked environments refreshed (Desktop linked: $refreshDesktop). Refresh browser and perform real UI acceptance. Login URL remains in local log: $stdout"
