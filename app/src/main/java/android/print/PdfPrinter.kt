package android.print

import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * Writes a WebView print job straight to a file, without Android's print screen.
 * It sits in this package because the two result callbacks can only be subclassed from here.
 */
class PdfPrinter(private val attributes: PrintAttributes) {

    fun write(adapter: PrintDocumentAdapter, file: File, onDone: (Boolean) -> Unit) {
        adapter.onStart()
        adapter.onLayout(null, attributes, null, object : PrintDocumentAdapter.LayoutResultCallback() {
            override fun onLayoutFinished(info: PrintDocumentInfo?, changed: Boolean) {
                val target = ParcelFileDescriptor.open(
                    file,
                    ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE,
                )
                val finish = { ok: Boolean ->
                    target.close()
                    adapter.onFinish()
                    onDone(ok)
                }
                adapter.onWrite(arrayOf(PageRange.ALL_PAGES), target, CancellationSignal(), object : PrintDocumentAdapter.WriteResultCallback() {
                    override fun onWriteFinished(pages: Array<out PageRange>?) {
                        finish(true)
                    }

                    override fun onWriteFailed(error: CharSequence?) {
                        finish(false)
                    }

                    override fun onWriteCancelled() {
                        finish(false)
                    }
                })
            }

            override fun onLayoutFailed(error: CharSequence?) {
                adapter.onFinish()
                onDone(false)
            }

            override fun onLayoutCancelled() {
                adapter.onFinish()
                onDone(false)
            }
        }, null)
    }
}
