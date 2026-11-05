package app.namehyar

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** Letters, recipients and settings as JSON documents in SQLite. */
class DocsDb(context: Context) : SQLiteOpenHelper(context, "namehyar.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE docs (coll TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (coll, id))",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun put(coll: String, id: String, json: String) {
        val values = ContentValues().apply {
            put("coll", coll)
            put("id", id)
            put("json", json)
            put("updated", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("docs", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun get(coll: String, id: String): String? =
        readableDatabase.rawQuery("SELECT json FROM docs WHERE coll = ? AND id = ?", arrayOf(coll, id)).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    fun delete(coll: String, id: String) {
        writableDatabase.delete("docs", "coll = ? AND id = ?", arrayOf(coll, id))
    }

    /** All documents of a collection as one JSON array; each row is already valid JSON. */
    fun list(coll: String): String =
        readableDatabase.rawQuery("SELECT json FROM docs WHERE coll = ?", arrayOf(coll)).use { c ->
            buildString {
                append('[')
                var first = true
                while (c.moveToNext()) {
                    if (!first) append(',')
                    append(c.getString(0))
                    first = false
                }
                append(']')
            }
        }
}
