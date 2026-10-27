package com.openbitfun.mobile.core.feature.account

/**
 * Which of an account's registered devices can be driven from this one.
 *
 * The transport filters host rows by Relay kind. Preserve that fact at the UI
 * seam: an explicit kind takes precedence over a display name. Only rows from
 * older Relays fall back to the known names of our phone/watch clients.
 * Desktop and CLI are session hosts; desktop capture/input still requires a
 * separate remote-desktop capability probe.
 */
public object AccountDevicePolicy {
    private val LEGACY_CONTROLLER_NAMES: Set<String> = setOf("HarmonyOS Phone", "HarmonyOS Watch")

    private fun isHost(device: AccountDeviceUi): Boolean {
        val kind = device.deviceKind?.trim().orEmpty()
        if (kind.isNotEmpty()) return kind == "desktop" || kind == "cli"
        return LEGACY_CONTROLLER_NAMES.none { it.equals(device.name.trim(), ignoreCase = true) }
    }

    /**
     * Session hosts, excluding this device. Unknown legacy rows remain visible.
     *
     * Offline devices stay in the list. They are what tells a user the desktop
     * they are looking for is known to the account and simply not running, which
     * is a different problem from it never having been paired.
     */
    public fun controlTargets(
        devices: List<AccountDeviceUi>,
        currentDeviceId: String,
    ): List<AccountDeviceUi> = devices.filter { device ->
        device.id != currentDeviceId && isHost(device)
    }

    /** Whether tapping [device] can do anything. */
    public fun canSelect(device: AccountDeviceUi, currentDeviceId: String): Boolean =
        device.online && device.id != currentDeviceId && isHost(device)

    /** The desktop protocol probes legacy rows; CLI is never a display source.
     * Generic session protocol compatibility does not authorize or reject this lane. */
    public fun canViewDesktop(device: AccountDeviceUi, currentDeviceId: String): Boolean =
        device.online && device.id != currentDeviceId && isHost(device)
            && device.deviceKind?.trim().orEmpty().let { it.isEmpty() || it == "desktop" }

    /**
     * The device to drive when the user has not picked one — after a fresh sign
     * in, where a list of one online desktop should not need a second tap.
     *
     * Null when nothing is online, rather than the first offline row: a target
     * that cannot answer is worse than no target, because the session list would
     * then fail against it instead of saying there is nowhere to look.
     */
    public fun preferredTarget(
        devices: List<AccountDeviceUi>,
        currentDeviceId: String,
    ): AccountDeviceUi? = controlTargets(devices, currentDeviceId).firstOrNull { it.online }
}
