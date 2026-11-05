# Passes a PDF through the app and puts three renders side by side:
# the PDF itself, the app's page made from it, and the Word file the app makes, opened in real Word.
#   powershell -File tools\pdf-check.ps1 in.pdf out-folder      (needs the preview server on port 8770)
param([Parameter(Mandatory)][string]$Pdf, [Parameter(Mandatory)][string]$OutDir)

$tools = $PSScriptRoot
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$source = Join-Path $OutDir 'source.pdf'
Copy-Item -LiteralPath $Pdf $source -Force
& node "$tools\import-test.js" $source $OutDir
& powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\docx-to-png.ps1" $source $OutDir | Out-Null
& powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\docx-to-png.ps1" (Join-Path $OutDir 'app-page.pdf') $OutDir | Out-Null
& powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\docx-to-png.ps1" (Join-Path $OutDir 'app-export.docx') $OutDir | Select-String 'word pages'
foreach ($n in 1, 2) {
    $a = Join-Path $OutDir "source-p$n.png"
    $b = Join-Path $OutDir "app-page-p$n.png"
    $c = Join-Path $OutDir "app-export-p$n.png"
    if ((Test-Path $a) -and (Test-Path $b) -and (Test-Path $c)) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File "$tools\side-by-side.ps1" (Join-Path $OutDir "three-p$n.png") $a $b $c
    }
}
exit 0
