package com.openbitfun.mobile.core.feature.remotedesktop

import com.openbitfun.mobile.core.protocol.RelayJson
import kotlinx.serialization.json.*
import kotlin.test.*

class RemoteDesktopSetupProtocolTest {
    @Test fun sourceSnapshotsPreserveSuspendedAndDrainStateWithoutMakingThemBindable() {
        val raw = json(STATE.replace("\"binding\"", "\"suspended\"").replace("\"cleanup_pending\":false", "\"cleanup_pending\":true"))
        val source = RemoteDesktopSetupProtocol.source(raw)
        assertEquals("boot:3", source.revision); assertTrue(source.suspended); assertTrue(source.cleanupPending)
        assertEquals("connection-1", source.attachment?.connection)
        assertFalse(source.streaming)
        assertTrue(RemoteDesktopSetupProtocol.source(json(STATE.replace("\"binding\"", "\"streaming\""))).streaming)
        assertReason(RemoteDesktopSetupFailure.CLEANUP_PENDING) { RemoteDesktopSetupProtocol.attachment(raw) }
        assertReason(RemoteDesktopSetupFailure.INVALID_RESPONSE) {
            RemoteDesktopSetupProtocol.attachment(json(STATE.replace("\"binding\"", "\"suspended\"")))
        }
    }
    @Test fun currentHostShapesAcceptUnknownAdditiveFields() {
        val probe = json(PROBE)
        RemoteDesktopSetupProtocol.requireSuccess(probe)
        RemoteDesktopSetupProtocol.requireView(probe)
        val directory = RemoteDesktopSetupProtocol.directory(json(DIRECTORY))
        assertEquals("boot:2", directory.revision)
        assertEquals(RemoteDesktopDisplayUi("display:opaque", 1512, 982), directory.displays.single())
        assertEquals(RemoteDesktopAttachment("attach-1", "connection-1", "display:opaque"), RemoteDesktopSetupProtocol.attachment(json(STATE)))
        RemoteDesktopSetupProtocol.requireSuccess(json("""{"error":null,"future":true}"""))
    }

    @Test fun viewAuthorizationAndMediaCapabilityAreBothRequired() {
        assertReason(RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED) {
            RemoteDesktopSetupProtocol.requireView(json(PROBE.replace("\"view\"", "\"device_approval_required\"")))
        }
        for (probe in listOf(PROBE.replace("read_only_video_v1", "future_video_v2"),
            PROBE.replace("[1]", "[2]"), PROBE.replace("[1]", "[\"1\"]"))) {
            assertReason(RemoteDesktopSetupFailure.UNSUPPORTED) { RemoteDesktopSetupProtocol.requireView(json(probe)) }
        }
    }

    @Test fun unavailableBackendReportsItsCauseEvenWhenVideoCapabilitiesAreEmpty() {
        for ((availability, reason) in listOf("permission_required" to RemoteDesktopSetupFailure.PERMISSION_REQUIRED,
            "media_backend_unavailable" to RemoteDesktopSetupFailure.BACKEND_UNAVAILABLE, "future_platform" to RemoteDesktopSetupFailure.UNSUPPORTED)) {
            val probe = json("""{"availability":"$availability","protocol_versions":[1],"capabilities":[],"authorization":"view"}""")
            assertReason(reason) { RemoteDesktopSetupProtocol.requireView(probe) }
        }
    }

    @Test fun directoriesDoNotInventRevisionsOrAcceptAmbiguousDisplayChoices() {
        for (directory in listOf(DIRECTORY.replace("\"state_revision\":\"boot:2\",", ""),
            DIRECTORY.replace("1512", "\"1512\""), DIRECTORY.replace("1512", "0"),
            DIRECTORY.replace("display:opaque", "bad\\nidentifier"),
            """{"state_revision":"boot:2","displays":[{"display_id":"same","width":1,"height":1},{"display_id":"same","width":2,"height":2}]}""")) {
            assertReason(RemoteDesktopSetupFailure.INVALID_RESPONSE) { RemoteDesktopSetupProtocol.directory(json(directory)) }
        }
        assertReason(RemoteDesktopSetupFailure.NO_DISPLAYS) { RemoteDesktopSetupProtocol.directory(json("""{"state_revision":"boot:2","displays":[]}""")) }
    }

    @Test fun hostErrorsStayDistinctAndNeverExposeRemoteText() {
        for ((code, reason) in listOf("stale_revision" to RemoteDesktopSetupFailure.STALE_REVISION,
            "attachment_busy" to RemoteDesktopSetupFailure.BUSY, "cleanup_pending" to RemoteDesktopSetupFailure.CLEANUP_PENDING,
            "authorization_expired" to RemoteDesktopSetupFailure.DEVICE_APPROVAL_REQUIRED, "future_error" to RemoteDesktopSetupFailure.HOST_REJECTED)) {
            val error = assertFailsWith<RemoteDesktopSetupException> {
                RemoteDesktopSetupProtocol.requireSuccess(json("""{"error":{"code":"$code","message":"private remote message","retryable":true}}"""))
            }
            assertEquals(reason, error.reason); assertFalse(error.toString().contains("private remote message"))
        }
        assertReason(RemoteDesktopSetupFailure.INVALID_RESPONSE) { RemoteDesktopSetupProtocol.requireSuccess(json("""{"error":true}""")) }
    }

