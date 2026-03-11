 

import { IMenuProvider } from '../types/provider.types';
import { MenuItem } from '../types/menu.types';
import { MenuContext, ContextType, EditorContext } from '../types/context.types';
import { commandExecutor } from '../commands/CommandExecutor';
import { globalEventBus } from '@/infrastructure/event-bus';
import { i18nService } from '@/infrastructure/i18n';
import { lspExtensionRegistry } from '@/tools/lsp/services/LspExtensionRegistry';
export class EditorMenuProvider implements IMenuProvider {
  readonly id = 'editor';
  readonly name = i18nService.t('common:contextMenu.editorMenu.name');
  readonly description = i18nService.t('common:contextMenu.editorMenu.description');
  readonly priority = 50;

  matches(context: MenuContext): boolean {
    return context.type === ContextType.EDITOR;
  }

  async getMenuItems(context: MenuContext): Promise<MenuItem[]> {
    const editorContext = context as EditorContext;
    const items: MenuItem[] = [];

    
    if (editorContext.selectedText) {
      items.push({
        id: 'editor-copy',
        label: i18nService.t('common:actions.copy'),
        icon: 'Copy',
        shortcut: 'Ctrl+C',
        command: 'copy',
        onClick: async (ctx) => {
          await commandExecutor.execute('copy', ctx);
        }
      });

      if (!editorContext.isReadOnly) {
        items.push({
          id: 'editor-cut',
          label: i18nService.t('common:actions.cut'),
          icon: 'Scissors',
          shortcut: 'Ctrl+X',
          command: 'cut',
          onClick: async (ctx) => {
            await commandExecutor.execute('cut', ctx);
          }
        });
      }
    }

    
    if (!editorContext.isReadOnly) {
      items.push({
        id: 'editor-paste',
        label: i18nService.t('common:actions.paste'),
        icon: 'Clipboard',
        shortcut: 'Ctrl+V',
        command: 'paste',
        onClick: async (ctx) => {
          await commandExecutor.execute('paste', ctx);
        }
      });
    }

    
    items.push({
      id: 'editor-separator-1',
      label: '',
      separator: true
    });

    items.push({
      id: 'editor-select-all',
      label: i18nService.t('common:actions.selectAll'),
      shortcut: 'Ctrl+A',
      command: 'select-all',
      onClick: async (ctx) => {
        await commandExecutor.execute('select-all', ctx);
      }
    });

    
    if (!editorContext.isReadOnly && editorContext.filePath 
      && lspExtensionRegistry.isFileSupported(editorContext.filePath)) {
      items.push({
        id: 'editor-separator-2',
        label: '',
        separator: true
      });

      items.push({
        id: 'editor-format',
        label: i18nService.t('common:editor.formatDocument'),
        icon: 'Code',
        shortcut: 'Shift+Alt+F',
        onClick: () => {
          
          globalEventBus.emit('editor:format-document', {
            filePath: editorContext.filePath,
            editorId: editorContext.editorId
          });
        }
      });
    }

    // Only show LSP menu items when the file type is supported by an LSP server
    const hasLspSupport = editorContext.filePath 
      && lspExtensionRegistry.isFileSupported(editorContext.filePath);

    if (editorContext.filePath && hasLspSupport) {
      
      const position = editorContext.cursorPosition || { line: 1, column: 1 };
      items.push({
        id: 'editor-separator-lsp',
        label: '',
        separator: true
      });

      
      items.push({
        id: 'editor-goto-definition',
        label: i18nService.t('common:editor.goToDefinition'),
        icon: 'Navigation',
        shortcut: 'F12',
        onClick: () => {
          globalEventBus.emit('editor:goto-definition', {
            filePath: editorContext.filePath,
            line: position.line,
            column: position.column,
            editorId: editorContext.editorId
          });
        }
      });

      
      items.push({
        id: 'editor-goto-type-definition',
        label: i18nService.t('common:editor.goToTypeDefinition'),
        icon: 'FileType',
        onClick: () => {
          globalEventBus.emit('editor:goto-type-definition', {
            filePath: editorContext.filePath,
            line: position.line,
            column: position.column,
            editorId: editorContext.editorId
          });
        }
      });

      
      items.push({
        id: 'editor-find-references',
        label: i18nService.t('common:editor.findAllReferences'),
        icon: 'Search',
        shortcut: 'Shift+F12',
        onClick: () => {
          globalEventBus.emit('editor:find-references', {
            filePath: editorContext.filePath,
            line: position.line,
            column: position.column,
            editorId: editorContext.editorId
          });
        }
      });

      
      if (!editorContext.isReadOnly) {
        items.push({
          id: 'editor-rename-symbol',
          label: i18nService.t('common:editor.renameSymbol'),
          icon: 'Edit',
          shortcut: 'F2',
          onClick: () => {
            globalEventBus.emit('editor:rename-symbol', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });

        
        items.push({
          id: 'editor-code-action',
          label: i18nService.t('common:editor.quickFix'),
          icon: 'Lightbulb',
          shortcut: 'Ctrl+.',
          onClick: () => {
            globalEventBus.emit('editor:code-action', {
              filePath: editorContext.filePath,
              line: position.line,
              column: position.column,
              editorId: editorContext.editorId
            });
          }
        });
      }

      
      items.push({
        id: 'editor-separator-more',
        label: '',
        separator: true
      });

      items.push({
        id: 'editor-document-symbols',
        label: i18nService.t('common:editor.goToSymbol'),
        icon: 'List',
        shortcut: 'Ctrl+Shift+O',
        onClick: () => {
          globalEventBus.emit('editor:document-symbols', {
            filePath: editorContext.filePath,
            editorId: editorContext.editorId
          });
        }
      });

      
      items.push({
        id: 'editor-document-highlight',
        label: i18nService.t('common:editor.highlightAllOccurrences'),
        icon: 'Highlighter',
        onClick: () => {
          globalEventBus.emit('editor:document-highlight', {
            filePath: editorContext.filePath,
            line: position.line,
            column: position.column,
            editorId: editorContext.editorId
          });
        }
      });
    }

    return items;
  }

  isEnabled(): boolean {
    return true;
  }
}
