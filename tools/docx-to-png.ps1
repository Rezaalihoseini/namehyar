# Opens a .docx in the real Microsoft Word, saves it as PDF, and renders the pages to PNG with
# Windows' own PDF renderer. This is how the Word export is checked without trusting our own code.
#   powershell -File tools\docx-to-png.ps1 sample.docx out-folder
param([Parameter(Mandatory)][string]$Docx, [Parameter(Mandatory)][string]$OutDir, [switch]$PdfOnly, [int]$Width = 1000)

$ErrorActionPreference = 'Stop'
$Docx = (Resolve-Path $Docx).Path
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$pdf = Join-Path $OutDir ([IO.Path]::GetFileNameWithoutExtension($Docx) + '.pdf')

if ($Docx -notmatch '\.pdf$') {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try {
        $doc = $word.Documents.Open($Docx, $false, $true)
        "word pages: " + $doc.ComputeStatistics(2)
        "compatibility mode: " + $doc.CompatibilityMode
        # InvokeMember: PowerShell's own COM binder spins for minutes on this method's many optional arguments.
        $started = Get-Date
        [object[]]$exportArgs = [string]$pdf, [int]17
        [void][System.__ComObject].InvokeMember('ExportAsFixedFormat', [Reflection.BindingFlags]::InvokeMethod, $null, $doc, $exportArgs)
        "pdf export took: " + [math]::Round(((Get-Date) - $started).TotalSeconds, 1) + "s"
        [object[]]$closeArgs = , [int]0
        [void][System.__ComObject].InvokeMember('Close', [Reflection.BindingFlags]::InvokeMethod, $null, $doc, $closeArgs)
    } finally {
        [object[]]$quitArgs = , [int]0
        [void][System.__ComObject].InvokeMember('Quit', [Reflection.BindingFlags]::InvokeMethod, $null, $word, $quitArgs)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
} else { $pdf = $Docx }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait() }

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdf)) ([Windows.Storage.StorageFile])
$pdfDoc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
"pdf pages: " + $pdfDoc.PageCount
if ($PdfOnly) { return }
for ($i = 0; $i -lt $pdfDoc.PageCount; $i++) {
    $page = $pdfDoc.GetPage($i)
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = $Width
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $stream.Seek(0)
    $reader = New-Object Windows.Storage.Streams.DataReader($stream)
    [void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]))
    $bytes = New-Object byte[] $stream.Size
    $reader.ReadBytes($bytes)
    $png = Join-Path $OutDir ([IO.Path]::GetFileNameWithoutExtension($pdf) + "-p$($i + 1).png")
    [IO.File]::WriteAllBytes($png, $bytes)
    $png
    $page.Dispose()
}
