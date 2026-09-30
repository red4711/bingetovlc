# selftest.ps1 -- CI entry point for the Windows handler's M3U conformance.
#
# For every vector in tests/fixtures/vectors.json it runs the handler's decode
# plus M3U path via `bingetovlc-handler.ps1 -SelfTest <uri>` and compares the
# produced M3U with the vector's `m3u` field. Line endings are normalised before
# the comparison; any other difference fails the run.
#
#   powershell -File selftest.ps1 -VectorsPath tests/fixtures/vectors.json
#
# It works on windows-latest AND on portable PowerShell on Linux:
#   - it never touches the registry and never launches VLC (the handler's
#     -SelfTest path is Windows-API free by design)
#   - -ExecutionPolicy is only passed on Windows
#   - the child is started via System.Diagnostics.Process with an explicit UTF-8
#     stdout decoder, so the CJK vector is exact regardless of console code page
#
# Targets Windows PowerShell 5.1 and PowerShell 7. ASCII-only source.

# Plain script: no [CmdletBinding()] and no [Parameter()] attributes, so
# parameters bind positionally in declaration order without pulling in automatic
# common parameters.
param(
    [string]$VectorsPath,

    [string]$HandlerPath
)

$ErrorActionPreference = 'Stop'

# UTF-8 for both our own output and the decoding of the child process's stdout.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = (Get-Location).Path }
# tools/windows -> tools -> repo root
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

# ---------------------------------------------------------------------------
# Locate inputs
# ---------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($HandlerPath)) {
    $HandlerPath = Join-Path $scriptDir 'bingetovlc-handler.ps1'
}
if (-not (Test-Path -LiteralPath $HandlerPath)) {
    Write-Host ('FAIL: handler not found at ' + $HandlerPath)
    exit 1
}

if ([string]::IsNullOrEmpty($VectorsPath)) {
    $VectorsPath = Join-Path $repoRoot 'tests/fixtures/vectors.json'
}
if (-not [System.IO.Path]::IsPathRooted($VectorsPath)) {
    $fromCwd = Join-Path (Get-Location).Path $VectorsPath
    if (Test-Path -LiteralPath $fromCwd) { $VectorsPath = $fromCwd }
    else { $VectorsPath = Join-Path $repoRoot $VectorsPath }
}
if (-not (Test-Path -LiteralPath $VectorsPath)) {
    Write-Host ('FAIL: vectors not found at ' + $VectorsPath)
    exit 1
}

$doc = Get-Content -LiteralPath $VectorsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $doc -or $null -eq $doc.vectors) {
    Write-Host 'FAIL: vectors.json contains no "vectors" array'
    exit 1
}

# ---------------------------------------------------------------------------
# Locate the PowerShell that is running us (to re-invoke the handler)
# ---------------------------------------------------------------------------
$psExe = $null
try { $psExe = (Get-Process -Id $PID).Path } catch { }
if ([string]::IsNullOrEmpty($psExe)) {
    try { $psExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
}
if ([string]::IsNullOrEmpty($psExe)) {
    if (Get-Command pwsh -ErrorAction SilentlyContinue) { $psExe = 'pwsh' }
    elseif (Get-Command powershell.exe -ErrorAction SilentlyContinue) { $psExe = 'powershell.exe' }
}
if ([string]::IsNullOrEmpty($psExe)) {
    Write-Host 'FAIL: cannot determine the PowerShell executable to invoke the handler with'
    exit 1
}

$runningOnWindows = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Normalize-M3u {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $t = $Text -replace "`r`n", "`n"
    $t = $t -replace "`r", "`n"
    return $t.TrimEnd("`n")
}

function Show-M3uDiff {
    param([string]$Expected, [string]$Actual)
    $e = @($Expected -split "`n")
    $a = @($Actual -split "`n")
    $max = [Math]::Max($e.Count, $a.Count)
    $shown = 0
    for ($i = 0; $i -lt $max; $i++) {
        $el = '<missing>'
        if ($i -lt $e.Count) { $el = $e[$i] }
        $al = '<missing>'
        if ($i -lt $a.Count) { $al = $a[$i] }
        if ($el -cne $al) {
            Write-Host ('      line ' + ($i + 1) + ' expected: ' + $el)
            Write-Host ('      line ' + ($i + 1) + ' actual  : ' + $al)
            $shown = $shown + 1
            if ($shown -ge 3) { break }
        }
    }
}

# Build a Windows command line for a child process. Each argument is wrapped in
# double quotes (we never pass an argument containing a double quote or a
# backslash immediately before one, so this simple form is sufficient -- and it
# is the only option: ProcessStartInfo.ArgumentList does not exist in PowerShell
# 5.1 / .NET Framework).
function ConvertTo-CommandLineArgs {
    param([string[]]$Arguments)
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($arg in $Arguments) {
        $a = [string]$arg
        $a = $a.Replace('"', '\"')
        $parts.Add('"' + $a + '"')
    }
    return ($parts -join ' ')
}

# ---------------------------------------------------------------------------
# Run every vector
# ---------------------------------------------------------------------------
$total = 0
$passed = 0
$failed = 0
$failedNames = New-Object System.Collections.Generic.List[string]

foreach ($vector in $doc.vectors) {
    $total = $total + 1
    $name = [string]$vector.name

    $uri = [string]$vector.uri
    if ([string]::IsNullOrEmpty($uri)) { $uri = 'vlc://open?d=' + [string]$vector.base64 }

    $argList = @('-NoProfile', '-NonInteractive')
    if ($runningOnWindows) { $argList += @('-ExecutionPolicy', 'Bypass') }
    $argList += @('-File', $HandlerPath, '-SelfTest', $uri)

    $childExit = 0
    $producedRaw = ''
    $stderrText = ''
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $psExe
        $psi.Arguments = ConvertTo-CommandLineArgs $argList
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        # Decode the child's stdout as UTF-8 explicitly, independent of any
        # console code page. The handler writes raw UTF-8 bytes, so this is exact.
        $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $producedRaw = $proc.StandardOutput.ReadToEnd()
        $stderrText = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        $childExit = $proc.ExitCode
    } catch {
        $childExit = 99
        $stderrText = $_.Exception.Message
    }

    $expected = Normalize-M3u ([string]$vector.m3u)
    $produced = Normalize-M3u $producedRaw

    if ($childExit -eq 0 -and $produced -ceq $expected) {
        $passed = $passed + 1
        Write-Host ('  PASS  ' + $name)
    } else {
        $failed = $failed + 1
        $failedNames.Add($name)
        if ($childExit -ne 0) {
            Write-Host ('  FAIL  ' + $name + '  (handler exited ' + $childExit + ')')
            if (-not [string]::IsNullOrEmpty($stderrText)) {
                Write-Host ('      stderr: ' + (Normalize-M3u $stderrText).Trim())
            }
        } else {
            Write-Host ('  FAIL  ' + $name + '  (M3U differs)')
        }
        Show-M3uDiff $expected $produced
    }
}

