# bingetovlc-handler.ps1 -- Windows protocol handler for vlc:// and bingetovlc://.
#
# Windows invokes this exactly as (see docs/SPEC.md section 6):
#
#   powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden `
#       -ExecutionPolicy Bypass -File "<this script>" "%1"
#
# The registry passes the full URI as the first positional argument, quoted with
# double quotes. Note the quotes around %1 in the registry value are a security
# measure, not decoration: some URL sources percent-decode before invoking the
# handler, and the quotes stop that from breaking the argument apart.
#   https://stackoverflow.com/questions/80650/how-do-i-register-a-custom-url-protocol-in-windows
#
# Targets Windows PowerShell 5.1. PS7-only syntax is deliberately avoided and
# flagged where relevant:
#   - no ternary operator (? :) and no null-coalescing operator (??)
#   - no -Parallel
#   - [System.Text.UTF8Encoding] via New-Object rather than ::new()
#   - this file is ASCII-only on purpose: a BOM-less UTF-8 file with non-ASCII
#     bytes breaks the 5.1 parser.
#
# The -SelfTest path is completely free of Windows-only APIs: no registry, no
# COM, no HKLM, no Add-Type, no LOCALAPPDATA. That is what lets CI assert it on
# windows-latest AND run it under portable pwsh on Linux against the same
# conformance vectors.
#
# Exit codes (docs/SPEC.md section 6):
#   0 ok / 2 malformed URI / 3 bad or unsupported payload / 4 VLC not found /
#   5 write failure

# NOTE: deliberately no [Parameter(Position=0)] attribute here. This is a plain
# script (no [CmdletBinding()]); parameters bind positionally in declaration
# order anyway, and avoiding the [Parameter()] attribute keeps this from being
# promoted to an advanced script whose automatic common parameter -Verbose would
# collide with the -Verbose switch declared below.
param(
    [string]$Uri,

    [switch]$SelfTest,
    [switch]$Diagnostics,
    [switch]$KeepPlaylist,
    [string]$VlcPath,
    [switch]$Verbose,
    [switch]$Help
)

# ---------------------------------------------------------------------------
# Exit codes
# ---------------------------------------------------------------------------
$SCRIPT:EXIT_OK        = 0
$SCRIPT:EXIT_MALFORMED = 2
$SCRIPT:EXIT_PAYLOAD   = 3
$SCRIPT:EXIT_NOVLC     = 4
$SCRIPT:EXIT_WRITE     = 5

$SCRIPT:SelfTestMode   = [bool]$SelfTest
$SCRIPT:VerboseMode    = [bool]$Verbose
$SCRIPT:HandlerVersion = '1.0.0'

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# Read a property whether the object is a PSCustomObject (ConvertFrom-Json) or a
# freshly built object, without tripping over a missing property or $null.
function Get-Prop {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

# Redact every secret that could ride inside a log line.
# HARD REQUIREMENT: no full URL with a token may ever reach the log. This is
# applied inside Write-Log, so every line goes through it.
function Protect-Secrets {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $t = [string]$Text
    # api_key=... (Emby streaming token)
    $t = [regex]::Replace($t, '(?i)(api_key=)[^&\s"'']+', '${1}***')
    # any query parameter whose name contains "token" (token=, access_token=,
    # api_token=, X-Emby-Token=, ...) -- covers the generic adapter's stream URL.
    $t = [regex]::Replace($t, '(?i)([?&][A-Za-z0-9_]*token[A-Za-z0-9_]*=)[^&\s"'']+', '${1}***')
    return $t
}

function Get-LocalBaseDir {
    $la = $env:LOCALAPPDATA
    if ([string]::IsNullOrEmpty($la)) {
        # Non-Windows (not expected except for -Diagnostics) -- keep it portable.
        $la = [System.IO.Path]::GetTempPath()
    }
    return (Join-Path $la 'bingetovlc')
}

function Initialize-Logging {
    $base = Get-LocalBaseDir
    $SCRIPT:LogDir  = Join-Path $base 'logs'
    $SCRIPT:LogFile = Join-Path $SCRIPT:LogDir 'handler.log'
    if (-not [System.IO.Directory]::Exists($SCRIPT:LogDir)) {
        [System.IO.Directory]::CreateDirectory($SCRIPT:LogDir) | Out-Null
    }
    # Rotate at about 1 MB. Keep exactly one previous file.
    if ([System.IO.File]::Exists($SCRIPT:LogFile)) {
        $len = (New-Object System.IO.FileInfo($SCRIPT:LogFile)).Length
        if ($len -gt 1048576) {
            $bak = $SCRIPT:LogFile + '.1'
            if ([System.IO.File]::Exists($bak)) { [System.IO.File]::Delete($bak) }
            [System.IO.File]::Move($SCRIPT:LogFile, $bak)
        }
    }
}

function Write-Log {
    param([string]$Message)
    # The self-test run must never touch disk.
    if ($SCRIPT:SelfTestMode) { return }
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $line  = $stamp + ' ' + (Protect-Secrets $Message)
        # AppendAllText (not Add-Content) so the file is always UTF-8 WITHOUT a
        # BOM on every PowerShell version.
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($SCRIPT:LogFile, $line + "`n", $enc)
    } catch {
        # Logging must never take the handler down.
    }
}

