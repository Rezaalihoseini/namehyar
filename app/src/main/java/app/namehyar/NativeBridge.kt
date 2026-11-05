package app.namehyar

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.print.PdfPrinter
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import java.io.File
import kotlin.concurrent.thread

/** What the page can ask Android to do: storage, PDF printing, sharing and saving. */
class NativeBridge(private val activity: MainActivity) {

    private val db = DocsDb(activity)
    private val mediaDir = File(activity.filesDir, "media").apply { mkdirs() }

    private fun mediaFile(id: String) = File(mediaDir, File(id).name)

    @JavascriptInterface
    fun dbPut(coll: String, id: String, json: String) = db.put(coll, id, json)

    @JavascriptInterface
    fun dbGet(coll: String, id: String): String? = db.get(coll, id)

    @JavascriptInterface
    fun dbDel(coll: String, id: String) = db.delete(coll, id)

    @JavascriptInterface
    fun dbList(coll: String): String = db.list(coll)

    @JavascriptInterface
    fun mediaPut(id: String, dataUrl: String) = mediaFile(id).writeText(dataUrl)

    @JavascriptInterface
    fun mediaGet(id: String): String? = mediaFile(id).takeIf { it.exists() }?.readText()

    @JavascriptInterface
    fun writeExport(fileName: String, base64: String) {
        ExportsProvider.fileFor(activity, fileName).writeBytes(Base64.decode(base64, Base64.DEFAULT))
    }

    @JavascriptInterface
    fun systemDark(): Boolean = activity.isSystemDark()

    @JavascriptInterface
    fun setDarkBars(dark: Boolean) {
        activity.runOnUiThread { activity.applyBars(dark) }
    }

    /** The Word file another app asked this one to open, as base64. It can be taken only once. */
    @JavascriptInterface
    fun takePendingFile(): String? = activity.takePendingFile()

    @JavascriptInterface
    fun pendingFileName(): String = activity.pendingFileName

    /** Prints the page's print view to a real PDF file. Falls back to Android's print screen if the direct route is blocked. */
    @JavascriptInterface
    fun exportPdf(callbackId: String, fileName: String, widthMils: Int, heightMils: Int) {
        activity.runOnUiThread {
            val attributes = PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize("namehyar_page", "page", widthMils, heightMils))
                .setResolution(PrintAttributes.Resolution("pdf", "pdf", 600, 600))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .build()
            val adapter = activity.webView.createPrintDocumentAdapter(fileName)
            try {
                PdfPrinter(attributes).write(adapter, ExportsProvider.fileFor(activity, fileName)) { ok ->
                    activity.notifyPage(callbackId, ok, if (ok) "file" else "pdf failed")
                }
            } catch (t: Throwable) {
                Log.w("Namehyar", "direct PDF route unavailable, using the print screen", t)
                (activity.getSystemService(Context.PRINT_SERVICE) as PrintManager).print(fileName, adapter, attributes)
                activity.notifyPage(callbackId, true, "system")
            }
        }
    }

    @JavascriptInterface
    fun share(fileName: String, mime: String) {
        val uri = ExportsProvider.uriFor(activity, fileName)
        val send = Intent(Intent.ACTION_SEND)
            .setType(mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri(fileName, uri)
        activity.runOnUiThread {
            activity.startActivity(Intent.createChooser(send, activity.getString(R.string.app_name)))
        }
    }

    @JavascriptInterface
    fun saveToDownloads(callbackId: String, fileName: String, mime: String) {
        val source = ExportsProvider.fileFor(activity, fileName)
        if (Build.VERSION.SDK_INT < 29) {
            activity.runOnUiThread { activity.askWhereToSave(callbackId, source, mime) }
            return
        }
        thread {
            try {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
                }
                val resolver = activity.contentResolver
                val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: error("could not create the file")
                resolver.openOutputStream(target)!!.use { out -> source.inputStream().use { it.copyTo(out) } }
                activity.notifyPage(callbackId, true, "Download/$FOLDER/$fileName")
            } catch (e: Exception) {
                activity.notifyPage(callbackId, false, e.message ?: "save failed")
            }
        }
    }

    private companion object {
        const val FOLDER = "Namehyar"
    }
}
