# Third-party components

The MIT license of this project covers its own code. These components keep their own licenses.

Paths are under `app/src/main/assets/web/`.

| Component | Version | License | License file |
|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 | `vendor/pdfjs/LICENSE` |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 6.1.2 | Apache-2.0 | `vendor/tesseract/LICENSE-tesseract.js-core` |
| [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) (`fas`) | | Apache-2.0 | `vendor/tesseract/LICENSE-tessdata` |
| [Vazirmatn](https://github.com/rastikerdar/vazirmatn) font | | SIL OFL 1.1 | `fonts/licenses/Vazirmatn-OFL.txt` |
| Tinos font | | see its file | `fonts/licenses/Tinos-LICENSE.txt` |

## Changes made to pdf.js

The pdf.js files in `vendor/pdfjs` have been changed by hand:

- `pdf.worker.min.js`: the lam-alef order in `runBidiTransform`; `actualText` is kept on the marked-content items of `getTextContent` and passed as a third argument on the `beginMarkedContentProps` operator; black ink alone (C=M=Y=0) stays neutral in `DeviceCmykCS`.
- `pdf.min.js`: `showText` asks `globalThis.__pdfTextPaint` whether to paint.

These changes have to be made again after any upgrade of pdf.js.

## B fonts

The fonts B Nazanin, B Titr, B Lotus and B Zar are not in this repository, because their files carry a copyright notice and no license to redistribute them. The code still refers to them by name. Without the files, Persian text is shown in Vazirmatn. Anyone who has these fonts can add them in the app's settings.
