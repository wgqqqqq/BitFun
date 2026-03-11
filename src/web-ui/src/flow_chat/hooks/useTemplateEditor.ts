/**
 * Template editor hook.
 * Handles placeholder rendering, navigation, and fill state.
 */

import { useCallback } from 'react';
import type { PromptTemplate, PlaceholderInfo, PlaceholderFillState } from '@/shared/types/prompt-template';
import { parseTemplate } from '@/shared/utils/templateParser';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useTemplateEditor');

interface UseTemplateEditorProps {
  /** Editor DOM ref */
  editorRef: React.RefObject<HTMLDivElement | null>;
  /** Current template fill state */
  templateFillState: PlaceholderFillState | null;
  /** Update input value */
  onValueChange: (value: string) => void;
  /** Start template fill mode */
  onStartFill: (state: PlaceholderFillState) => void;
  /** Exit fill mode */
  onExitFill: () => void;
  /** Update current placeholder index */
  onUpdateCurrentIndex: (index: number) => void;
  /** Move to next placeholder */
  onNextPlaceholder: () => void;
  /** Move to previous placeholder */
  onPrevPlaceholder: () => void;
}

interface UseTemplateEditorReturn {
  /** Select a template */
  handleTemplateSelect: (template: PromptTemplate) => void;
  /** Exit template mode */
  exitTemplateMode: () => void;
  /** Move to next placeholder */
  moveToNextPlaceholder: () => boolean;
  /** Move to previous placeholder */
  moveToPrevPlaceholder: () => boolean;
}

