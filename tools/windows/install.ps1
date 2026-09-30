# install.ps1 -- register / unregister the bingetovlc protocol handler.
#
# DEFAULT IS THE NATIVE HANDLER. The registered command line now runs
# bingetovlc-handler.exe DIRECTLY, with no script host in the runtime path.
# The previous form
#   powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ...
# is exactly the command-line signature antivirus/EDR heuristics flag -- it was
# blocked on a real machine and the handler never ran. See docs/SPEC.md section 6.
#
#   -Handler auto        (default) use the native exe when it sits next to this
#                        script, otherwise fall back to the PowerShell handler.
#   -Handler exe         the native exe (bingetovlc-handler.exe).
#   -Handler powershell  the PowerShell handler (bingetovlc-handler.ps1), kept
#                        as an alternative implementation of the same contract.
#
# In the exe modes this script DELEGATES to the native handler's own verbs and
# does not write the registry itself:
#   bingetovlc-handler.exe --install [--scheme vlc,bingetovlc] [--vlc <path>]
#   bingetovlc-handler.exe --uninstall
#   bingetovlc-handler.exe --diagnostics
# That delegation is what makes the install path need no PowerShell at all: on a
# machine where PowerShell is blocked, `bingetovlc-handler.exe --install` (or a
# double-click) registers the schemes on its own.
#
# Per-user registration only (HKCU\Software\Classes). Because HKEY_CLASSES_ROOT
# is a merged view of HKLM\Software\Classes and HKCU\Software\Classes, a HKCU
# entry WINS for the current user without admin rights and without touching the
# machine-wide handler. That is exactly the behaviour docs/SPEC.md section 6
# asks for.
#
# Usage
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Handler powershell
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Scheme vlc
#   powershell -ExecutionPolicy Bypass -File install.ps1 -VlcPath "C:\...\vlc.exe"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Diagnostics
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# A pre-existing scheme key is exported to a .reg backup BEFORE it is
# overridden; -Uninstall restores that backup, or deletes the key when there is
# none. Both handlers do this: the native exe performs the `reg.exe export`
# itself in exe mode, and this script performs it in PowerShell mode.
# Adapted from the Windows custom-URI registration shape:
#   https://learn.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa767914(v=vs.85)
#
# Targets Windows PowerShell 5.1. ASCII-only source; no PS7-only syntax, no
# ternary/null-coalescing operators. No CmdletBinding, so -Verbose and -WhatIf
# here are plain switches we own and behave exactly as documented below.

param(
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$Diagnostics,
    [ValidateSet('auto', 'exe', 'powershell')]
    [string]$Handler = 'auto',
    [string[]]$Scheme = @('vlc', 'bingetovlc'),
    [string]$VlcPath,
    [switch]$Verbose,
    [switch]$WhatIf,
    [switch]$Help
)

$SCRIPT:HandlerVersion = '1.1.0'
$SCRIPT:DryRunMode = [bool]($DryRun -or $WhatIf)
$SCRIPT:VerboseMode = [bool]$Verbose
$SCRIPT:HandlerKind = 'auto'

function Write-Info {
    param([string]$Message)
    Write-Host $Message
}

function Write-VerboseInfo {
    param([string]$Message)
    if ($SCRIPT:VerboseMode) { Write-Host ('  [verbose] ' + $Message) }
}

function Get-LocalBaseDir {
    $la = $env:LOCALAPPDATA
    if ([string]::IsNullOrEmpty($la)) { $la = [System.IO.Path]::GetTempPath() }
    return (Join-Path $la 'bingetovlc')
}

function Get-BackupDir {
    return (Join-Path (Get-LocalBaseDir) 'backup')
}