function Write-VerboseLog {
    param([string]$Message)
    if ($SCRIPT:VerboseMode) { Write-Log ('VERBOSE ' + $Message) }
}

function Fail {
    param([int]$Code, [string]$Message)
    $safe = Protect-Secrets $Message
    if ($SCRIPT:SelfTestMode) {
        [Console]::Error.WriteLine('bingetovlc: ' + $safe)
    } else {
        Write-Log ('ERROR ' + $safe)
    }
    exit $Code
}

# ---------------------------------------------------------------------------
# URI parsing
# ---------------------------------------------------------------------------

# Percent-decoding helper. [System.Uri]::UnescapeDataString is the same
# primitive the JS codec emulates with decodeURIComponent.
function Unescape-Component {
    param([string]$Value)
    if ($null -eq $Value) { return $null }
    try { return [System.Uri]::UnescapeDataString($Value) }
    catch { return $Value }
}

function Get-QueryParameters {
    param([string]$Query)
    $table = @{}
    if ([string]::IsNullOrEmpty($Query)) { return $table }
    foreach ($pair in ($Query -split '&')) {
        if ([string]::IsNullOrEmpty($pair)) { continue }
        $eq = $pair.IndexOf('=')
        if ($eq -lt 0) { continue }
        $key = Unescape-Component $pair.Substring(0, $eq)
        $val = Unescape-Component $pair.Substring($eq + 1)
        if (-not $table.ContainsKey($key)) { $table[$key] = $val }
    }
    return $table
}

