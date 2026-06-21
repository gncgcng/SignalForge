Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root "public\icons"
$sourcePath = Join-Path $icons "signalforge-brand-source.jpeg"

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Missing permanent brand source: $sourcePath"
}

$source = [System.Drawing.Bitmap]::FromFile($sourcePath)

try {
  $minX = $source.Width
  $minY = $source.Height
  $maxX = -1
  $maxY = -1

  # The supplied asset is a white mark on black. Ignore low-level JPEG noise
  # while locating the exact visible mark.
  for ($y = 0; $y -lt $source.Height; $y++) {
    for ($x = 0; $x -lt $source.Width; $x++) {
      $pixel = $source.GetPixel($x, $y)
      if ([Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B)) -ge 96) {
        $minX = [Math]::Min($minX, $x)
        $minY = [Math]::Min($minY, $y)
        $maxX = [Math]::Max($maxX, $x)
        $maxY = [Math]::Max($maxY, $y)
      }
    }
  }

  if ($maxX -lt 0 -or $maxY -lt 0) {
    throw "Could not locate the logo mark in $sourcePath"
  }

  $markWidth = $maxX - $minX + 1
  $markHeight = $maxY - $minY + 1
  $markSize = [Math]::Max($markWidth, $markHeight)
  $cropSize = [Math]::Ceiling($markSize * 1.5)
  $centerX = ($minX + $maxX) / 2
  $centerY = ($minY + $maxY) / 2
  $cropX = [Math]::Max(0, [Math]::Round($centerX - ($cropSize / 2)))
  $cropY = [Math]::Max(0, [Math]::Round($centerY - ($cropSize / 2)))
  $cropSize = [Math]::Min(
    $cropSize,
    [Math]::Min($source.Width - $cropX, $source.Height - $cropY)
  )
  $sourceRect = [System.Drawing.Rectangle]::new($cropX, $cropY, $cropSize, $cropSize)

  $outputs = @(
    @{ Name = "favicon-16x16.png"; Size = 16; Inset = 0 },
    @{ Name = "favicon-32x32.png"; Size = 32; Inset = 0 },
    @{ Name = "apple-touch-icon.png"; Size = 180; Inset = 0 },
    @{ Name = "android-chrome-192x192.png"; Size = 192; Inset = 0 },
    @{ Name = "android-chrome-512x512.png"; Size = 512; Inset = 0 },
    @{ Name = "maskable-icon-512x512.png"; Size = 512; Inset = 72 }
  )

  foreach ($output in $outputs) {
    $bitmap = [System.Drawing.Bitmap]::new(
      $output.Size,
      $output.Size,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )

    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

        $destination = [System.Drawing.Rectangle]::new(
          $output.Inset,
          $output.Inset,
          $output.Size - ($output.Inset * 2),
          $output.Size - ($output.Inset * 2)
        )
        $graphics.DrawImage(
          $source,
          $destination,
          $sourceRect.X,
          $sourceRect.Y,
          $sourceRect.Width,
          $sourceRect.Height,
          [System.Drawing.GraphicsUnit]::Pixel
        )
      } finally {
        $graphics.Dispose()
      }

      $outputPath = Join-Path $icons $output.Name
      $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $source.Dispose()
}
