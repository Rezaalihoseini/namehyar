# Makes a realistic Persian letter in the real Microsoft Word, the way someone would on a laptop:
# a letterhead table in the header, styles, a numbered list, a merged table, a floating signature and a footer.
#   powershell -File tools\make-word-sample.ps1 out.docx
param([Parameter(Mandatory)][string]$Out)

$ErrorActionPreference = 'Stop'
$image = Join-Path $PSScriptRoot 'test-image.png'
$Out = [IO.Path]::GetFullPath($Out)
$flags = [Reflection.BindingFlags]

# PowerShell's own COM binder can spin for minutes on Word's many optional arguments, so everything goes through these.
# The leading comma stops PowerShell from unrolling a returned collection, such as Documents, into nothing.
function Raw([object[]]$a) { [object[]]@(foreach ($x in $a) { if ($null -eq $x) { $null } else { $x.PSObject.BaseObject } }) }
function Call($o, $name, [object[]]$a = @()) { , [System.__ComObject].InvokeMember($name, $flags::InvokeMethod, $null, $o.PSObject.BaseObject, (Raw $a)) }
function Get($o, $name, [object[]]$a = @()) { , [System.__ComObject].InvokeMember($name, ($flags::GetProperty -bor $flags::InvokeMethod), $null, $o.PSObject.BaseObject, (Raw $a)) }
function Put($o, $name, $v) { [void][System.__ComObject].InvokeMember($name, $flags::SetProperty, $null, $o.PSObject.BaseObject, (Raw @($v))) }

function StyleRange($r, $font, $size, $bold = 0) {
    $f = Get $r 'Font'
    Put $f 'NameBi' $font
    Put $f 'SizeBi' $size
    Put $f 'BoldBi' $bold
    Put $f 'Name' $font
    Put $f 'Size' $size
    Put $f 'Bold' $bold
}

function AddPara($doc, $text, $font, $size, $bold = 0, $align = 2, $after = 6) {
    $content = Get $doc 'Content'
    Call $content 'InsertParagraphAfter' | Out-Null
    $paras = Get $doc 'Paragraphs'
    $count = Get $paras 'Count'
    $p = Get $paras 'Item' @($count - 1)
    $r = Get $p 'Range'
    Call $r 'InsertBefore' @($text) | Out-Null
    $r = Get $p 'Range'
    Put $p 'ReadingOrder' 0
    Put $p 'Alignment' $align
    Put $p 'SpaceAfter' $after
    Put $p 'SpaceBefore' 0
    StyleRange $r $font $size $bold
    return $p
}