    @Test fun attachmentSnapshotsRefuseCleanupInvalidShapesAndTerminalMediaErrors() {
        assertNull(RemoteDesktopSetupProtocol.attachment(json("""{"state":{"state_revision":"boot:2","busy":false,"cleanup_pending":false,"attachment":null}}""")))
        assertReason(RemoteDesktopSetupFailure.CLEANUP_PENDING) { RemoteDesktopSetupProtocol.attachment(json(STATE.replace("\"cleanup_pending\":false", "\"cleanup_pending\":true"))) }
        for (state in listOf(STATE.replace("\"cleanup_pending\":false,", ""),
            STATE.replace("\"cleanup_pending\":false", "\"cleanup_pending\":\"false\""),
            STATE.replace("\"binding\"", "\"future_phase\""), STATE.replace("connection-1", "bad\\nidentifier"))) {
            assertReason(RemoteDesktopSetupFailure.INVALID_RESPONSE) { RemoteDesktopSetupProtocol.attachment(json(state)) }
        }
        assertReason(RemoteDesktopSetupFailure.HOST_REJECTED) {
            RemoteDesktopSetupProtocol.attachment(json(STATE).let { JsonObject(it + ("media_error" to JsonPrimitive("capture_failed"))) })
        }
        for ((code, reason) in listOf("permission_required" to RemoteDesktopSetupFailure.PERMISSION_REQUIRED,
            "turn_credentials_expired" to RemoteDesktopSetupFailure.CREDENTIALS_EXPIRED)) {
            assertReason(reason) { RemoteDesktopSetupProtocol.attachment(JsonObject(json(STATE) + ("media_error" to JsonPrimitive(code)))) }
        }
    }

    @Test fun mediaPreparationAndOptionalLegacyBudgetAreDistinctFromActualSourceEvidence() {
        val preparing = RemoteDesktopSetupProtocol.media(json(STATE))
        assertNull(preparing.offer); assertFalse(preparing.sourceFirstFrame); assertFalse(preparing.answerAccepted)
        val reply = json(STATE).let { JsonObject(it + ("media" to json("""{"offer_sdp":"private-offer","answer_accepted":true,"source_first_frame":false,"force_relay":true,"credentials_remaining_ms":1234,"future":true}"""))) }
        val media = RemoteDesktopSetupProtocol.media(reply)
        assertEquals(1234, media.remainingMs); assertEquals("private-offer", media.offer); assertTrue(media.forceRelay)
        assertFalse(media.toString().contains("private-offer"))
        val legacy = JsonObject(reply + ("media" to JsonObject(reply["media"]!!.jsonObject - "credentials_remaining_ms")))
        assertNull(RemoteDesktopSetupProtocol.media(legacy).remainingMs)
    }

    @Test fun malformedMediaFlagsBudgetsAndOversizedUtf8OffersNeverReachTheRenderer() {
        val valid = json("""{"offer_sdp":"offer","answer_accepted":false,"source_first_frame":false,"force_relay":false}""")
        for (bad in listOf(JsonObject(valid + ("answer_accepted" to JsonPrimitive("false"))),
            JsonObject(valid + ("credentials_remaining_ms" to JsonPrimitive(-1))),
            JsonObject(valid + ("credentials_remaining_ms" to JsonPrimitive("1000"))),
            JsonObject(valid + ("offer_sdp" to JsonPrimitive("\u4f60".repeat(31 * 1024)))))) {
            assertReason(RemoteDesktopSetupFailure.INVALID_RESPONSE) {
                RemoteDesktopSetupProtocol.media(JsonObject(json(STATE) + ("media" to bad)))
            }
        }
    }

    private fun json(text: String): JsonObject = RelayJson.parseToJsonElement(text).jsonObject
    private fun assertReason(reason: RemoteDesktopSetupFailure, block: () -> Unit) {
        assertEquals(reason, assertFailsWith<RemoteDesktopSetupException>(block = block).reason)
    }
    companion object {
        private const val PROBE = """{"protocol_versions":[1],"availability":"ready","authorization":"view","capabilities":["read_only_video_v1","gathered_sdp_v1","future_v1"],"future":true}"""
        private const val DIRECTORY = """{"state_revision":"boot:2","displays":[{"display_id":"display:opaque","width":1512,"height":982,"future":true}]}"""
        private const val STATE = """{"state":{"state_revision":"boot:3","busy":true,"cleanup_pending":false,"attachment":{"attach_id":"attach-1","connection_id":"connection-1","display_id":"display:opaque","phase":"binding","future":true}},"future":true}"""
    }
}