# ---------------------------------------------------------------------------
# VLC detection -- identical logic to the handler's Find-VlcExecutable.
# ---------------------------------------------------------------------------
function Find-VlcExecutable {
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrEmpty($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath) { return $ExplicitPath }
        return $null
    }

    $candidates = New-Object System.Collections.Generic.List[string]

    try {
        $regKeys = @(
            'HKLM:\SOFTWARE\VideoLAN\VLC',
            'HKLM:\SOFTWARE\WOW6432Node\VideoLAN\VLC'
        )
        foreach ($key in $regKeys) {
            if (Test-Path $key) {
                $installDir = (Get-ItemProperty -Path $key -ErrorAction Stop).InstallDir
                if (-not [string]::IsNullOrEmpty($installDir)) {
                    $candidates.Add((Join-Path $installDir 'vlc.exe'))
                }
            }
        }
    } catch { }

    $pf = $env:ProgramFiles
    if (-not [string]::IsNullOrEmpty($pf)) {
        $candidates.Add((Join-Path (Join-Path $pf 'VideoLAN\VLC') 'vlc.exe'))
    }
    $pf86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrEmpty($pf86)) {
        $candidates.Add((Join-Path (Join-Path $pf86 'VideoLAN\VLC') 'vlc.exe'))
    }

    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrEmpty($candidate) -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Handler selection: the native exe by default, the PowerShell script by choice.
# ---------------------------------------------------------------------------
function Get-ExePath {
    return (Join-Path $PSScriptRoot 'bingetovlc-handler.exe')
}

function Get-HandlerPs1Path {
    return (Join-Path $PSScriptRoot 'bingetovlc-handler.ps1')
}

function Get-HandlerKind {
    $exe = Get-ExePath
    $haveExe = Test-Path -LiteralPath $exe

    if ($Handler -eq 'exe') {
        if (-not $haveExe) {
            Write-Warning ('-Handler exe was requested, but no native handler sits at ' + $exe + '.')
            Write-Warning 'Build it with tools/windows/build-launcher.sh (or download the CI artifact), or pass -Handler powershell.'
            return 'missing'
        }
        return 'exe'
    }
    if ($Handler -eq 'powershell') { return 'powershell' }

    # auto: prefer the native exe when it is present, else the PowerShell handler.
    if ($haveExe) { return 'exe' }
    return 'powershell'
}

# The PowerShell that is running this script -- used only to invoke the
# PowerShell handler for -Diagnostics in PowerShell mode.
function Get-PowerShellExe {
    try {
        $p = (Get-Process -Id $PID).Path
        if (-not [string]::IsNullOrEmpty($p)) { return $p }
    } catch { }
    if (Get-Command powershell.exe -ErrorAction SilentlyContinue) { return 'powershell.exe' }
    if (Get-Command pwsh -ErrorAction SilentlyContinue) { return 'pwsh' }
    return $null
}

function Get-CommandValue {
    # The command line Windows runs when the scheme is opened in PowerShell mode.
    # %1 is the full URI and is quoted on purpose (security + argument integrity).
    $handler = Get-HandlerPs1Path
    $cmd = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
        $handler + '" "%1"'
    return $cmd
}

function Get-ExeCommandValue {
    # The command line Windows runs when the scheme is opened in native mode.
    $exe = Get-ExePath
    return ('"' + $exe + '" "%1"')
}

