# uninstall.ps1 -- thin wrapper around `install.ps1 -Uninstall`.
#
# It exists so users have one obvious command to undo the per-user registration,
# and because `install.ps1 -Uninstall` prints exactly what was restored or
# removed, this wrapper just forwards to it and then says so.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Scheme vlc
#
# Targets Windows PowerShell 5.1; ASCII-only source.

param(
    [string[]]$Scheme,
    [string]$VlcPath,
    [switch]$DryRun,
    [switch]$WhatIf,
    [switch]$Verbose
)

$install = Join-Path $PSScriptRoot 'install.ps1'
if (-not (Test-Path -LiteralPath $install)) {
    Write-Error ('cannot find install.ps1 next to uninstall.ps1 (' + $install + ')')
    exit 1
}

$params = @{ Uninstall = $true }
if ($PSBoundParameters.ContainsKey('Scheme')) { $params['Scheme'] = $Scheme }
if ($PSBoundParameters.ContainsKey('VlcPath')) { $params['VlcPath'] = $VlcPath }
if ($DryRun)  { $params['DryRun'] = $true }
if ($WhatIf)  { $params['WhatIf'] = $true }
if ($Verbose) { $params['Verbose'] = $true }

# install.ps1 prints the before/after summary and what was restored.
& $install @params

Write-Host ''
Write-Host 'uninstall.ps1: run finished. The "After:" block above shows the final'
Write-Host 'state of each scheme key (restored from backup, or removed).'
Write-Host 'Backups are kept under %LOCALAPPDATA%\bingetovlc\backup if you want to re-import one.'

exit 0