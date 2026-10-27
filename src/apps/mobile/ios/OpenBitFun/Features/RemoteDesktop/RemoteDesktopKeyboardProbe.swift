#if DEBUG && targetEnvironment(simulator)
import OpenBitFunMobileCore
import UIKit

/// UIKit preedit/lifecycle check only; no remote socket or OS input sink.
@MainActor
enum RemoteDesktopKeyboardProbe {
    private final class Host: RemoteDesktopControlHost {
        var controlSnapshot: RemoteDesktopControlUiState
        var intents: [RemoteDesktopControlIntent] = []
        init(_ value: RemoteDesktopControlUiState) { controlSnapshot = value }
        func controlIntent(_ value: RemoteDesktopControlIntent) { intents.append(value) }
        func controlReport(_ value: RemoteDesktopControlReportIntent) {}
    }
    static func run() async -> Bool {
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { return false }
        let id = RemoteDesktopMediaBindingUi(rendererId: "renderer", attachmentId: "attachment", connectionId: "connection")
        let authority = RemoteDesktopControlUiState(binding: id, supported: true, mode: .controlling, generation: "1", intentEpoch: 2,
            releasePending: false, failure: nil, textSupported: true)
        let host = Host(authority)
        let input = RemoteDesktopImeView(session: RemoteDesktopKeyboardSession(authority: authority), host: host, closed: {})
        input.frame = CGRect(x: 1, y: 1, width: 1, height: 1); window.addSubview(input)
        defer { input.retire(); input.removeFromSuperview() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        guard input.isFirstResponder else { return false }
        input.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        input.setMarkedText("\u{4e2d}", selectedRange: NSRange(location: 1, length: 0))
        guard host.intents.isEmpty else { return false }
        input.unmarkText()
        guard host.intents.count == 1, (host.intents[0] as? RemoteDesktopControlIntentTextCommit)?.text == "\u{4e2d}" else { return false }
        input.insertText("a"); input.deleteBackward(); input.insertText("\n")
        guard host.intents.count == 4, (host.intents[1] as? RemoteDesktopControlIntentTextCommit)?.text == "a",
              (host.intents[2] as? RemoteDesktopControlIntentKeyTap)?.key == .backspace,
              (host.intents[3] as? RemoteDesktopControlIntentKeyTap)?.key == .enter else { return false }
        input.setMarkedText("discard", selectedRange: NSRange(location: 7, length: 0))
        input.retire(); input.unmarkText(); input.insertText("late"); input.deleteBackward()
        guard host.intents.count == 4 else { return false }
        let next = RemoteDesktopImeView(session: RemoteDesktopKeyboardSession(authority: authority), host: host, closed: {})
        next.frame = input.frame; window.addSubview(next)
        defer { next.retire(); next.removeFromSuperview() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        guard next.isFirstResponder else { return false }
        next.setMarkedText("stale", selectedRange: NSRange(location: 5, length: 0))
        host.controlSnapshot = RemoteDesktopControlUiState(binding: id, supported: true, mode: .controlling, generation: "2", intentEpoch: 3,
            releasePending: false, failure: nil, textSupported: true)
        next.unmarkText(); next.insertText("late"); next.deleteBackward()
        guard host.intents.count == 4 else { return false }
        next.retire(); next.removeFromSuperview(); host.controlSnapshot = authority
        let closing = RemoteDesktopKeyboardSession(authority: authority)
        let pending = RemoteDesktopImeView(session: closing, host: host, closed: {})
        pending.frame = input.frame; window.addSubview(pending)
        defer { pending.retire(); pending.removeFromSuperview() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        guard pending.isFirstResponder else { return false }
        pending.setMarkedText("discard", selectedRange: NSRange(location: 7, length: 0))
        closing.retire() // UI closing intent wins before SwiftUI removes the editor.
        pending.unmarkText(); pending.insertText("late"); pending.deleteBackward()
        return host.intents.count == 4
    }
}
#endif