function Get-SchemeKeyPath {
    param([string]$Name)
    return ('HKCU:\Software\Classes\' + $Name)
}

# reg.exe addresses HKCU without the drive prefix.
function Get-SchemeKeyRegPath {
    param([string]$Name)
    return ('HKCU\Software\Classes\' + $Name)
}

function Get-SchemeState {
    param([string]$Name)
    $key = Get-SchemeKeyPath $Name
    if (-not (Test-Path $key)) { return 'absent' }
    $cmd = ''
    try {
        $cmdKey = $key + '\shell\open\command'
        if (Test-Path $cmdKey) { $cmd = [string](Get-ItemProperty -Path $cmdKey -ErrorAction Stop).'(default)' }
    } catch { }
    if ([string]::IsNullOrEmpty($cmd)) { return 'present (no command)' }
    return $cmd
}

function Show-SchemeSummary {
    param([string]$Label)
    Write-Info ($Label)
    foreach ($name in $Scheme) {
        $state = Get-SchemeState $name
        Write-Info ('  ' + $name.PadRight(12) + ' : ' + $state)
    }
}

# ---------------------------------------------------------------------------
# Native-handler delegation (the default path)
# ---------------------------------------------------------------------------
function Format-NativeArg {
    param([string]$Arg)
    if ([string]::IsNullOrEmpty($Arg)) { return '""' }
    if ($Arg -match '[ \t"]') { return ('"' + $Arg + '"') }
    return $Arg
}

function Invoke-Native {
    param([string[]]$Arguments)

    $exe = Get-ExePath
    $display = New-Object System.Collections.Generic.List[string]
    $display.Add('"' + $exe + '"')
    foreach ($a in $Arguments) { $display.Add((Format-NativeArg $a)) }
    Write-Info ('  ' + ($display -join ' '))

    if ($SCRIPT:DryRunMode) {
        Write-Info '  [dry-run] the native handler was NOT run and no registry writes were performed.'
        return 0
    }

    & $exe @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Warning ('the native handler exited ' + $code + '. See its output above and ' +
            (Join-Path (Join-Path (Get-LocalBaseDir) 'logs') 'handler.log') + '.')
    }
    return $code
}

# ---------------------------------------------------------------------------
# Backup / restore -- used by the PowerShell handler path. The native exe does
# its own `reg.exe export` backup internally when it is the selected handler.
# ---------------------------------------------------------------------------
function New-SchemeBackup {
    param([string]$Name)
    $key = Get-SchemeKeyPath $Name
    if (-not (Test-Path $key)) { return $null }

    $backupDir = Get-BackupDir
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $file = Join-Path $backupDir ($Name + '-' + $stamp + '.reg')
    $regPath = Get-SchemeKeyRegPath $Name

    if ($SCRIPT:DryRunMode) {
        Write-Info ('  [dry-run] reg export "' + $regPath + '" "' + $file + '" /y')
        return $file
    }

    if (-not [System.IO.Directory]::Exists($backupDir)) {
        [System.IO.Directory]::CreateDirectory($backupDir) | Out-Null
    }
    $reg = Get-Command 'reg.exe' -ErrorAction SilentlyContinue
    if ($null -eq $reg) {
        Write-Warning 'reg.exe not found; cannot back up the existing scheme key.'
        return $null
    }
    & reg.exe export $regPath $file /y | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning ('reg export failed for ' + $Name + ' (exit ' + $LASTEXITCODE + ').')
        return $null
    }
    Write-Info ('  backed up existing ' + $Name + ' key -> ' + $file)
    return $file
}

function Get-LatestBackup {
    param([string]$Name)
    $backupDir = Get-BackupDir
    if (-not [System.IO.Directory]::Exists($backupDir)) { return $null }
    $files = Get-ChildItem -LiteralPath $backupDir -Filter ($Name + '-*.reg') -File -ErrorAction SilentlyContinue |
        Sort-Object -Property Name -Descending
    if ($null -eq $files -or @($files).Count -eq 0) { return $null }
    return @($files)[0].FullName
}

# ---------------------------------------------------------------------------
# Register / unregister one scheme -- PowerShell handler path
# ---------------------------------------------------------------------------
function Register-OneScheme {
    param([string]$Name, [string]$IconValue)

    $key = Get-SchemeKeyPath $Name
    $cmd = Get-CommandValue

    Write-Info ('registering ' + $Name + ' (PowerShell handler)')
    Write-Info ('  key      : ' + $key)
    Write-Info ('  command  : ' + $cmd)
    Write-Info ('  icon     : ' + $IconValue)

    if ($SCRIPT:DryRunMode) {
        Write-Info '  [dry-run] no registry writes performed.'
        return
    }

    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value ('URL:' + $Name + ' Protocol')
    New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

    $iconKey = $key + '\DefaultIcon'
    New-Item -Path $iconKey -Force | Out-Null
    Set-ItemProperty -Path $iconKey -Name '(default)' -Value $IconValue

    $cmdKey = $key + '\shell\open\command'
    New-Item -Path $cmdKey -Force | Out-Null
    Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $cmd
}

