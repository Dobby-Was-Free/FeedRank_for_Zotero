[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not $OutputPath) {
  # FeedRank plus the version, so a download folder holding several builds says which is
  # which without being opened. The version is read from manifest.json rather than
  # repeated here: two copies of a version number is one copy too many.
  $manifestPath = Join-Path $projectRoot 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'manifest.json is missing.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $version = [string]$manifest.version
  if (-not $version) { throw 'manifest.json has no version.' }
  $OutputPath = Join-Path $projectRoot ('dist\FeedRank-' + $version + '.xpi')
}
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$projectRootFullPath = [IO.Path]::GetFullPath($projectRoot)
$projectPrefix = $projectRootFullPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $outputFullPath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputPath must stay inside this project directory.'
}

$outputDirectory = Split-Path -Parent $outputFullPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}
if (Test-Path -LiteralPath $outputFullPath) {
  Remove-Item -LiteralPath $outputFullPath -Force
}

# Refuse to package a stale icon. logo.png has repeatedly reverted to the
# original 777x776 opaque source (414 KB) while the corrected file is 96x96 and
# under 10 KB, and Zotero renders it at 16-20 px, so a regression here is
# invisible in the XPI inventory but obvious in the UI. Fail the build instead.
function Assert-IconSanity([string]$Path, [string]$Label, [int]$ExpectedSize = 96, [int]$MaxBytes = 20000) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$Label is missing: $Path" }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 24) { throw "$Label is too small to be a PNG" }
  $signature = ($bytes[0..7] | ForEach-Object { $_.ToString('X2') }) -join ''
  if ($signature -ne '89504E470D0A1A0A') { throw "$Label is not a PNG" }
  # IHDR width/height are big-endian at offsets 16 and 20.
  $width = [int]$bytes[16] * 16777216 + [int]$bytes[17] * 65536 + [int]$bytes[18] * 256 + [int]$bytes[19]
  $height = [int]$bytes[20] * 16777216 + [int]$bytes[21] * 65536 + [int]$bytes[22] * 256 + [int]$bytes[23]
  $colorType = $bytes[25]
  if ($width -ne $ExpectedSize -or $height -ne $ExpectedSize) {
    throw ("$Label is ${width}x${height}; it must be ${ExpectedSize}x${ExpectedSize}. " +
      "Run 'node tools/make-ui-icons.js' to regenerate it.")
  }
  if ($colorType -ne 6) {
    throw "$Label must be RGBA (colour type 6) so its background can be transparent"
  }
  if ($bytes.Length -gt $MaxBytes) {
    throw ("$Label is $($bytes.Length) bytes; the limit for a ${ExpectedSize}x${ExpectedSize} icon is " +
      "$MaxBytes. Run 'node tools/make-ui-icons.js' to regenerate it.")
  }
  Write-Verbose "$Label ok: ${width}x${height}, RGBA, $($bytes.Length) bytes"
}

Assert-IconSanity (Join-Path $projectRoot 'chrome\content\logo.png') 'chrome/content/logo.png'
Assert-IconSanity (Join-Path $projectRoot 'chrome\content\favicon.png') 'chrome/content/favicon.png'

# The menu and pane icons are small, and a wrong or blurry one is the single most
# visible defect this add-on has had. They are derived from the supplied artwork
# by tools/make-ui-icons.js, so this checks only that the shipped files are the
# right size and format; the derivation itself is asserted by the test suite,
# which can compare pixels.
$contentRoot = Join-Path $projectRoot 'chrome\content'
Assert-IconSanity (Join-Path $contentRoot 'feedrank-menu.png') 'chrome/content/feedrank-menu.png' 16 4000
Assert-IconSanity (Join-Path $contentRoot 'feedrank-pane.png') 'chrome/content/feedrank-pane.png' 16 4000
Assert-IconSanity (Join-Path $contentRoot 'feedrank-pane-sidenav.png') 'chrome/content/feedrank-pane-sidenav.png' 20 4000

  # logo.png lives in chrome/content/ with the rest of the shipped images, so the recursive
  # chrome/ scan below picks it up; only the three package files are listed explicitly.
  $relativeFiles = @('manifest.json', 'chrome.manifest', 'bootstrap.js', 'LICENSE')
$chromeRoot = Join-Path $projectRoot 'chrome'
$relativeFiles += Get-ChildItem -LiteralPath $chromeRoot -Recurse -File |
  ForEach-Object { $_.FullName.Substring($projectRoot.Length).TrimStart([char[]]@('\', '/')) }
$localeRoot = Join-Path $projectRoot 'locale'
if (Test-Path -LiteralPath $localeRoot) {
  $relativeFiles += Get-ChildItem -LiteralPath $localeRoot -Recurse -File |
    ForEach-Object { $_.FullName.Substring($projectRoot.Length).TrimStart([char[]]@('\', '/')) }
}

$archive = [System.IO.Compression.ZipFile]::Open(
  $outputFullPath,
  [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  foreach ($relativePath in ($relativeFiles | Sort-Object)) {
    $sourcePath = Join-Path $projectRoot $relativePath
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $sourcePath,
      ($relativePath -replace '\\', '/'),
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
}
finally {
  $archive.Dispose()
}


# Reopen the artifact and compare every packaged file with its source. An archive that merely built
# is not an archive that is right, and the README says this is checked -- so it is checked here.
$verifyRoot = Join-Path $env:TEMP ("feedrank-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $verifyRoot | Out-Null
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($outputFullPath, $verifyRoot)
  $mismatched = @()
  $checked = 0
  Get-ChildItem -LiteralPath $verifyRoot -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($verifyRoot.Length + 1).Replace('\', '/')
    $sourcePath = Join-Path $projectRoot $relative
    $checked++
    if (-not (Test-Path -LiteralPath $sourcePath)) {
      $mismatched += "$relative (not in the source tree)"
    } elseif ((Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $sourcePath).Hash) {
      $mismatched += "$relative (differs from source)"
    }
  }
  if ($mismatched.Count -gt 0) {
    throw ('Packaged files do not match the source: ' + ($mismatched -join ', '))
  }
  Write-Output "Verified $checked packaged files byte for byte against the source."
}
finally {
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "Created $outputFullPath"
