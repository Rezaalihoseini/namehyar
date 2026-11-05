package app.namehyar

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import kotlin.concurrent.thread

/** Hosts the app's pages, which ship inside the APK and are served from assets; nothing is loaded from the network. */
class MainActivity : Activity() {

    lateinit var webView: WebView
        private set

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: PendingSave? = null
    private var pendingFile: String? = null
    private lateinit var rootView: FrameLayout

    var pendingFileName = ""
        private set

    private class PendingSave(val callbackId: String, val source: File)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView = WebView(this)
        rootView = FrameLayout(this)
        rootView.addView(webView, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        setContentView(rootView)
        fitToSystemBars(rootView)
        applyBars(getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_DARK, isSystemDark()))

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            // Page text must not follow the phone's font size setting: the letter is measured in real units.
            textZoom = 100
            // Small print stays as small as it is on the paper, instead of being raised to Android's smallest reading size.
            minimumFontSize = 1
            minimumLogicalFontSize = 1
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            safeBrowsingEnabled = false
            setGeolocationEnabled(false)
        }
        webView.webViewClient = AssetClient()
        webView.webChromeClient = ChromeClient()
        webView.addJavascriptInterface(NativeBridge(this), "NamehyarNative")

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }

        if (savedInstanceState == null) webView.loadUrl("https://$HOST/index.html")
        else webView.restoreState(savedInstanceState)
        receiveFile(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveFile(intent)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        webView.evaluateJavascript("window.__onSystemTheme && window.__onSystemTheme()", null)
    }

    fun isSystemDark(): Boolean =
        resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    /** Colours everything around the page to match its theme, including the status and navigation bars. */
    fun applyBars(dark: Boolean) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_DARK, dark).apply()
        val color = if (dark) DARK_SURFACE else Color.WHITE
        rootView.setBackgroundColor(color)
        webView.setBackgroundColor(color)
        window.setBackgroundDrawable(ColorDrawable(color))
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = color
            window.navigationBarColor = color
        }
        if (Build.VERSION.SDK_INT >= 30) {
            val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else lightBars, lightBars)
        } else {
            @Suppress("DEPRECATION")
            run {
                val flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                val decor = window.decorView
                decor.systemUiVisibility = if (dark) decor.systemUiVisibility and flags.inv() else decor.systemUiVisibility or flags
            }
        }
    }

    /** Reads a Word file that another app sent here. The page asks for it when it is ready, or is told now if it already is. */
    private fun receiveFile(intent: Intent?) {
        val uri = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            }
            else -> null
        } ?: return
        intent?.action = Intent.ACTION_MAIN
        thread {
            try {
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@thread
                pendingFileName = displayName(uri)
                pendingFile = Base64.encodeToString(bytes, Base64.NO_WRAP)
                webView.post { webView.evaluateJavascript("window.__fileArrived && window.__fileArrived()", null) }
            } catch (e: Exception) {
                Log.w("Namehyar", "could not read the shared file", e)
            }
        }
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0)?.let { return it }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "letter.docx"
    }

    fun takePendingFile(): String? = pendingFile.also { pendingFile = null }

    private fun fitToSystemBars(root: FrameLayout) {
        if (Build.VERSION.SDK_INT < 30) return
        window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { view, insets ->
            // The keyboard is included, so the page shrinks and the toolbar sits right above the keyboard.
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    private fun handleBack() {
        webView.evaluateJavascript("window.__onBack ? window.__onBack() : false") { result ->
            if (result != "true") finish()
        }
    }

    @Deprecated("Used below API 33 only")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        handleBack()
    }

    /** Runs window.__nativeDone(id, ok, data) in the page, which settles the waiting promise. */
    fun notifyPage(callbackId: String, ok: Boolean, data: String) {
        val script = "window.__nativeDone(${JSONObject.quote(callbackId)},$ok,${JSONObject.quote(data)})"
        webView.post { webView.evaluateJavascript(script, null) }
    }

    /** Android below 10 has no direct Downloads access without a permission, so the system's save screen is used. */
    fun askWhereToSave(callbackId: String, source: File, mime: String) {
        pendingSave = PendingSave(callbackId, source)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, source.name)
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQUEST_SAVE)
    }

    @Deprecated("Activity without AndroidX has no newer result API")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQUEST_PICK -> {
                fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                fileCallback = null
            }
            REQUEST_SAVE -> {
                val save = pendingSave ?: return
                pendingSave = null
                val target = data?.data
                if (resultCode != RESULT_OK || target == null) {
                    notifyPage(save.callbackId, true, "")
                    return
                }
                try {
                    contentResolver.openOutputStream(target)?.use { out -> save.source.inputStream().use { it.copyTo(out) } }
                    notifyPage(save.callbackId, true, save.source.name)
                } catch (e: IOException) {
                    notifyPage(save.callbackId, false, e.message ?: "save failed")
                }
            }
        }
    }

    private inner class ChromeClient : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            // With several file types the system's default picker keeps only the first, which hides Word files saved under a generic type.
            val types = params.acceptTypes.filter { it.isNotBlank() }
            val picker = if (types.size > 1) {
                Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            } else {
                params.createIntent()
            }
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(picker, REQUEST_PICK)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            Log.d("Namehyar", "${message.message()} [${message.sourceId()}:${message.lineNumber()}]")
            return true
        }
    }

    private inner class AssetClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            request.url.host != HOST

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url
            if (url.host != HOST) return empty(403, "Forbidden")
            val path = url.path?.takeIf { it != "/" } ?: "/index.html"
            return try {
                WebResourceResponse(mimeOf(path), if (isText(path)) "utf-8" else null, 200, "OK", HEADERS, assets.open("web$path"))
            } catch (e: IOException) {
                empty(404, "Not Found")
            }
        }

        private fun empty(code: Int, reason: String) =
            WebResourceResponse("text/plain", "utf-8", code, reason, HEADERS, ByteArrayInputStream(ByteArray(0)))

        private fun isText(path: String) = path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css")

        private fun mimeOf(path: String) = when (path.substringAfterLast('.')) {
            "html" -> "text/html"
            "js" -> "text/javascript"
            "css" -> "text/css"
            "ttf" -> "font/ttf"
            "woff2" -> "font/woff2"
            "png" -> "image/png"
            else -> "application/octet-stream"
        }
    }

    companion object {
        // A host Android reserves for apps serving their own content, so it can never reach a real website.
        const val HOST = "appassets.androidplatform.net"
        private val HEADERS = mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store")
        private const val REQUEST_PICK = 1
        private const val REQUEST_SAVE = 2
        private const val PREFS = "namehyar"
        private const val PREF_DARK = "dark"
        private const val DARK_SURFACE = 0xFF1A1F27.toInt()
    }
}