export function useTemplateEditor(props: UseTemplateEditorProps): UseTemplateEditorReturn {
  const {
    editorRef,
    templateFillState,
    onValueChange,
    onStartFill,
    onExitFill,
    onUpdateCurrentIndex,
    onNextPlaceholder,
    onPrevPlaceholder,
  } = props;

  // Extract content from the editor, including placeholder values.
  const extractTemplateContent = useCallback(() => {
    if (!editorRef.current) return '';
    
    const editor = editorRef.current as HTMLElement;
    let result = '';
    
    editor.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        if (element.classList.contains('rich-text-placeholder')) {
          result += element.textContent || '';
        } else {
          result += element.textContent || '';
        }
      }
    });
    
    return result;
  }, [editorRef]);

  // Render content with highlighted placeholders.
  const renderHighlightedTemplate = useCallback((content: string, placeholders: PlaceholderInfo[], currentIndex: number) => {
    if (!editorRef.current) {
      return;
    }
    
    const editor = editorRef.current as HTMLElement;
    
    editor.innerHTML = '';
    
    let lastIndex = 0;
    const initialContentParts: string[] = [];
    
    placeholders.forEach((placeholder, index) => {
      if (placeholder.startIndex > lastIndex) {
        const textBefore = content.substring(lastIndex, placeholder.startIndex);
        editor.appendChild(document.createTextNode(textBefore));
        initialContentParts.push(textBefore);
      }
      
      const placeholderSpan = document.createElement('span');
      placeholderSpan.className = 'rich-text-placeholder';
      placeholderSpan.contentEditable = 'true';
      placeholderSpan.dataset.placeholderIndex = index.toString();
      placeholderSpan.dataset.placeholderName = placeholder.name;
      
      if (index === currentIndex) {
        placeholderSpan.classList.add('rich-text-placeholder--active');
      }
      
      const displayText = placeholder.defaultValue || placeholder.name;
      placeholderSpan.textContent = displayText;
      initialContentParts.push(displayText);
      
      if (placeholder.description) {
        placeholderSpan.title = placeholder.description;
      }
      
      // Click to activate this placeholder.
      placeholderSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        const clickedIndex = parseInt(placeholderSpan.dataset.placeholderIndex || '0', 10);
        onUpdateCurrentIndex(clickedIndex);
        selectPlaceholderByIndex(clickedIndex);
      });
      
      // Focus to activate this placeholder.
      placeholderSpan.addEventListener('focus', () => {
        const focusedIndex = parseInt(placeholderSpan.dataset.placeholderIndex || '0', 10);
        onUpdateCurrentIndex(focusedIndex);
        
        editor.querySelectorAll('.rich-text-placeholder').forEach(el => {
          el.classList.remove('rich-text-placeholder--active');
        });
        placeholderSpan.classList.add('rich-text-placeholder--active');
      });
      
      // Keep input value in sync with placeholder edits.
      placeholderSpan.addEventListener('input', () => {
        const newContent = extractTemplateContent();
        onValueChange(newContent);
      });
      
      editor.appendChild(placeholderSpan);
      lastIndex = placeholder.endIndex;
    });
    
    if (lastIndex < content.length) {
      const textAfter = content.substring(lastIndex);
      editor.appendChild(document.createTextNode(textAfter));
      initialContentParts.push(textAfter);
    }
    
    const initialContent = initialContentParts.join('');
    onValueChange(initialContent);
  }, [editorRef, extractTemplateContent, onValueChange, onUpdateCurrentIndex]);

  // Select a placeholder element by index.
  const selectPlaceholderByIndex = useCallback((index: number) => {
    if (!editorRef.current) return;
    
    const editor = editorRef.current as HTMLElement;
    const placeholderElement = editor.querySelector(
      `[data-placeholder-index="${index}"]`
    ) as HTMLElement;
    
    if (!placeholderElement) {
      log.warn('Placeholder element not found', { index });
      return;
    }
    
    try {
      editor.querySelectorAll('.rich-text-placeholder').forEach(el => {
        el.classList.remove('rich-text-placeholder--active');
      });
      
      placeholderElement.classList.add('rich-text-placeholder--active');
      
      const range = document.createRange();
      const sel = window.getSelection();
      
      range.selectNodeContents(placeholderElement);
      sel?.removeAllRanges();
      sel?.addRange(range);
      
      placeholderElement.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'nearest' 
      });
    } catch (error) {
      log.error('Failed to select placeholder', { index, error });
    }
  }, [editorRef]);

  // Handle template selection and optional fill mode.
  const handleTemplateSelect = useCallback((template: PromptTemplate) => {
    const placeholders = parseTemplate(template.content);
    
    if (placeholders.length > 0) {
      onStartFill({
        currentIndex: 0,
        placeholders,
        filledValues: {},
        isActive: true
      });
      
      setTimeout(() => {
        renderHighlightedTemplate(template.content, placeholders, 0);
        
        if (editorRef.current) {
          editorRef.current.focus();
          selectPlaceholderByIndex(0);
        }
      }, 100);
    } else {
      onValueChange(template.content);
      setTimeout(() => {
        editorRef.current?.focus();
      }, 100);
    }
  }, [renderHighlightedTemplate, selectPlaceholderByIndex, onStartFill, onValueChange, editorRef]);

  // Exit fill mode and flatten placeholders to plain text.
  const exitTemplateMode = useCallback(() => {
    onExitFill();
    
    if (editorRef.current) {
      const editor = editorRef.current as HTMLElement;
      const currentContent = extractTemplateContent();
      editor.textContent = currentContent;
      
      requestAnimationFrame(() => {
        if (editor.childNodes.length > 0) {
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(editor);
          range.collapse(false);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        editor.focus();
      });
    }
  }, [extractTemplateContent, onExitFill, editorRef]);

  // Move to the next placeholder.
  const moveToNextPlaceholder = useCallback(() => {
    if (!templateFillState || !templateFillState.isActive) {
      return false;
    }

    const nextIndex = templateFillState.currentIndex + 1;
    
    if (nextIndex >= templateFillState.placeholders.length) {
      exitTemplateMode();
      return false;
    }

    onNextPlaceholder();
    selectPlaceholderByIndex(nextIndex);
    return true;
  }, [templateFillState, selectPlaceholderByIndex, exitTemplateMode, onNextPlaceholder]);

  // Move to the previous placeholder.
  const moveToPrevPlaceholder = useCallback(() => {
    if (!templateFillState || !templateFillState.isActive) {
      return false;
    }

    const prevIndex = templateFillState.currentIndex - 1;
    
    if (prevIndex < 0) {
      return false;
    }

    onPrevPlaceholder();
    selectPlaceholderByIndex(prevIndex);
    return true;
  }, [templateFillState, selectPlaceholderByIndex, onPrevPlaceholder]);

  return {
    handleTemplateSelect,
    exitTemplateMode,
    moveToNextPlaceholder,
    moveToPrevPlaceholder,
  };
}