function Unregister-OneScheme {
    param([string]$Name)

    $key = Get-SchemeKeyPath $Name
    $backup = Get-LatestBackup $Name

    if ($null -ne $backup) {
        Write-Info ('restoring ' + $Name + ' from backup: ' + $backup)
        if ($SCRIPT:DryRunMode) {
            Write-Info ('  [dry-run] reg import "' + $backup + '"')
            return
        }
        $reg = Get-Command 'reg.exe' -ErrorAction SilentlyContinue
        if ($null -eq $reg) {
            Write-Warning 'reg.exe not found; cannot restore the backup.'
            return
        }
        & reg.exe import $backup | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning ('reg import failed for ' + $Name + ' (exit ' + $LASTEXITCODE + ').')
        } else {
            Write-Info ('  restored ' + $Name + ' from its pre-bingetovlc backup.')
        }
        return
    }

    if (Test-Path $key) {
        Write-Info ('no backup for ' + $Name + '; removing the key')
        if ($SCRIPT:DryRunMode) {
            Write-Info ('  [dry-run] Remove-Item -Recurse "' + $key + '"')
            return
        }
        Remove-Item -Path $key -Recurse -Force
        Write-Info ('  removed ' + $key)
    } else {
        Write-Info ('  ' + $Name + ' is not registered; nothing to restore or remove.')
    }
}

function Invoke-Diagnostics {
    if ($SCRIPT:HandlerKind -eq 'exe') {
        Write-Info 'native handler diagnostics:'
        if ($SCRIPT:DryRunMode) {
            $exe = Get-ExePath
            Write-Info ('  [dry-run] "' + $exe + '" --diagnostics')
            return 0
        }
        $exe = Get-ExePath
        & $exe '--diagnostics'
        return $LASTEXITCODE
    }

    $handler = Get-HandlerPs1Path
    $psExe = Get-PowerShellExe
    if ([string]::IsNullOrEmpty($psExe)) {
        Write-Warning 'cannot find a PowerShell to run the handler diagnostics with.'
        return 1
    }
    $runningOnWindows = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
    $argList = @('-NoProfile', '-NoLogo')
    if ($runningOnWindows) { $argList += @('-ExecutionPolicy', 'Bypass') }
    $argList += @('-File', $handler, '-Diagnostics')
    & $psExe @argList
    return $LASTEXITCODE
}

function Show-ManualInstructions {
    Write-Info ''
    Write-Info 'Manual fallback (if you prefer to inspect first):'
    Write-Info '  * inspect the current state with:'
    Write-Info '      reg query "HKCU\Software\Classes\vlc" /s'
    Write-Info '      reg query "HKCU\Software\Classes\bingetovlc" /s'
    Write-Info '  * or import the commented templates by hand:'
    Write-Info '      bingetovlc-scheme.reg        (replace the __HANDLER_EXE__ and __VLC_PATH__ placeholders first)'
    Write-Info '      bingetovlc-scheme-remove.reg (removes the per-user keys)'
    Write-Info '  * the native handler can do all of this itself, with no PowerShell:'
    Write-Info '      bingetovlc-handler.exe --install'
    Write-Info '      bingetovlc-handler.exe --uninstall'
    Write-Info '  * a .reg backup of any overridden key is written under:'
    Write-Info ('      ' + (Get-BackupDir))
}

function Show-Help {
    $text = @'
install.ps1 -- per-user registration for the bingetovlc protocol handler.

  powershell -ExecutionPolicy Bypass -File install.ps1 [options]

OPTIONS
  -Handler auto|exe|powershell
                      which handler to register. Default: auto, which uses the
                      native bingetovlc-handler.exe when it sits next to this
                      script and falls back to the PowerShell handler otherwise.
  -Uninstall          restore the backup of each scheme (or remove the key when
                      there is no backup), then print what was restored.
  -Diagnostics        print the handler's report (VLC path, scheme registration
                      state, playlist dir, recent log lines) and exit.
  -DryRun             print the exact operations and write nothing.
  -WhatIf             same safety as -DryRun (accepted for familiarity).
  -Scheme vlc,bingetovlc
                      choose which schemes to register (default: both).
  -VlcPath PATH       explicit path to vlc.exe (otherwise auto-detected).
  -Verbose            extra output.
  -Help               this text.

