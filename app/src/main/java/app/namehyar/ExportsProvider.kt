package app.namehyar

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/** Hands finished PDF and Word files to the app the user shares them with, one file at a time. */
class ExportsProvider : ContentProvider() {

    override fun onCreate() = true

    private fun fileOf(uri: Uri): File {
        val file = fileFor(context!!, uri.lastPathSegment ?: throw FileNotFoundException(uri.toString()))
        if (!file.exists()) throw FileNotFoundException(uri.toString())
        return file
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY)

    override fun getType(uri: Uri): String = when (uri.lastPathSegment?.substringAfterLast('.')) {
        "pdf" -> "application/pdf"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else -> "application/octet-stream"
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val file = fileOf(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns, 1).apply {
            addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) file.name else if (it == OpenableColumns.SIZE) file.length() else null })
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        fun fileFor(context: Context, name: String): File {
            val dir = File(context.cacheDir, "exports").apply { mkdirs() }
            return File(dir, File(name).name)
        }

        fun uriFor(context: Context, name: String): Uri =
            Uri.Builder().scheme("content").authority("${context.packageName}.exports").appendPath(File(name).name).build()
    }
}
