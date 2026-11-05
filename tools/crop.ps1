# Cuts the same stretch out of page images and stacks them, to compare details by eye. Positions are in millimetres on an A4 page.
#   powershell -File tools\crop.ps1 out.png x0 y0 x1 y1 a.png b.png ...
param([Parameter(Mandatory)][string]$Out, [double]$X0, [double]$Y0, [double]$X1, [double]$Y1, [Parameter(ValueFromRemainingArguments)][string[]]$Files)

Add-Type -AssemblyName System.Drawing
$crops = @()
foreach ($f in $Files) {
    $img = [System.Drawing.Image]::FromFile((Resolve-Path $f).Path)
    $k = $img.Width / 210.0
    $rect = New-Object System.Drawing.Rectangle ([int]($X0 * $k)), ([int]($Y0 * $k)), ([int](($X1 - $X0) * $k)), ([int](($Y1 - $Y0) * $k))
    $crop = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
    $g = [System.Drawing.Graphics]::FromImage($crop)
    $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $rect.Width, $rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $img.Dispose()
    $crops += $crop
}
[int]$w = ($crops | ForEach-Object { $_.Width } | Measure-Object -Maximum).Maximum
[int]$h = 0
foreach ($c in $crops) { $h += $c.Height + 12 }
$sheet = New-Object System.Drawing.Bitmap $w, ($h - 12)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear([System.Drawing.Color]::IndianRed)
[int]$y = 0
foreach ($c in $crops) {
    $g.DrawImage($c, 0, $y, $c.Width, $c.Height)
    $y += $c.Height + 12
    $c.Dispose()
}
$g.Dispose()
$sheet.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
$Out
