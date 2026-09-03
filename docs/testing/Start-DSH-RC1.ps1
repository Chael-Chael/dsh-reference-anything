$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Push-Location $projectDirectory
try {
    & dsh web --host 127.0.0.1 --port 3080
} finally {
    Pop-Location
}
