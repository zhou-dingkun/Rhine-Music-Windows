# Builds the Windows executable icon from the shared Rhine Lab mark.
# The mark itself is rasterised by scripts/build-icons.mjs into public/icons/icon-512.png,
# so this script only repackages those pixels into a multi-resolution .ico.
param(
  [string]$Source = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Source) { $Source = Join-Path $projectRoot 'public\icons\icon-512.png' }
if (-not $Output) { $Output = Join-Path $projectRoot 'assets\app-icon.ico' }

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Icon source not found: $Source (run node scripts/build-icons.mjs first)."
}

# Small sizes stay uncompressed DIB for maximum shell compatibility; the large sizes use PNG,
# which Vista and later read directly and which keeps the file small.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngFrom = 128

function New-IconImage([System.Drawing.Image]$sourceImage, [int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
  $graphics.Dispose()
  return $bitmap
}

function Get-DibBytes([System.Drawing.Bitmap]$bitmap, [int]$size) {
  $rectangle = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $bitmap.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $stride = $data.Stride
    $pixels = New-Object byte[] ($stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  } finally {
    $bitmap.UnlockBits($data)
  }

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  # BITMAPINFOHEADER: height is doubled because the icon stores XOR and AND masks.
  $writer.Write([int]40); $writer.Write([int]$size); $writer.Write([int]($size * 2))
  $writer.Write([int16]1); $writer.Write([int16]32); $writer.Write([int]0)
  $writer.Write([int]($stride * $size))
  $writer.Write([int]0); $writer.Write([int]0); $writer.Write([int]0); $writer.Write([int]0)
  for ($row = $size - 1; $row -ge 0; $row--) { $writer.Write($pixels, $row * $stride, $stride) }
  $maskStride = [int]([math]::Floor(($size + 31) / 32) * 4)
  $writer.Write((New-Object byte[] ($maskStride * $size)))
  $writer.Flush()
  return $stream.ToArray()
}

function Get-PngBytes([System.Drawing.Bitmap]$bitmap) {
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  return $stream.ToArray()
}

$sourceImage = [System.Drawing.Image]::FromFile($Source)
try {
  $images = @()
  foreach ($size in $sizes) {
    $bitmap = New-IconImage $sourceImage $size
    try {
      # Cast back to byte[]: PowerShell unrolls function output into Object[] otherwise.
      $payload = [byte[]]$(if ($size -ge $pngFrom) { Get-PngBytes $bitmap } else { Get-DibBytes $bitmap $size })
      $images += [pscustomobject]@{ Size = $size; Bytes = $payload }
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

New-Item -ItemType Directory -Force -Path (Split-Path $Output -Parent) | Out-Null
$iconStream = New-Object System.IO.MemoryStream
$iconWriter = New-Object System.IO.BinaryWriter($iconStream)
$iconWriter.Write([int16]0); $iconWriter.Write([int16]1); $iconWriter.Write([int16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($image in $images) {
  $dimension = if ($image.Size -ge 256) { 0 } else { $image.Size }
  $iconWriter.Write([byte]$dimension); $iconWriter.Write([byte]$dimension)
  $iconWriter.Write([byte]0); $iconWriter.Write([byte]0)
  $iconWriter.Write([int16]1); $iconWriter.Write([int16]32)
  $iconWriter.Write([int]$image.Bytes.Length); $iconWriter.Write([int]$offset)
  $offset += $image.Bytes.Length
}
foreach ($image in $images) {
  $bytes = [byte[]]$image.Bytes
  $iconWriter.Write($bytes, 0, $bytes.Length)
}
$iconWriter.Flush()
[System.IO.File]::WriteAllBytes($Output, $iconStream.ToArray())

$file = Get-Item -LiteralPath $Output
Write-Output ("Rhine Music icon: {0} ({1:N0} bytes, sizes {2})" -f $file.FullName, $file.Length, ($sizes -join '/'))