NOTES
  The native handler (bingetovlc-handler.exe) is the default. It launches VLC
  directly, with no script host in the runtime path, and it can register itself
  without PowerShell:
      bingetovlc-handler.exe --install
      bingetovlc-handler.exe --uninstall
      bingetovlc-handler.exe --diagnostics
  The PowerShell handler is kept as an alternative implementation of the same
  contract; select it with -Handler powershell.

  Registration is per-user (HKCU\Software\Classes). That overrides a machine-wide
  handler for the current user only, and needs no administrator rights.
  Chrome and Edge ask once when the scheme is first opened and offer "Always
  allow". Firefox remembers the choice after a checkbox prompt.
'@
    Write-Host $text
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if ($Help) {
    Show-Help
    return
}

$validSchemes = @('vlc', 'bingetovlc')
foreach ($name in $Scheme) {
    if ($validSchemes -notcontains $name) {
        Write-Warning ('Scheme "' + $name + '" is not one of ' + ($validSchemes -join ', ') + '; it will still be registered.')
    }
}

$SCRIPT:HandlerKind = Get-HandlerKind
if ($SCRIPT:HandlerKind -eq 'missing') {
    exit 1
}

if ($SCRIPT:HandlerKind -eq 'exe') {
    Write-Info ('handler : native (' + (Get-ExePath) + ')')
} else {
    Write-Info ('handler : PowerShell (' + (Get-HandlerPs1Path) + ')')
}

if ($Diagnostics) {
    [void](Invoke-Diagnostics)
    exit 0
}

# Detect VLC the same way the handler does (both modes; the icon needs it, and a
# missing VLC is worth warning about before anything is registered).
$vlc = Find-VlcExecutable -ExplicitPath $VlcPath
if ($null -eq $vlc) {
    Write-Warning 'VLC was not found. Registration can still proceed, but VLC must be installed (or -VlcPath given) before the handler works.'
} else {
    Write-Info ('VLC found: ' + $vlc)
}

if ($null -ne $vlc) { $iconValue = '"' + $vlc + '",0' } else { $iconValue = '' }

if ($SCRIPT:DryRunMode) { Write-Info 'DRY RUN: no registry changes will be made.' }

Show-SchemeSummary 'Before:'

$nativeExit = 0

if ($SCRIPT:HandlerKind -eq 'exe') {
    Write-Info ''
    if ($Uninstall) {
        Write-Info 'Delegating removal to the native handler (it restores a backup when one exists).'
        if ($PSBoundParameters.ContainsKey('Scheme') -and -not ((@($Scheme) -join ',') -eq 'vlc,bingetovlc')) {
            Write-Warning ('The native --uninstall restores/removes BOTH schemes; -Scheme (' + (@($Scheme) -join ', ') + ') is not forwarded. Use -Handler powershell to uninstall a subset.')
        }
        $nativeExit = Invoke-Native @('--uninstall')
    } else {
        Write-Info 'Delegating registration to the native handler (it backs up any pre-existing key first).'
        $nativeArgs = @('--install', '--scheme', (@($Scheme) -join ','))
        if (-not [string]::IsNullOrEmpty($VlcPath)) { $nativeArgs += @('--vlc', $VlcPath) }
        $nativeExit = Invoke-Native $nativeArgs
    }
} else {
    Write-Info ''
    foreach ($name in $Scheme) {
        if ($Uninstall) {
            Unregister-OneScheme $name
        } else {
            # Back up any pre-existing key BEFORE overriding it.
            New-SchemeBackup $name | Out-Null
            Register-OneScheme $name $iconValue
        }
    }
}

Write-Info ''
Show-SchemeSummary 'After:'

Write-Info ''
if ($Uninstall) {
    Write-Info 'Uninstall complete.'
} else {
    Write-Info 'Registration complete. Open a vlc:// link from Chrome/Edge; the browser asks'
    Write-Info 'once and offers "Always allow" (check the box to stop the prompt).'
    if ($SCRIPT:HandlerKind -eq 'exe') {
        Write-Info 'Verify with: bingetovlc-handler.exe --diagnostics'
    } else {
        Write-Info 'Verify with: powershell -ExecutionPolicy Bypass -File bingetovlc-handler.ps1 -Diagnostics'
    }
}

Show-ManualInstructions

if ($nativeExit -ne 0) {
    exit $nativeExit
}