function Test-AbsoluteUrl {
    param([string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return $false }
    # Same shape the JS validate() enforces.
    return [regex]::IsMatch([string]$Value, '^[A-Za-z][A-Za-z0-9+.\-]*://')
}

# base64url (RFC 4648 section 5, padding stripped) -> bytes.
# Tolerant of padding, of +/ (plain base64) and of whitespace, matching
# base64UrlDecodeBytes() in src/core/payload.js.
function ConvertFrom-Base64Url {
    param([string]$Text)
    if ($null -eq $Text) { throw 'empty base64url value' }
    $s = [string]$Text
    $s = $s -replace '\s', ''
    $s = $s.Replace('-', '+').Replace('_', '/')
    $s = $s.TrimEnd('=')
    $mod = $s.Length % 4
    if ($mod -eq 1) { throw 'invalid base64url length' }
    if ($mod -eq 2) { $s = $s + '==' }
    elseif ($mod -eq 3) { $s = $s + '=' }
    return [System.Convert]::FromBase64String($s)
}

# Build a single-item payload object using the same short keys the JS uses.
function New-SimplePayload {
    param([string]$Url, [string]$Title)
    $item = New-Object PSObject
    Add-Member -InputObject $item -MemberType NoteProperty -Name 'u' -Value $Url
    if (-not [string]::IsNullOrEmpty($Title)) {
        Add-Member -InputObject $item -MemberType NoteProperty -Name 't' -Value $Title
    }
    $payload = New-Object PSObject
    Add-Member -InputObject $payload -MemberType NoteProperty -Name 'v'    -Value 1
    Add-Member -InputObject $payload -MemberType NoteProperty -Name 'src'  -Value 'manual'
    Add-Member -InputObject $payload -MemberType NoteProperty -Name 'n'    -Value 1
    Add-Member -InputObject $payload -MemberType NoteProperty -Name 'items' -Value @($item)
    return $payload
}

function Get-TitleFromUrl {
    param([string]$Url)
    try {
        $u = New-Object System.Uri($Url)
        $seg = $u.AbsolutePath.TrimEnd('/')
        if ($seg.Length -gt 0) {
            $idx = $seg.LastIndexOf('/')
            if ($idx -ge 0) { $seg = $seg.Substring($idx + 1) }
            if ($seg.Length -gt 0) { return (Unescape-Component $seg) }
        }
        return $u.Host
    } catch {
        return ''
    }
}

# Returns @{ Ok = $true; Payload = <obj> } or @{ Ok = $false; Code = 2|3; Message = '...' }
function Resolve-PlaylistPayload {
    param([string]$RawUri)

    if ([string]::IsNullOrWhiteSpace($RawUri)) {
        return @{ Ok = $false; Code = $SCRIPT:EXIT_MALFORMED; Message = 'no URI argument was supplied' }
    }

    $raw = $RawUri.Trim()
    # Strip a surrounding pair of quotes the shell may have left in place.
    if ($raw.Length -ge 2) {
        $first = $raw.Substring(0, 1)
        $last  = $raw.Substring($raw.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $raw = $raw.Substring(1, $raw.Length - 2)
        }
    }

    $m = [regex]::Match($raw, '^([A-Za-z][A-Za-z0-9+.\-]*)://(.*)$')
    if (-not $m.Success) {
        return @{ Ok = $false; Code = $SCRIPT:EXIT_MALFORMED; Message = 'URI is not of the form scheme://...' }
    }
    $scheme = $m.Groups[1].Value.ToLowerInvariant()
    $rest   = $m.Groups[2].Value

    if ($scheme -ne 'vlc' -and $scheme -ne 'bingetovlc') {
        return @{ Ok = $false; Code = $SCRIPT:EXIT_MALFORMED; Message = ('unsupported scheme: ' + $scheme) }
    }

    # Form 3: bare convenience form, scheme://<absolute-url>.
    # e.g. vlc://https://media.example.com/Videos/1/stream?Static=true&api_key=...
    if (Test-AbsoluteUrl $rest) {
        $url = $rest
        return @{ Ok = $true; Payload = (New-SimplePayload -Url $url -Title (Get-TitleFromUrl $url)) }
    }

    # Forms 1 and 2: scheme://open?... (tolerate a trailing slash on "open").
    $path = $rest
    $query = ''
    $q = $rest.IndexOf('?')
    if ($q -ge 0) {
        $path = $rest.Substring(0, $q)
        $query = $rest.Substring($q + 1)
    }
    $path = $path.TrimEnd('/')
    if ($path -ne 'open') {
        return @{ Ok = $false; Code = $SCRIPT:EXIT_MALFORMED; Message = ('unsupported URI path: ' + $path) }
    }

    $params = Get-QueryParameters $query

    # Form 1: payload.
    if ($params.ContainsKey('d') -and -not [string]::IsNullOrEmpty($params['d'])) {
        $bytes = $null
        try {
            $bytes = ConvertFrom-Base64Url $params['d']
        } catch {
            return @{ Ok = $false; Code = $SCRIPT:EXIT_PAYLOAD; Message = ('payload is not valid base64url: ' + $_.Exception.Message) }
        }
        $json = [System.Text.Encoding]::UTF8.GetString($bytes)
        $payload = $null
        try {
            $payload = ConvertFrom-Json -InputObject $json
        } catch {
            return @{ Ok = $false; Code = $SCRIPT:EXIT_PAYLOAD; Message = 'payload is not valid JSON after decoding' }
        }
        $problem = Test-PayloadShape $payload
        if ($null -ne $problem) {
            return @{ Ok = $false; Code = $SCRIPT:EXIT_PAYLOAD; Message = $problem }
        }
        return @{ Ok = $true; Payload = $payload }
    }

    # Form 2: manual single item.
    if ($params.ContainsKey('url')) {
        $url = $params['url']
        if (-not (Test-AbsoluteUrl $url)) {
            return @{ Ok = $false; Code = $SCRIPT:EXIT_MALFORMED; Message = 'manual url parameter is not an absolute URL' }
        }
        $title = $null
        if ($params.ContainsKey('t')) { $title = $params['t'] }
        return @{ Ok = $true; Payload = (New-SimplePayload -Url $url -Title $title) }
    }

    return @{ Ok = $false; Code = $SCRIPT:EXIT_MALFORMED; Message = 'URI has neither a d nor a url parameter' }
}

# Returns $null when the payload is valid, otherwise a human-readable reason.
# Mirrors validate() in src/core/payload.js: version, item count vs n, absolute URLs.
function Test-PayloadShape {
    param($Payload)
    if ($null -eq $Payload) { return 'payload is not an object' }

    $v = Get-Prop $Payload 'v'
    if ($null -eq $v) { return 'payload has no version field' }
    if ([int]$v -ne 1) { return ('unsupported payload version ' + [string]$v + ' (this handler speaks 1)') }

    $items = Get-Prop $Payload 'items'
    if ($null -eq $items) { return 'payload has no items' }
    $list = @($items)
    if ($list.Count -eq 0) { return 'payload has no items' }

    $n = Get-Prop $Payload 'n'
    if ($null -ne $n) {
        if ([int]$n -ne $list.Count) {
            return ('payload is incomplete: it declares ' + [string]$n + ' items but contains ' + [string]$list.Count)
        }
    }

    foreach ($item in $list) {
        $u = Get-Prop $item 'u'
        if (-not (Test-AbsoluteUrl $u)) { return 'payload item is not an absolute URL' }
    }
    return $null
}

# ---------------------------------------------------------------------------
# M3U serialisation -- MUST match src/core/m3u.js byte-for-byte.
# ---------------------------------------------------------------------------

# oneLine(): a title is a single line by definition.
function ConvertToOneLine {
    param($Text)
    if ($null -eq $Text) { return '' }
    $t = [string]$Text
    $t = [regex]::Replace($t, '[\r\n\t]+', ' ')
    $t = [regex]::Replace($t, '\s{2,}', ' ')
    return $t.Trim()
}

# formatDuration(): the integer seconds, or -1 when unknown/non-positive.
# JS Math.round rounds halves toward +Infinity; Floor(v + 0.5) reproduces that.
function Format-Duration {
    param($Seconds)
    if ($null -eq $Seconds) { return '-1' }
    $v = 0.0
    if (-not [double]::TryParse([string]$Seconds, [ref]$v)) { return '-1' }
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v) -or $v -le 0) { return '-1' }
    $rounded = [Math]::Floor($v + 0.5)
    return ([int]$rounded).ToString()
}