# ---------------------------------------------------------------------------
# Injection cases: a URL must never be able to add a playlist line
# ---------------------------------------------------------------------------
# The payload below carries a URL containing CR/LF followed by a playlist
# directive. The handler must REJECT it outright; and even if a payload bypassed
# validation, the serialiser must not let the injected text start a new line.
$forgedJson = '{"v":1,"src":"injection","server":"","scope":"item","n":1,"items":[{"u":"https://host/a\r\n#EXTINF:-1,INJECTED\r\nfile:///etc/passwd","t":"bad"}]}'

function ConvertTo-Base64Url {
    param([string]$Text)
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text)
    $b64 = [System.Convert]::ToBase64String($bytes)
    $b64 = $b64.TrimEnd('=')
    $b64 = $b64.Replace('+', '-').Replace('/', '_')
    return $b64
}

function Invoke-HandlerCapture {
    param([string[]]$Arguments)
    $argv = @('-NoProfile', '-NonInteractive')
    if ($runningOnWindows) { $argv += @('-ExecutionPolicy', 'Bypass') }
    $argv += @('-File', $HandlerPath)
    $argv += $Arguments
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $psExe
        $psi.Arguments = ConvertTo-CommandLineArgs $argv
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $out = $proc.StandardOutput.ReadToEnd()
        $err = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        return @{ Exit = $proc.ExitCode; Out = $out; Err = $err }
    } catch {
        return @{ Exit = 99; Out = ''; Err = $_.Exception.Message }
    }
}

$forgedUri = 'vlc://open?d=' + (ConvertTo-Base64Url $forgedJson)

# Case 1: the URI form must be refused (exit 3 = bad payload, or 2 = malformed).
$rejected = Invoke-HandlerCapture @('-SelfTest', $forgedUri)
$total = $total + 1
if ($rejected.Exit -ne 0) {
    $passed = $passed + 1
    Write-Host ('  PASS  injection-uri-rejected (handler exited ' + $rejected.Exit + ')')
} else {
    $failed = $failed + 1
    $failedNames.Add('injection-uri-rejected')
    Write-Host '  FAIL  injection-uri-rejected (the handler accepted a URL containing CR/LF)'
}

# Case 2: the serialiser itself must not let the injected text start a line.
# 1 item, no title -> exactly 3 lines: #EXTM3U, #EXTINF, URL. Exactly one #EXTINF.
$raw = Invoke-HandlerCapture @('-SelfTestJson', (ConvertTo-Base64Url $forgedJson))
$total = $total + 1
$lines = @()
if (-not [string]::IsNullOrEmpty($raw.Out)) { $lines = @((Normalize-M3u $raw.Out) -split "`n") }
$extinfCount = @($lines | Where-Object { $_.StartsWith('#EXTINF:') }).Count
$injectedLine = $lines -contains '#EXTINF:-1,INJECTED'
if ($raw.Exit -eq 0 -and $lines.Count -eq 3 -and $extinfCount -eq 1 -and -not $injectedLine) {
    $passed = $passed + 1
    Write-Host ('  PASS  injection-serialiser-line-count (lines=' + $lines.Count + ', extinf=' + $extinfCount + ')')
} else {
    $failed = $failed + 1
    $failedNames.Add('injection-serialiser-line-count')
    Write-Host ('  FAIL  injection-serialiser-line-count (exit=' + $raw.Exit + ', lines=' + $lines.Count + ', extinf=' + $extinfCount + ', injectedLine=' + $injectedLine + ')')
}

Write-Host ''
if ($failed -gt 0) {
    Write-Host ('selftest: ' + $passed + '/' + $total + ' checks passed; FAILED: ' + ($failedNames -join ', '))
    exit 1
}

Write-Host ('selftest: ' + $passed + '/' + $total + ' checks passed')
exit 0