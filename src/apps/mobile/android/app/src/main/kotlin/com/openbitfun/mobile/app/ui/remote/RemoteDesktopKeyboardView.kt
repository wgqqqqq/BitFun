package com.openbitfun.mobile.app.ui.remote

import android.content.Context
import android.text.Editable
import android.text.SpannableStringBuilder
import android.text.Selection
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.text.InputType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.openbitfun.mobile.core.feature.remotedesktop.*

/** An IME destination, never a local editor or a mirror of remote text. */
@Composable
internal fun RemoteDesktopKeyboardView(authority: RemoteDesktopControlUiState,
    onIntent: (RemoteDesktopControlIntent) -> Unit, modifier: Modifier) {
    key(authority.binding, authority.intentEpoch, authority.generation) {
        AndroidView(modifier = modifier, factory = { context ->
            RemoteDesktopImeView(context, authority, onIntent)
        }, onRelease = { it.dispose() })
    }
}

/** Each InputConnection captures one lease. Late IME callbacks keep that stamp. */
internal class RemoteDesktopImeView(context: Context, private val authority: RemoteDesktopControlUiState,
    private val onIntent: (RemoteDesktopControlIntent) -> Unit) : View(context) {
    private var retired = false
    private var connection: RemoteInputConnection? = null
    private val inputMethod get() = context.getSystemService(InputMethodManager::class.java)
    init { isFocusable = true; isFocusableInTouchMode = true; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        post { if (!retired && isAttachedToWindow) { requestFocus(); inputMethod.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT) } }
    }
    override fun onCheckIsTextEditor(): Boolean = !retired && authority.textSupported
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        if (!onCheckIsTextEditor()) return null
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        outAttrs.initialSelStart = 0; outAttrs.initialSelEnd = 0; outAttrs.initialCapsMode = 0
        connection?.retire()
        return RemoteInputConnection().also { connection = it }
    }
    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (!hasWindowFocus) connection?.retire()
    }
    override fun onDetachedFromWindow() { dispose(); super.onDetachedFromWindow() }
    fun dispose() {
        if (retired) return
        retired = true; connection?.retire(); connection = null
        inputMethod.hideSoftInputFromWindow(windowToken, 0); clearFocus()
    }

    private inner class RemoteInputConnection : BaseInputConnection(this@RemoteDesktopImeView, true) {
        private val composing = SpannableStringBuilder().apply { Selection.setSelection(this, 0) }
        private var closed = false
        private fun active(): Boolean = !closed && !retired && hasWindowFocus() && isAttachedToWindow
            && ViewCompat.getRootWindowInsets(this@RemoteDesktopImeView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        override fun getEditable(): Editable = composing
        // The local preedit buffer does not describe the remote caret's context.
        // Explicit keyboard Shift still arrives unchanged in commitText.
        override fun getCursorCapsMode(reqModes: Int): Int = 0
        private fun discardComposition() { composing.clear(); composing.clearSpans(); Selection.setSelection(composing, 0) }
        fun retire() { closed = true; discardComposition() }
        override fun closeConnection() { retire(); super.closeConnection() }
        override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean =
            active() && super.setComposingText(text, newCursorPosition)
        override fun finishComposingText(): Boolean {
            // Hiding or retiring IME must not confirm an unchosen candidate.
            discardComposition(); return !closed
        }
        override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
            if (!active() || text == null) return false
            val value = text.toString()
            if (value.isEmpty()) { discardComposition(); return true }
            val control = when (value) {
                "\n", "\r", "\r\n" -> RemoteDesktopKeyboardKey.ENTER
                "\t" -> RemoteDesktopKeyboardKey.TAB
                else -> null
            }
            if (control != null) { discardComposition(); return key(control) }
            val intent = remoteDesktopTextCommitIntent(authority, value) ?: return false
            discardComposition()
            onIntent(intent)
            return true
        }
        private fun key(value: RemoteDesktopKeyboardKey): Boolean {
            if (!active()) return false
            val binding = authority.binding ?: return false
            val generation = authority.generation ?: return false
            onIntent(RemoteDesktopControlIntent.KeyTap(binding, authority.intentEpoch, generation, value)); return true
        }
        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            if (!active()) return false
            if (composing.isNotEmpty()) return super.deleteSurroundingText(beforeLength, afterLength)
            return when {
                beforeLength == 1 && afterLength == 0 -> key(RemoteDesktopKeyboardKey.BACKSPACE)
                beforeLength == 0 && afterLength == 1 -> key(RemoteDesktopKeyboardKey.DELETE)
                beforeLength == 0 && afterLength == 0 -> true
                else -> false // No local remote-text model from which to infer a range.
            }
        }
        override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
            if (composing.isNotEmpty()) super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
            else deleteSurroundingText(beforeLength, afterLength)
        override fun performEditorAction(editorAction: Int): Boolean = key(RemoteDesktopKeyboardKey.ENTER)
        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (!active()) return false
            val mapped = when (event.keyCode) {
                KeyEvent.KEYCODE_DEL -> RemoteDesktopKeyboardKey.BACKSPACE
                KeyEvent.KEYCODE_FORWARD_DEL -> RemoteDesktopKeyboardKey.DELETE
                KeyEvent.KEYCODE_ENTER -> RemoteDesktopKeyboardKey.ENTER
                KeyEvent.KEYCODE_TAB -> RemoteDesktopKeyboardKey.TAB
                KeyEvent.KEYCODE_ESCAPE -> RemoteDesktopKeyboardKey.ESCAPE
                KeyEvent.KEYCODE_DPAD_LEFT -> RemoteDesktopKeyboardKey.LEFT
                KeyEvent.KEYCODE_DPAD_RIGHT -> RemoteDesktopKeyboardKey.RIGHT
                KeyEvent.KEYCODE_DPAD_UP -> RemoteDesktopKeyboardKey.UP
                KeyEvent.KEYCODE_DPAD_DOWN -> RemoteDesktopKeyboardKey.DOWN
                else -> null
            }
            if (mapped != null) return event.action != KeyEvent.ACTION_DOWN || key(mapped)
            if (event.action != KeyEvent.ACTION_DOWN || event.isCtrlPressed || event.isAltPressed || event.isMetaPressed) return false
            val point = event.unicodeChar
            return point > 0 && Character.isValidCodePoint(point) && commitText(String(Character.toChars(point)), 1)
        }
    }
}