function Format-Integer {
    param($Value)
    if ($null -eq $Value) { return '0' }
    $v = 0.0
    if (-not [double]::TryParse([string]$Value, [ref]$v)) { return '0' }
    $rounded = [Math]::Floor($v + 0.5)
    return ([int]$rounded).ToString()
}

function Build-M3uText {
    param($Payload)

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('#EXTM3U')

    $title = Get-Prop $Payload 'title'
    if (-not [string]::IsNullOrEmpty([string]$title)) {
        $lines.Add('#PLAYLIST:' + (ConvertToOneLine $title))
    }

    $opts = Get-Prop $Payload 'opts'
    $items = @(Get-Prop $Payload 'items')

    foreach ($item in $items) {
        $duration = Get-Prop $item 'd'
        $label    = Get-Prop $item 't'
        $url      = Get-Prop $item 'u'
        if ([string]::IsNullOrEmpty([string]$label)) { $label = $url }
        $lines.Add('#EXTINF:' + (Format-Duration $duration) + ',' + (ConvertToOneLine $label))

        $cache = Get-Prop $opts 'cache'
        if ($cache) {
            $lines.Add('#EXTVLCOPT:network-caching=' + (Format-Integer $cache))
        }
        $referrer = Get-Prop $opts 'referrer'
        if ($referrer) {
            $lines.Add('#EXTVLCOPT:http-referrer=' + (ConvertToOneLine $referrer))
        }
        $ua = Get-Prop $opts 'ua'
        if ($ua) {
            $lines.Add('#EXTVLCOPT:http-user-agent=' + (ConvertToOneLine $ua))
        }

        $lines.Add([string]$url)
    }

    # UTF-8 text with LF line endings: join with LF, terminate with LF.
    return (($lines -join "`n") + "`n")
}

# ---------------------------------------------------------------------------
# VLC discovery
# ---------------------------------------------------------------------------

