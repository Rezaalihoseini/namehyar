# Renders the sample letter both ways and puts them side by side: Word on the left, the app's page engine on the right.
#   powershell -File tools\compare.ps1 out-folder [-Query "images&long"]
param([Parameter(Mandatory)][string]$OutDir, [string]$Query = 'images')

$tools = $PSScriptRoot
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

$flags = @($Query -split '&' | ForEach-Object { "--$_" })
& node "$tools\make-docx.js" "$OutDir\word.docx" @flags
& powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\docx-to-png.ps1" "$OutDir\word.docx" $OutDir
& node "$tools\chrome-pdf.js" "http://127.0.0.1:8770/tools/print-test.html?$Query" "$OutDir\engine.pdf"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\docx-to-png.ps1" "$OutDir\engine.pdf" $OutDir

Add-Type -AssemblyName System.Drawing
foreach ($w in Get-ChildItem "$OutDir\word-p*.png") {
    $n = $w.BaseName -replace 'word-p', ''
    $e = "$OutDir\engine-p$n.png"
    if (-not (Test-Path $e)) { "page $n exists only in Word"; continue }
    $a = [System.Drawing.Image]::FromFile($w.FullName)
    $b = [System.Drawing.Image]::FromFile($e)
    $bmp = New-Object System.Drawing.Bitmap ($a.Width + $b.Width + 20), ([math]::Max($a.Height, $b.Height))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::DarkGray)
    $g.DrawImage($a, 0, 0, $a.Width, $a.Height)
    $g.DrawImage($b, $a.Width + 20, 0, $b.Width, $b.Height)
    $g.Dispose(); $a.Dispose(); $b.Dispose()
    $bmp.Save("$OutDir\compare-p$n.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "$OutDir\compare-p$n.png"
}
exit 0
