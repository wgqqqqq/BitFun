package com.openbitfun.mobile.core.feature.account

import com.openbitfun.mobile.core.transport.CloudAccountDevice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class AccountDevicePolicyTest {
    @Test fun relayKindsSurviveTheUiMappingAndOverrideLegacyNames() {
        val devices = listOf(
            CloudAccountDevice("desktop", "HarmonyOS Phone", true, null, "desktop", false),
            CloudAccountDevice("cli", "HarmonyOS Phone", true, null, "cli"),
            CloudAccountDevice("legacy", "Office PC", false, 9),
        ).map { it.toAccountDeviceUi() }
        assertEquals(listOf("desktop", "cli", null), devices.map { it.deviceKind })
        assertEquals(devices, AccountDevicePolicy.controlTargets(devices, "self"))
        assertFalse(devices.first().controllable)
        assertEquals(9L, devices.last().lastSeenAt)
    }

    @Test fun explicitNonHostsAreNeverSelectableRegardlessOfName() {
        val devices = listOf(
            AccountDeviceUi("self", "My desktop", true, null, compatible = null, deviceKind = "desktop"),
            AccountDeviceUi("desktop", "HarmonyOS Phone", true, null, compatible = null, deviceKind = "desktop"),
            AccountDeviceUi("cli", "HarmonyOS Phone", true, null, compatible = null, deviceKind = "cli"),
            AccountDeviceUi("phone", "Office PC", true, null, compatible = null, deviceKind = "mobile"),
            AccountDeviceUi("watch", "Office PC", true, null, compatible = null, deviceKind = "watch"),
            AccountDeviceUi("future", "Office PC", true, null, compatible = null, deviceKind = "future"),
            AccountDeviceUi("offline", "Spare desktop", false, 9, compatible = null, deviceKind = "desktop"),
        )
        assertEquals(listOf("desktop", "cli", "offline"), AccountDevicePolicy.controlTargets(devices, "self").map { it.id })
        assertEquals(listOf("desktop", "cli"), devices.filter { AccountDevicePolicy.canSelect(it, "self") }.map { it.id })
        assertEquals("desktop", AccountDevicePolicy.preferredTarget(devices, "self")?.id)
    }

    @Test fun legacyConstructorsAndMissingKindsKeepWorking() {
        val legacy = AccountDeviceUi("legacy", "Office PC", true, null)
        val incompatible = AccountDeviceUi("old", "Old desktop", true, null, false)
        assertNull(legacy.deviceKind)
        assertNull(incompatible.deviceKind)
        assertFalse(incompatible.controllable)
        val offline = legacy.copy(id = "offline", online = false)
        val unknown = legacy.copy(id = "blank", deviceKind = " ")
        val devices = listOf(legacy, offline, unknown,
            legacy.copy(id = "phone", name = "HarmonyOS Phone"),
            legacy.copy(id = "watch", name = " HarmonyOS Watch "))
        assertEquals(listOf(legacy, offline, unknown), AccountDevicePolicy.controlTargets(devices, "self"))
        assertEquals(legacy, AccountDevicePolicy.preferredTarget(devices, "self"))
    }
}