function Find-VlcExecutable {
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrEmpty($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath) { return $ExplicitPath }
        return $null
    }

    $candidates = New-Object System.Collections.Generic.List[string]

    # Registry first: HKLM\SOFTWARE\VideoLAN\VLC (and the 32-bit view). The
    # installer writes InstallDir there; the exe is at <InstallDir>\vlc.exe.
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
    } catch {
        # Registry probing is best-effort; the well-known paths below cover it.
    }

    $pf = $env:ProgramFiles
    if (-not [string]::IsNullOrEmpty($pf)) {
        $candidates.Add((Join-Path (Join-Path $pf 'VideoLAN\VLC') 'vlc.exe'))
    }
    # 64-bit Windows exposes the 32-bit Program Files as an env var whose name
    # contains parentheses; ${env:...} is the only way to spell it.
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
# Playlist housekeeping
# ---------------------------------------------------------------------------

function Initialize-PlaylistDir {
    $base = Get-LocalBaseDir
    $SCRIPT:PlaylistDir = Join-Path $base 'playlists'
    if (-not [System.IO.Directory]::Exists($SCRIPT:PlaylistDir)) {
        [System.IO.Directory]::CreateDirectory($SCRIPT:PlaylistDir) | Out-Null
    }
}

function Remove-OldPlaylists {
    if (-not [System.IO.Directory]::Exists($SCRIPT:PlaylistDir)) { return }
    $cutoff = (Get-Date).AddDays(-7)
    try {
        Get-ChildItem -LiteralPath $SCRIPT:PlaylistDir -Filter '*.m3u' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoff } |
            ForEach-Object {
                try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { }
            }
    } catch { }
}

function New-PlaylistPath {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $rand  = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    $name  = 'bingetovlc-' + $stamp + '-' + $rand + '.m3u'
    return (Join-Path $SCRIPT:PlaylistDir $name)
}

# ---------------------------------------------------------------------------
# Help / Diagnostics
# ---------------------------------------------------------------------------

function Show-Help {
    $text = @'
bingetovlc-handler.ps1 -- protocol handler for vlc:// and bingetovlc://.

  powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden
      -ExecutionPolicy Bypass -File bingetovlc-handler.ps1 "<uri>"

ACCEPTED URIs
  vlc://open?d=<base64url json>                 full payload (main form)
  bingetovlc://open?d=<base64url json>          same, collision-free alias
  vlc://open?url=<encoded abs url>&t=<title>    manual single item
  vlc://<absolute url>                          bare convenience form
  Scheme case and a trailing slash on "open" are tolerated.

OPTIONS
  -SelfTest      decode the URI and print the exact M3U to stdout, then exit.
                 Does not launch VLC, does not touch the registry, does not
                 require Windows. This is what CI asserts against the vectors.
  -Diagnostics   print the VLC path found, registration state of both schemes,
                 the playlist directory, the last 20 log lines and the user.
  -KeepPlaylist  keep the generated .m3u after VLC exits (it holds a token).
  -VlcPath PATH  explicit path to vlc.exe.
  -Verbose       extra logging.
  -Help          this text.

EXIT CODES
  0 ok / 2 malformed URI / 3 bad payload / 4 VLC not found / 5 write failure
'@
    Write-Host $text
}

