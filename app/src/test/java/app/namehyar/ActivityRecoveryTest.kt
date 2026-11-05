package app.namehyar

import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35, 36])
class ActivityRecoveryTest {
    @Test fun missingWebViewHistoryReloadsApplicationAfterRecreation() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).create(Bundle())
        try {
            assertEquals("https://appassets.androidplatform.net/index.html", controller.get().webView.url)
        } finally {
            controller.destroy()
        }
    }
}
