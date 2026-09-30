# selftest-launcher.ps1 -- CI entry point for the NATIVE handler's M3U
# conformance.
#
# For every vector in tests/fixtures/vectors.json it runs the native handler's
# decode + M3U path via `bingetovlc-handler.exe --selftest <uri>` and compares
# the M3U the exe prints to stdout with the vector's `m3u` field. It prints a
# PASS / FAIL line per vector and exits non-zero if any check fails.
#
#   pwsh -File selftest-launcher.ps1 -ExePath tools/windows/bingetovlc-handler.exe
#
# The exe's --selftest path is Windows-API free by design: it never touches the
# registry and never launches VLC, so this script is also usable with a
# * Linux build of launcher.c (tools/windows/build-launcher.sh writes one to
#   /tmp/launcher-linux) -- point -ExePath at it for a local check without
# Windows.
#
# This is the native counterpart of selftest.ps1 (which asserts the PowerShell
# handler). Both are run in CI against the same vectors, so the two
# implementations of the contract in docs/SPEC.md sections 3, 6 and 7 cannot
# drift.
#
# Targets Windows PowerShell 5.1 and PowerShell 7. ASCII-only source.

param(
    [string]$ExePath,
    [string]$VectorsPath,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# UTF-8 for both our own output and the decoding of the exe's stdout.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = (Get-Location).Path }
# tools/windows -> tools -> repo root
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

function Show-Help {
    Write-Host @'
selftest-launcher.ps1 -- assert the native handler against the M3U vectors.

  pwsh -File selftest-launcher.ps1 -ExePath <bingetovlc-handler.exe> [-VectorsPath <path>]

OPTIONS
  -ExePath PATH       the native handler to test (default:
                      tools/windows/bingetovlc-handler.exe next to this script).
  -VectorsPath PATH   the golden vectors (default:
                      tests/fixtures/vectors.json in the repo root).
  -Help               this text.

For every vector the exe is run as `bingetovlc-handler.exe --selftest "<uri>"`
and the M3U it prints must equal the vector's `m3u` field byte for byte (line
endings normalised). One further check asserts that a payload whose item URL
contains CR/LF is refused (non-zero exit) rather than written into the playlist.
'@
}

if ($Help) {
    Show-Help
    return
}

# ---------------------------------------------------------------------------
# Locate inputs
# ---------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($ExePath)) {
    $ExePath = Join-Path $scriptDir 'bingetovlc-handler.exe'
}
if (-not [System.IO.Path]::IsPathRooted($ExePath)) {
    $fromCwd = Join-Path (Get-Location).Path $ExePath
    if (Test-Path -LiteralPath $fromCwd) { $ExePath = $fromCwd }
    else { $ExePath = Join-Path $repoRoot $ExePath }
}
if (-not (Test-Path -LiteralPath $ExePath)) {
    Write-Host ('FAIL: native handler not found at ' + $ExePath)
    Write-Host '      build it first: bash tools/windows/build-launcher.sh'
    exit 1
}
$Script:ExePath = (Resolve-Path -LiteralPath $ExePath).Path

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

function ConvertTo-Base64Url {
    param([string]$Text)
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text)
    $b64 = [System.Convert]::ToBase64String($bytes)
    $b64 = $b64.TrimEnd('=')
    $b64 = $b64.Replace('+', '-').Replace('/', '_')
    return $b64
}

# Run the native handler with the given arguments, capturing stdout/stderr as
# UTF-8 (independent of the console code page) so the CJK vector is exact.
function Invoke-ExeCapture {
    param([string[]]$Arguments)
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Script:ExePath
        $psi.Arguments = ConvertTo-CommandLineArgs $Arguments
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

# ---------------------------------------------------------------------------
# Run every vector through the exe's --selftest
# ---------------------------------------------------------------------------
Write-Host ('selftest-launcher: ' + $Script:ExePath)
Write-Host ''

$total = 0
$passed = 0
$failed = 0
$failedNames = New-Object System.Collections.Generic.List[string]

foreach ($vector in $doc.vectors) {
    $total = $total + 1
    $name = [string]$vector.name

    $uri = [string]$vector.uri
    if ([string]::IsNullOrEmpty($uri)) { $uri = 'vlc://open?d=' + [string]$vector.base64 }

    $result = Invoke-ExeCapture @('--selftest', $uri)

    $expected = Normalize-M3u ([string]$vector.m3u)
    $produced = Normalize-M3u $result.Out

    if ($result.Exit -eq 0 -and $produced -ceq $expected) {
        $passed = $passed + 1
        Write-Host ('  PASS  ' + $name)
    } else {
        $failed = $failed + 1
        $failedNames.Add($name)
        if ($result.Exit -ne 0) {
            Write-Host ('  FAIL  ' + $name + '  (handler exited ' + $result.Exit + ')')
            if (-not [string]::IsNullOrEmpty($result.Err)) {
                Write-Host ('      stderr: ' + (Normalize-M3u $result.Err).Trim())
            }
        } else {
            Write-Host ('  FAIL  ' + $name + '  (M3U differs)')
        }
        Show-M3uDiff $expected $produced
    }
}

# ---------------------------------------------------------------------------
# Injection case: a URL must never be able to add a playlist line
# ---------------------------------------------------------------------------
# The payload carries a URL containing CR/LF followed by a playlist directive.
# The handler must REJECT it outright (SPEC section 3: an item URL may contain
# no whitespace or control characters), so --selftest must exit non-zero.
$forgedJson = '{"v":1,"src":"injection","server":"","scope":"item","n":1,"items":[{"u":"https://host/a\r\n#EXTINF:-1,INJECTED\r\nfile:///etc/passwd","t":"bad"}]}'
$forgedUri = 'vlc://open?d=' + (ConvertTo-Base64Url $forgedJson)

$rejected = Invoke-ExeCapture @('--selftest', $forgedUri)
$total = $total + 1
if ($rejected.Exit -ne 0) {
    $passed = $passed + 1
    Write-Host ('  PASS  injection-uri-rejected (handler exited ' + $rejected.Exit + ')')
} else {
    $failed = $failed + 1
    $failedNames.Add('injection-uri-rejected')
    Write-Host '  FAIL  injection-uri-rejected (the handler accepted a URL containing CR/LF)'
}

Write-Host ''
if ($failed -gt 0) {
    Write-Host ('selftest-launcher: ' + $passed + '/' + $total + ' checks passed; FAILED: ' + ($failedNames -join ', '))
    exit 1
}

Write-Host ('selftest-launcher: ' + $passed + '/' + $total + ' checks passed')
exit 0
