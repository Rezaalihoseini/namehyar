package app.namehyar

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import android.content.Context

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35, 36])
class DocsDbTest {
    // SQLiteOpenHelper gained AutoCloseable after our minimum Android API;
    // call close explicitly instead of compiling Kotlin use() against API 36.
    private fun <T> withDb(context: Context, block: (DocsDb) -> T): T {
        val db = DocsDb(context)
        try { return block(db) } finally { db.close() }
    }

    @Test fun recoveryCheckpointSurvivesDatabaseReopen() {
        val context = RuntimeEnvironment.getApplication()
        val json = """{"id":"letter","body":[{"text":"آخرین واژه"}]}"""
        withDb(context) { it.put("drafts", "letter", json) }
        withDb(context) {
            assertEquals(json, it.get("drafts", "letter"))
            assertNull(it.get("letters", "letter"))
        }
    }

    @Test fun latestCheckpointReplacesEarlierVersionWithoutDuplicates() {
        withDb(RuntimeEnvironment.getApplication()) {
            it.put("drafts", "letter", """{"version":1}""")
            it.put("drafts", "letter", """{"version":2}""")
            assertEquals("""{"version":2}""", it.get("drafts", "letter"))
            assertEquals("""[{"version":2}]""", it.list("drafts"))
        }
    }

    @Test fun committingArchiveThenRemovingCheckpointKeepsArchive() {
        val context = RuntimeEnvironment.getApplication()
        withDb(context) {
            it.put("drafts", "letter", """{"text":"نسخهٔ بازیابی"}""")
            it.put("letters", "letter", """{"text":"نسخهٔ بازیابی"}""")
            it.delete("drafts", "letter")
        }
        withDb(context) {
            assertNull(it.get("drafts", "letter"))
            assertEquals("""{"text":"نسخهٔ بازیابی"}""", it.get("letters", "letter"))
        }
    }
}
