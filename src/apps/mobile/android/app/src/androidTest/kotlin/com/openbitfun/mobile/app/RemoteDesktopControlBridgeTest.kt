package com.openbitfun.mobile.app

import android.view.ViewConfiguration
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopControlBridge
import com.openbitfun.mobile.app.ui.remote.RemoteDesktopControlHost
import com.openbitfun.mobile.core.feature.remotedesktop.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Native Handler/execution boundary with a memory sink; no account or OS input. */
class RemoteDesktopControlBridgeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val binding = RemoteDesktopMediaBindingUi("renderer", "attachment", "connection")
    private val authority = RemoteDesktopControlUiState(binding, true, RemoteDesktopControlMode.CONTROLLING, "9", 7, false, null)
    private inner class Fixture {
        var state = authority
        val intents = mutableListOf<RemoteDesktopControlIntent>()
        val bodies = mutableListOf<JSONObject>()
        var failures = 0
        val bridge = RemoteDesktopControlBridge(object : RemoteDesktopControlHost {
            override fun state() = state
            override fun dispatch(intent: RemoteDesktopControlIntent) { intents += intent }
            override fun report(intent: RemoteDesktopControlReportIntent) { error("Unexpected report") }
        }, { script, callback ->
            Regex("r.accept\\((.*?)\\);").findAll(script).forEach { bodies += JSONObject(it.groupValues[1]).getJSONObject("body") }
            callback("true")
        }, {}, { failures++ }, ViewConfiguration.get(instrumentation.targetContext), 2f, {})
        init {
            bridge.render(RemoteDesktopMediaUiState("renderer", "attachment", "connection", "", emptyList(), true, true, false, true))
            bridge.sdkSupported(true); bridge.focusChanged(true); bridge.geometry(1600, 900); bridge.viewport(400, 800); bridge.sync(state)
        }
    }
    @Test fun adjacentMovesCoalesceButButtonEdgesAndWheelKeepTheirOrder() {
        instrumentation.runOnMainSync {
            val f = Fixture()
            try {
                f.bridge.command(RemoteDesktopControlRendererIntent.Tap(binding, 7, "9", 0.5, 0.5, RemoteDesktopPointerButton.RIGHT))
                f.bridge.command(RemoteDesktopControlRendererIntent.PointerButton(binding, 7, "9", 0.5, 0.5, RemoteDesktopPointerButton.LEFT, true))
                f.bridge.command(RemoteDesktopControlRendererIntent.PointerMove(binding, 7, "9", 0.6, 0.6))
                f.bridge.command(RemoteDesktopControlRendererIntent.PointerMove(binding, 7, "9", 0.7, 0.7))
                f.bridge.command(RemoteDesktopControlRendererIntent.PointerButton(binding, 7, "9", 0.7, 0.7, RemoteDesktopPointerButton.LEFT, false))
                f.bridge.command(RemoteDesktopControlRendererIntent.Wheel(binding, 7, "9", 0.5, 0.5, -12.0, 34.0))
                assertEquals(listOf("pointer_button", "pointer_button", "pointer_button", "pointer_move", "pointer_button", "wheel"), f.bodies.map { it.getString("kind") })
                assertEquals(listOf("right", "right", "left", "left"), f.bodies.filter { it.getString("kind") == "pointer_button" }.map { it.getJSONObject("body").getString("button") })
                assertEquals(0.7, f.bodies[3].getJSONObject("body").getDouble("x"), 0.0)
                assertEquals(0, f.failures)
            } finally { f.bridge.close() }
        }
    }
    @Test fun focusLossDiscardsQueuedMovesAndRetiredViewCannotReleaseASuccessor() {
        instrumentation.runOnMainSync {
            val f = Fixture()
            f.bridge.command(RemoteDesktopControlRendererIntent.PointerMove(binding, 7, "9", 0.7, 0.7))
            f.bridge.focusChanged(false)
            assertFalse(f.bridge.permits("renderer", "attachment", "connection", "7", "9", "pointer"))
            assertEquals(listOf(RemoteDesktopControlIntent.Release(binding, 7)), f.intents)
            assertTrue(f.bodies.isEmpty())
            f.intents.clear(); f.state = authority.copy(binding = binding.copy(connectionId = "successor"), intentEpoch = 8)
            f.bridge.focusChanged(false); assertTrue(f.intents.isEmpty())
            f.bridge.close(); f.bridge.focusChanged(false); assertTrue(f.intents.isEmpty())
        }
        instrumentation.waitForIdleSync()
    }
    @Test fun staleEpochGenerationOrConnectionCannotSendGestureCommands() {
        instrumentation.runOnMainSync {
            val f = Fixture()
            try {
                f.bridge.command(RemoteDesktopControlRendererIntent.PointerButton(binding, 6, "9", 0.5, 0.5, RemoteDesktopPointerButton.LEFT, true))
                f.bridge.command(RemoteDesktopControlRendererIntent.Wheel(binding.copy(connectionId = "old"), 7, "9", 0.5, 0.5, 1.0, 2.0))
                f.bridge.command(RemoteDesktopControlRendererIntent.PointerButton(binding, 7, "8", 0.5, 0.5, RemoteDesktopPointerButton.LEFT, true))
                assertTrue(f.bodies.isEmpty()); assertEquals(0, f.failures)
                assertEquals(listOf(RemoteDesktopControlIntent.Release(binding, 7)), f.intents)
            } finally { f.bridge.close() }
        }
    }
}
