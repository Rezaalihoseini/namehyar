# Puts images next to each other so renders can be compared at a glance.
#   powershell -File tools\side-by-side.ps1 out.png a.png b.png c.png
param([Parameter(Mandatory)][string]$Out, [Parameter(ValueFromRemainingArguments)][string[]]$Files)

Add-Type -AssemblyName System.Drawing
$images = @()
[int]$width = 0
[int]$height = 0
foreach ($f in $Files) {
    $img = [System.Drawing.Image]::FromFile((Resolve-Path $f).Path)
    $images += $img
    $width += $img.Width + 20
    if ($img.Height -gt $height) { $height = $img.Height }
}
$bmp = New-Object System.Drawing.Bitmap ([int]($width - 20)), $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::DarkGray)
[int]$x = 0
foreach ($img in $images) {
    $g.DrawImage($img, $x, 0, $img.Width, $img.Height)
    $x += $img.Width + 20
    $img.Dispose()
}
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$Out