$word = New-Object -ComObject Word.Application
Put $word 'Visible' $false
Put $word 'DisplayAlerts' 0
try {
    $docs = Get $word 'Documents'
    $doc = Call $docs 'Add'
    $sections = Get $doc 'Sections'
    $sec = Get $sections 'Item' @(1)
    $setup = Get $sec 'PageSetup'
    Put $setup 'PaperSize' 7          # A4
    Put $setup 'TopMargin' 150
    Put $setup 'BottomMargin' 70
    Put $setup 'LeftMargin' 60
    Put $setup 'RightMargin' 60
    Put $setup 'HeaderDistance' 25

    # Letterhead: a borderless table in the Word header, with a line under it.
    $headers = Get $sec 'Headers'
    $hf = Get $headers 'Item' @(1)
    $hr = Get $hf 'Range'
    $tables = Get $doc 'Tables'
    $headerTables = Get $hr 'Tables'
    $t = Call $headerTables 'Add' @($hr, 1, 3)
    Put $t 'TableDirection' 0

    $c1 = Get $t 'Cell' @(1, 1)
    $c1r = Get $c1 'Range'
    Call $c1r 'InsertAfter' @('مرکز نمونه') | Out-Null
    StyleRange (Get $c1 'Range') 'B Titr' 10 1
    Put (Get $c1r 'ParagraphFormat') 'Alignment' 1

    $c2 = Get $t 'Cell' @(1, 2)
    $c2r = Get $c2 'Range'
    Call $c2r 'InsertAfter' @('بسمه تعالی') | Out-Null
    StyleRange (Get $c2 'Range') 'B Titr' 13 1
    Put (Get $c2r 'ParagraphFormat') 'Alignment' 1

    $c3 = Get $t 'Cell' @(1, 3)
    $c3r = Get $c3 'Range'
    Call $c3r 'InsertAfter' @("شماره: 1405/742`rتاریخ: 1405/08/13`rپیوست: دارد") | Out-Null
    StyleRange (Get $c3 'Range') 'B Nazanin' 11 0

    $borders = Get $t 'Borders'
    Put $borders 'Enable' 0
    $bottom = Get $borders 'Item' @(-3)
    Put $bottom 'LineStyle' 1

    # A logo in the first cell of the letterhead.
    $pic = Call (Get (Get $c1 'Range') 'InlineShapes') 'AddPicture' @($image, $false, $true, (Get $c1 'Range'))
    # Word refuses to resize a picture in a header story unless its window has laid the page out, and the natural size also works.
    try { Put $pic 'ScaleWidth' ([single]30); Put $pic 'ScaleHeight' ([single]30) } catch { }

    # The text of the letter.
    $content = Get $doc 'Content'
    Put (Get $content 'ParagraphFormat') 'ReadingOrder' 0
    [void](AddPara $doc 'جناب آقای دکتر سعیدی' 'B Titr' 12 1)
    [void](AddPara $doc 'رئیس محترم دانشگاه نمونه' 'B Titr' 12 1 2 8)
    [void](AddPara $doc 'موضوع: درخواست همکاری در برگزاری رویداد فناوری' 'B Titr' 12 1 2 8)
    [void](AddPara $doc 'با سلام و احترام،' 'B Lotus' 14 0)
    $body = AddPara $doc 'به استحضار می‌رساند مرکز نمونه در نظر دارد رویداد سالانهٔ فناوری را با حضور شرکت‌های دانش‌بنیان استان در تاریخ 1405/09/20 برگزار نماید. با توجه به سابقهٔ همکاری‌های مؤثر آن دانشگاه، خواهشمند است دستور فرمایید نسبت به معرفی نمایندهٔ تام‌الاختیار اقدام لازم معمول گردد.' 'B Lotus' 14 0 3
    Put $body 'LineSpacingRule' 1      # one and a half lines
    Put $body 'FirstLineIndent' 20

    # A sentence with mixed formatting.
    $mixed = AddPara $doc 'موارد زیر مورد نیاز است و هزینه‌ها مطابق جدول پیوست پرداخت می‌شود:' 'B Lotus' 14 0 3
    $mr = Get $mixed 'Range'
    $words = Get $mr 'Words'
    $w2 = Get $words 'Item' @(2)
    Put (Get $w2 'Font') 'BoldBi' 1
    Put (Get $w2 'Font') 'Bold' 1

    # A numbered list.
    $listStart = (Get (Get $doc 'Paragraphs') 'Count')
    $i1 = AddPara $doc 'اختصاص سالن همایش برای دو روز' 'B Lotus' 14
    $i2 = AddPara $doc 'معرفی پنج نفر از دانشجویان به عنوان همکار اجرایی' 'B Lotus' 14
    $i3 = AddPara $doc 'تأمین تجهیزات صوتی و تصویری' 'B Lotus' 14
    foreach ($item in $i1, $i2, $i3) { Call (Get (Get $item 'Range') 'ListFormat') 'ApplyNumberDefault' | Out-Null }

    # A table with a merged header cell.
    $content = Get $doc 'Content'
    Call $content 'InsertParagraphAfter' | Out-Null
    $paras = Get $doc 'Paragraphs'
    $last = Get $paras 'Item' @((Get $paras 'Count') - 1)
    $tr = Get $last 'Range'
    $data = Call $tables 'Add' @($tr, 4, 3)
    Put $data 'TableDirection' 0
    Put (Get $data 'Borders') 'Enable' 1
    $rows = @(
        @('شرح هزینه', 'مبلغ', ''),
        @('سالن', '20,000,000 ریال', 'روزانه'),
        @('پذیرایی', '35,000,000 ریال', 'کل دوره'),
        @('جمع', '55,000,000 ریال', '')
    )
    for ($r = 0; $r -lt 4; $r++) {
        for ($k = 0; $k -lt 3; $k++) {
            $cell = Get $data 'Cell' @(($r + 1), ($k + 1))
            $cr = Get $cell 'Range'
            Put $cr 'Text' $rows[$r][$k]
            StyleRange (Get $cell 'Range') 'B Nazanin' 12 $(if ($r -eq 0) { 1 } else { 0 })
            Put (Get (Get $cell 'Range') 'ParagraphFormat') 'Alignment' 1
        }
    }
    $merge = Get $data 'Cell' @(1, 2)
    Call $merge 'Merge' @((Get $data 'Cell' @(1, 3))) | Out-Null
    try { Put (Get (Get $data 'Rows') 'Item' @(1)) 'HeadingFormat' ([int]-1) } catch { }

    [void](AddPara $doc 'با تشکر از همکاری جناب‌عالی' 'B Lotus' 14 0 2 18)
    $name = AddPara $doc 'دکتر رضا محمدی' 'B Titr' 12 1 1 0
    Put $name 'RightIndent' 0
    Put $name 'LeftIndent' 0
    $title = AddPara $doc 'رئیس مرکز رشد' 'B Nazanin' 12 1 1 12
    [void](AddPara $doc 'رونوشت: معاونت پژوهشی دانشگاه جهت استحضار' 'B Nazanin' 11)
    [void](AddPara $doc 'بایگانی' 'B Nazanin' 11)

    # A floating signature picture beside the signer's name.
    $shapes = Get $doc 'Shapes'
    $nameRange = Get $name 'Range'
    [void](Call $shapes 'AddPicture' @($image, $false, $true, 230, -30, 60, 60, $nameRange))

    # Footer: an address and a page number field.
    $footers = Get $sec 'Footers'
    $ff = Get $footers 'Item' @(1)
    $fr = Get $ff 'Range'
    Put $fr 'Text' 'نشانی: خیابان نمونه - تلفن: 000-00000000'
    StyleRange (Get $ff 'Range') 'B Nazanin' 10 0
    Put (Get (Get $ff 'Range') 'ParagraphFormat') 'Alignment' 1
    Put (Get (Get $ff 'Range') 'ParagraphFormat') 'ReadingOrder' 0

    [object[]]$saveArgs = [string]$Out, [int]16
    [void][System.__ComObject].InvokeMember('SaveAs2', $flags::InvokeMethod, $null, $doc, $saveArgs)
    "saved: $Out, pages: " + (Call $doc 'ComputeStatistics' @(2))
    [object[]]$closeArgs = , [int]0
    [void][System.__ComObject].InvokeMember('Close', $flags::InvokeMethod, $null, $doc, $closeArgs)
} finally {
    [object[]]$quitArgs = , [int]0
    [void][System.__ComObject].InvokeMember('Quit', $flags::InvokeMethod, $null, $word, $quitArgs)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
