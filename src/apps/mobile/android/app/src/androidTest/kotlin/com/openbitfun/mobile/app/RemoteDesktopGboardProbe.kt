package com.openbitfun.mobile.app

import android.accessibilityservice.AccessibilityServiceInfo
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import java.io.Closeable
import java.io.File
import java.io.FileInputStream

/** Actual keyboard touches on the dedicated AVD. No account or input-connection replacement. */
internal class RemoteDesktopGboardProbe(private val await: (() -> Boolean) -> Unit) : Closeable {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation get() = instrumentation.uiAutomation
    private val oldFlags = automation.serviceInfo.flags
    private val oldEventTypes = automation.serviceInfo.eventTypes
    init {
        val avd = automation.executeShellCommand("getprop ro.boot.qemu.avd_name").use { descriptor ->
            FileInputStream(descriptor.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8).trim() }
        }
        assertEquals("Use only the dedicated synthetic AVD", "BitFun_RemoteDesktop_Probe", avd)
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = oldFlags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
        }
    }
    override fun close() {
        automation.serviceInfo = automation.serviceInfo.apply { flags = oldFlags; eventTypes = oldEventTypes }
    }
    fun tapKey(labels: Set<String>) {
        var items = JSONArray()
        var windows = JSONArray()
        var bounds: Rect? = null
        var imeBounds = Rect()
        val screen = automation.takeScreenshot()
        val display = try { Rect(0, 0, screen.width, screen.height) } finally { screen.recycle() }
        var previous: Rect? = null
        var stableAt = 0L
        fun visit(node: AccessibilityNodeInfo) {
            if (items.length() >= 200) return
            val rectangle = Rect(); node.getBoundsInScreen(rectangle)
            val text = node.text?.toString().orEmpty(); val description = node.contentDescription?.toString().orEmpty()
            if (items.length() < 200) items.put(JSONObject().put("text", text).put("description", description)
                .put("class", node.className?.toString()).put("bounds", rectangle.flattenToString()))
            if (node.packageName?.toString() == "com.google.android.inputmethod.latin"
                && node.isVisibleToUser && display.contains(rectangle) && imeBounds.contains(rectangle)
                && (text.lowercase() in labels || description.lowercase() in labels)
                && (bounds == null || rectangle.centerY() > bounds!!.centerY())) bounds = rectangle
            for (index in 0 until node.childCount) node.getChild(index)?.let(::visit)
        }
        try {
            await {
                items = JSONArray(); windows = JSONArray(); bounds = null
                for (window in automation.windows) {
                    val root = window.root
                    val frame = Rect(); window.getBoundsInScreen(frame)
                    windows.put(JSONObject().put("type", window.type).put("root", root != null).put("title", window.title?.toString())
                        .put("bounds", frame.flattenToString()))
                    if (window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) { imeBounds = frame; root?.let(::visit) }
                }
                // IME visibility precedes the end of its entrance animation.
                // Never tap an offscreen or still-moving accessibility rectangle.
                if (bounds != previous) { previous = bounds?.let(::Rect); stableAt = SystemClock.uptimeMillis() }
                bounds != null && SystemClock.uptimeMillis() - stableAt >= 100
            }
        } finally {
            File(instrumentation.targetContext.getExternalFilesDir(null), "remote-desktop-gboard-keyboard.json")
                .writeText(JSONObject().put("windows", windows).put("nodes", items).put("flags", automation.serviceInfo.flags)
                    .put("capabilities", automation.serviceInfo.capabilities).toString())
        }
        val rectangle = bounds ?: throw AssertionError("Expected key is absent from the owned Gboard accessibility tree")
        val time = SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val event = MotionEvent.obtain(time, SystemClock.uptimeMillis(), action, rectangle.exactCenterX(), rectangle.exactCenterY(), 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try { assertTrue(automation.injectInputEvent(event, true)) } finally { event.recycle() }
        }
    }
}
