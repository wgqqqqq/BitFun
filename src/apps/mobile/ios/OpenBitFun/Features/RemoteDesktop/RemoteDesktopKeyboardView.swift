import OpenBitFunMobileCore
import SwiftUI
import UIKit

@MainActor
final class RemoteDesktopKeyboardSession: Identifiable {
    let id = UUID()
    let authority: RemoteDesktopControlUiState
    private var active = true
    init(authority: RemoteDesktopControlUiState) { self.authority = authority }
    func retire() { active = false }
    func matches(_ state: RemoteDesktopControlUiState) -> Bool {
        active && state.supported && state.textSupported && state.mode == .controlling && !state.releasePending
            && state.binding == authority.binding && state.intentEpoch == authority.intentEpoch && state.generation == authority.generation
    }
}

/// One native IME destination per explicit opening/lease, never a remote-text mirror.
struct RemoteDesktopKeyboardView: UIViewRepresentable {
    let session: RemoteDesktopKeyboardSession
    let host: any RemoteDesktopControlHost
    let closed: () -> Void
    func makeUIView(context: Context) -> RemoteDesktopImeView { RemoteDesktopImeView(session: session, host: host, closed: closed) }
    func updateUIView(_ view: RemoteDesktopImeView, context: Context) {}
    static func dismantleUIView(_ view: RemoteDesktopImeView, coordinator: ()) { view.retire() }
}

@MainActor
final class RemoteDesktopImeView: UITextView, UITextViewDelegate {
    private let session: RemoteDesktopKeyboardSession
    private weak var host: (any RemoteDesktopControlHost)?
    private let closed: () -> Void
    private var retired = false
    private var mutating = false
    private var observers: [NSObjectProtocol] = []
    init(session: RemoteDesktopKeyboardSession, host: any RemoteDesktopControlHost, closed: @escaping () -> Void) {
        self.session = session; self.host = host; self.closed = closed
        super.init(frame: .zero, textContainer: nil)
        delegate = self; clipsToBounds = true; isScrollEnabled = false
        backgroundColor = UIColor(MobileDesignColors.transparent)
        textColor = UIColor(MobileDesignColors.transparent); tintColor = UIColor(MobileDesignColors.transparent)
        isAccessibilityElement = false; accessibilityElementsHidden = true
        autocapitalizationType = .none; autocorrectionType = .no; spellCheckingType = .no
        smartQuotesType = .no; smartDashesType = .no; smartInsertDeleteType = .no
        keyboardType = .default; returnKeyType = .default
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.retire() })
        observers.append(center.addObserver(forName: UIWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let old = note.object as? UIWindow, old === self.window else { return }; self.retire()
        })
        observers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in if self?.isFirstResponder == true { self?.retire() } })
    }
    required init?(coder: NSCoder) { fatalError("Programmatic IME view required") }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { if isFirstResponder { retire() }; return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.retired, self.validAuthority, self.window?.isKeyWindow == true else { return }
            if !self.becomeFirstResponder() { self.retire() }
        }
    }
    private var validAuthority: Bool { host.map { session.matches($0.controlSnapshot) } == true }
    private var active: Bool { !retired && validAuthority && isFirstResponder && window?.isKeyWindow == true && UIApplication.shared.applicationState == .active }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }
    private func discard() {
        guard !mutating else { return }
        mutating = true; super.unmarkText(); text = ""; mutating = false
    }
    private func commit() {
        guard !mutating, active, markedTextRange == nil else { return }
        let value = text ?? ""; guard !value.isEmpty else { return }
        discard()
        if let intent = RemoteDesktopKeyboardIntentKt.remoteDesktopTextCommitIntent(authority: session.authority, text: value) { host?.controlIntent(intent) }
    }
    func textViewDidChange(_ textView: UITextView) { commit() }
    func textViewDidEndEditing(_ textView: UITextView) { retire() }
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        guard active else { return }
        mutating = true; super.setMarkedText(markedText, selectedRange: selectedRange); mutating = false
    }
    override func unmarkText() {
        guard active else { discard(); return }
        mutating = true; super.unmarkText(); mutating = false; commit()
    }
    override func insertText(_ text: String) {
        guard active else { return }
        if markedTextRange == nil && ["\n", "\r", "\r\n", "\t"].contains(text) {
            key(text == "\t" ? .tab : .enter); return
        }
        super.insertText(text); commit()
    }
    override func deleteBackward() {
        guard active else { return }
        if markedTextRange != nil || !(text ?? "").isEmpty { super.deleteBackward() }
        else { key(.backspace) }
    }
    private func key(_ key: RemoteDesktopKeyboardKey) {
        guard active, let binding = session.authority.binding, let generation = session.authority.generation else { return }
        host?.controlIntent(RemoteDesktopControlIntentKeyTap(binding: binding, intentEpoch: session.authority.intentEpoch, generation: generation, key: key))
    }
    func retire() {
        guard !retired else { return }
        retired = true // Invalidate before UIKit can unmark while resigning.
        session.retire()
        discard(); resignFirstResponder(); closed()
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}