function Show-Diagnostics {
    Write-Host 'bingetovlc diagnostics'
    Write-Host ('  handler version : ' + $SCRIPT:HandlerVersion)
    Write-Host ('  current user    : ' + [System.Environment]::UserName)

    $vlc = Find-VlcExecutable -ExplicitPath $VlcPath
    if ($null -eq $vlc) { Write-Host '  vlc.exe         : NOT FOUND' }
    else { Write-Host ('  vlc.exe         : ' + $vlc) }

    foreach ($scheme in @('vlc', 'bingetovlc')) {
        $key = 'HKCU:\Software\Classes\' + $scheme
        if (Test-Path $key) {
            $cmd = ''
            try {
                $cmdKey = $key + '\shell\open\command'
                if (Test-Path $cmdKey) { $cmd = [string](Get-ItemProperty -Path $cmdKey -ErrorAction Stop).'(default)' }
            } catch { }
            Write-Host ('  scheme ' + $scheme.PadRight(11) + ': registered')
            Write-Host ('                     ' + $cmd)
        } else {
            Write-Host ('  scheme ' + $scheme.PadRight(11) + ': not registered')
        }
    }

    $base = Get-LocalBaseDir
    $playlistDir = Join-Path $base 'playlists'
    $logFile = Join-Path (Join-Path $base 'logs') 'handler.log'
    Write-Host ('  playlist dir    : ' + $playlistDir)
    Write-Host ('  log file        : ' + $logFile)

    Write-Host '  last 20 log lines:'
    if ([System.IO.File]::Exists($logFile)) {
        try {
            Get-Content -LiteralPath $logFile -Tail 20 | ForEach-Object { Write-Host ('    ' + $_) }
        } catch {
            Write-Host '    (could not read log)'
        }
    } else {
        Write-Host '    (no log yet)'
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ($Help) {
    Show-Help
    exit $SCRIPT:EXIT_OK
}

if ($SelfTest) {
    $result = Resolve-PlaylistPayload $Uri
    if (-not $result.Ok) {
        # In self-test we cannot log to disk; report on stderr and exit.
        [Console]::Error.WriteLine('bingetovlc: ' + (Protect-Secrets $result.Message))
        exit $result.Code
    }
    $m3u = Build-M3uText $result.Payload
    # Write the M3U as raw UTF-8 bytes to the standard output STREAM. Going
    # through [Console]::Out would encode with the console code page, which
    # mangles CJK when stdout is redirected (the unicode-and-punctuation vector).
    # Opening the stream and writing bytes is encoding-proof on .NET Framework
    # and .NET Core, Windows and Linux.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $bytes = $utf8.GetBytes($m3u)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
    exit $SCRIPT:EXIT_OK
}

Initialize-Logging
Initialize-PlaylistDir
Remove-OldPlaylists

if ($Diagnostics) {
    Show-Diagnostics
    exit $SCRIPT:EXIT_OK
}

Write-Log ('handler start (version ' + $SCRIPT:HandlerVersion + ')')

$result = Resolve-PlaylistPayload $Uri
if (-not $result.Ok) {
    Fail $result.Code (('URI rejected: ' + $result.Message))
}
$payload = $result.Payload

$itemCount = @(Get-Prop $payload 'items').Count
Write-VerboseLog ('payload accepted: ' + [string]$itemCount + ' item(s)')

$m3u = Build-M3uText $payload

$vlc = Find-VlcExecutable -ExplicitPath $VlcPath
if ($null -eq $vlc) {
    Fail $SCRIPT:EXIT_NOVLC 'vlc.exe was not found (pass -VlcPath or install VLC)'
}
Write-VerboseLog ('using vlc: ' + $vlc)

$playlistPath = New-PlaylistPath
try {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($playlistPath, $m3u, $encoding)
} catch {
    Fail $SCRIPT:EXIT_WRITE ('could not write playlist: ' + $_.Exception.Message)
}
Write-Log ('playlist written: ' + $playlistPath)

$opts = Get-Prop $payload 'opts'

$vlcArgs = New-Object System.Collections.Generic.List[string]
$vlcArgs.Add('--started-from-file')
if (Get-Prop $opts 'fs')   { $vlcArgs.Add('--fullscreen') }
if (Get-Prop $opts 'one')  { $vlcArgs.Add('--one-instance') }
if (Get-Prop $opts 'exit') { $vlcArgs.Add('--play-and-exit') }
$vlcArgs.Add('--no-video-title-show')

# opts.start is 1-based. VLC has no reliable, version-independent way to start
# an M3U at item N from the command line without side effects, so we refuse to
# guess and say so instead of silently starting the wrong episode.
if (Get-Prop $opts 'start') {
    Write-Log ('opts.start is set but is not supported by this handler; starting from the first item')
}

# The playlist path may contain spaces (LOCALAPPDATA). Start-Process joins the
# ArgumentList with spaces and does not quote elements, so quote it explicitly.
$vlcArgs.Add('"' + $playlistPath + '"')

$exitCode = $SCRIPT:EXIT_OK
try {
    Start-Process -FilePath $vlc -ArgumentList $vlcArgs.ToArray() -Wait
    Write-VerboseLog 'vlc exited'
} catch {
    Write-Log ('failed to launch vlc: ' + $_.Exception.Message)
    $exitCode = $SCRIPT:EXIT_NOVLC
}

if ($KeepPlaylist) {
    Write-Log ('keeping playlist (-KeepPlaylist): ' + $playlistPath)
} else {
    try {
        if ([System.IO.File]::Exists($playlistPath)) { [System.IO.File]::Delete($playlistPath) }
        Write-VerboseLog 'playlist deleted'
    } catch {
        Write-Log ('could not delete playlist: ' + $_.Exception.Message)
    }
}

exit $exitCode