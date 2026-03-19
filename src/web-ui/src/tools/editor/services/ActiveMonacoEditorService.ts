import * as monaco from 'monaco-editor';
import { createLogger } from '@/shared/utils/logger';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';

const log = createLogger('ActiveMonacoEditorService');

type MacosEditMenuMode = 'system' | 'monaco';
type EditMenuAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

const MENU_EVENT_ACTIONS: Array<{ eventName: string; action: EditMenuAction }> = [
  { eventName: 'bitfun_menu_edit_undo', action: 'undo' },
  { eventName: 'bitfun_menu_edit_redo', action: 'redo' },
  { eventName: 'bitfun_menu_edit_cut', action: 'cut' },
  { eventName: 'bitfun_menu_edit_copy', action: 'copy' },
  { eventName: 'bitfun_menu_edit_paste', action: 'paste' },
  { eventName: 'bitfun_menu_edit_select_all', action: 'selectAll' },
];

function isMacOSDesktop(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const isTauri = '__TAURI__' in window;
  return isTauri && typeof navigator.platform === 'string' && navigator.platform.toUpperCase().includes('MAC');
}

export class ActiveMonacoEditorService {
  private activeEditor: monaco.editor.IStandaloneCodeEditor | null = null;
  private registeredEditors = new Set<monaco.editor.IStandaloneCodeEditor>();
  private menuBridgePromise: Promise<void> | null = null;
  private lastRequestedMenuMode: MacosEditMenuMode | null = null;

  bindEditor(editor: monaco.editor.IStandaloneCodeEditor): () => void {
    if (!isMacOSDesktop()) {
      return () => {};
    }

    this.registeredEditors.add(editor);
    void this.ensureMacOSMenuBridge();

    if (editor.hasTextFocus()) {
      this.setActiveEditor(editor);
    }

    const focusDisposable = editor.onDidFocusEditorText(() => {
      this.setActiveEditor(editor);
    });

    const blurDisposable = editor.onDidBlurEditorText(() => {
      window.setTimeout(() => {
        if (this.activeEditor !== editor) {
          return;
        }

        if (editor.hasTextFocus()) {
          return;
        }

        this.activeEditor = null;
        void this.setMenuMode('system');
      }, 0);
    });

    return () => {
      focusDisposable.dispose();
      blurDisposable.dispose();
      this.unregisterEditor(editor);
    };
  }

  executeAction(action: EditMenuAction): boolean {
    const editor = this.getActiveEditor();
    if (!editor) {
      void this.setMenuMode('system');
      return false;
    }

    editor.focus();

    switch (action) {
      case 'undo':
        editor.trigger('macos-menu', 'undo', null);
        return true;
      case 'redo':
        editor.trigger('macos-menu', 'redo', null);
        return true;
      case 'cut':
        editor.trigger('macos-menu', 'editor.action.clipboardCutAction', null);
        return true;
      case 'copy':
        editor.trigger('macos-menu', 'editor.action.clipboardCopyAction', null);
        return true;
      case 'paste':
        editor.trigger('macos-menu', 'editor.action.clipboardPasteAction', null);
        return true;
      case 'selectAll':
        editor.trigger('macos-menu', 'editor.action.selectAll', null);
        return true;
      default:
        return false;
    }
  }

  private getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
    if (!this.activeEditor) {
      return null;
    }

    if (!this.registeredEditors.has(this.activeEditor)) {
      this.activeEditor = null;
      return null;
    }

    if (!this.activeEditor.getModel()) {
      this.activeEditor = null;
      return null;
    }

    return this.activeEditor;
  }

  private unregisterEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
    this.registeredEditors.delete(editor);

    if (this.activeEditor === editor) {
      this.activeEditor = null;
      void this.setMenuMode('system');
    }
  }

  private setActiveEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
    if (!this.registeredEditors.has(editor)) {
      this.registeredEditors.add(editor);
    }

    if (this.activeEditor === editor) {
      void this.setMenuMode('monaco');
      return;
    }

    this.activeEditor = editor;
    void this.setMenuMode('monaco');
  }

  private async ensureMacOSMenuBridge(): Promise<void> {
    if (!isMacOSDesktop()) {
      return;
    }

    if (this.menuBridgePromise) {
      return this.menuBridgePromise;
    }

    this.menuBridgePromise = (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        await Promise.all(
          MENU_EVENT_ACTIONS.map(async ({ eventName, action }) =>
            listen(eventName, () => {
              this.executeAction(action);
            })
          )
        );
      } catch (error) {
        log.warn('Failed to initialize macOS Monaco menu bridge', { error });
        this.menuBridgePromise = null;
      }
    })();

    return this.menuBridgePromise;
  }

  private async setMenuMode(mode: MacosEditMenuMode): Promise<void> {
    if (!isMacOSDesktop()) {
      return;
    }

    if (this.lastRequestedMenuMode === mode) {
      return;
    }

    this.lastRequestedMenuMode = mode;

    try {
      await systemAPI.setMacosEditMenuMode(mode);
    } catch (error) {
      if (this.lastRequestedMenuMode === mode) {
        this.lastRequestedMenuMode = null;
      }
      log.warn('Failed to switch macOS edit menu mode', { mode, error });
    }
  }
}

export const activeMonacoEditorService = new ActiveMonacoEditorService();
