param([switch]$NoBrowser, [switch]$Lan)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$env:PYTHONUTF8 = "1"
$env:EXPO_NO_TELEMETRY = "1"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"

function Invoke-Step {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        Invoke-Step "py" @("-3", "-m", "venv", ".venv")
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        Invoke-Step "python" @("-m", "venv", ".venv")
    } else {
        throw "Install Python 3.10 or later, then reopen PowerShell."
    }
}
Invoke-Step $python @("-m", "pip", "install", "-r", "requirements.txt")

$archive = Join-Path $PSScriptRoot "data\eg-drugs-main.zip"
if (-not (Test-Path -LiteralPath $archive)) {
    throw "Place eg-drugs-main.zip in the data folder or download the full ZIP from GitHub Releases."
}
if (-not $env:SMARTMED_DB) {
    $env:SMARTMED_DB = Join-Path $PSScriptRoot "smartmed.sqlite"
}
Invoke-Step $python @("smartmed.py", "--db", $env:SMARTMED_DB, "import-eg", $archive)

if (-not (Get-Command tesseract -ErrorAction SilentlyContinue)) {
    foreach ($folder in @("$env:ProgramFiles\Tesseract-OCR", "${env:ProgramFiles(x86)}\Tesseract-OCR")) {
        if (Test-Path -LiteralPath (Join-Path $folder "tesseract.exe")) {
            $env:PATH = "$folder;$env:PATH"
            break
        }
    }
}
if (Get-Command tesseract -ErrorAction SilentlyContinue) {
    $languages = & tesseract --list-langs 2>$null
    if ($languages -notcontains "ara" -or $languages -notcontains "eng") {
        Write-Warning "Install the Arabic (ara) and English (eng) Tesseract language files for bilingual image reading."
    }
} else {
    Write-Warning "Tesseract is unavailable. Search works. Install Tesseract to read images."
}

if (-not (Test-Path -LiteralPath "mobile\dist\index.html")) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw "Install Node.js 22 LTS or download the full ZIP with the prepared web app." }
    Push-Location -LiteralPath "mobile"
    try {
        Invoke-Step $npm.Source @("ci", "--no-audit", "--no-fund")
        Invoke-Step $npm.Source @("run", "build:web")
    } finally {
        Pop-Location
    }
}

$bindAddress = "127.0.0.1"
if ($Lan) { $bindAddress = "0.0.0.0" }
$url = "http://127.0.0.1:8000/"
Write-Host "SmartMed is starting at $url"
$server = Start-Process -FilePath $python -ArgumentList @(
    "-m", "uvicorn", "backend.app:app", "--host", $bindAddress, "--port", "8000"
) -NoNewWindow -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($server.HasExited) { throw "The SmartMed server exited. Check the error above." }
        try {
            $health = Invoke-RestMethod -Uri "${url}api/v1/health" -TimeoutSec 1
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 350
    }
    if (-not $ready) { throw "The SmartMed server did not respond on port 8000." }
    if (-not $NoBrowser) { Start-Process $url }
    $server.WaitForExit()
    if ($server.ExitCode -ne 0) { throw "The server exited with code $($server.ExitCode)." }
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
