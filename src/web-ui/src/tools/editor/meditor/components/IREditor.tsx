import React, { useState, useCallback, useRef, useEffect, useImperativeHandle, memo, useMemo } from 'react'
import { createLogger } from '@/shared/utils/logger'
import { useI18n } from '@/infrastructure/i18n'
import { useMarkdown } from '../hooks/useMarkdown'
import { useEditorHistory } from '../hooks/useEditorHistory'
import { MermaidService } from '@/tools/mermaid-editor/services/MermaidService'
import { loadLocalImages } from '../utils/loadLocalImages'
import { 
  isModKey,
  toggleBold,
  toggleItalic,
  insertLink,
  indentLines,
  outdentLines
} from '../utils/keyboardShortcuts'
import './IREditor.scss'

const log = createLogger('IREditor')

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface IREditorProps {
  value: string
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
  placeholder?: string
  readonly?: boolean
  autofocus?: boolean
  /**
   * Directory path of the Markdown file.
   * Used to resolve relative image paths.
   */
  basePath?: string
  /**
   * Dirty state change callback.
   * Called when dirty state (unsaved changes) changes.
   */
  onDirtyChange?: (isDirty: boolean) => void
}

interface Block {
  id: string
  type: 'paragraph' | 'code' | 'heading' | 'list' | 'blockquote' | 'other'
  startLine: number
  endLine: number
  content: string
}

/** IREditor exposed method interface */
export interface IREditorHandle {
  /** Scroll to specified line */
  scrollToLine: (line: number, highlight?: boolean) => void
  /** Undo */
  undo: () => boolean
  /** Redo */
  redo: () => boolean
  /** Whether undo is available */
  canUndo: boolean
  /** Whether redo is available */
  canRedo: boolean
  /** Focus editor */
  focus: () => void
  /** Get current content */
  getContent: () => string
  /** Mark current state as saved */
  markSaved: () => void
  /** Reset to specified content (used for file loading) */
  setInitialContent: (content: string) => void
  /** Whether there are unsaved changes */
  isDirty: boolean
}

const generateStableBlockId = (startLine: number, type: string) => `block-${startLine}-${type}`

interface BlockWithoutId {
  type: Block['type']
  startLine: number
  endLine: number
  content: string
}

const parseMarkdownToBlocksRaw = (content: string): BlockWithoutId[] => {
  const lines = content.split('\n')
  const newBlocks: BlockWithoutId[] = []
  let currentBlock: BlockWithoutId | null = null
  let inCodeBlock = false
  let codeBlockStart = -1

  lines.forEach((line, index) => {
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBlockStart = index
      } else {
        if (currentBlock) {
          newBlocks.push(currentBlock)
          currentBlock = null
        }
        newBlocks.push({
          type: 'code',
          startLine: codeBlockStart,
          endLine: index,
          content: lines.slice(codeBlockStart, index + 1).join('\n')
        })
        inCodeBlock = false
        codeBlockStart = -1
      }
      return
    }

    if (inCodeBlock) {
      return
    }

    const isEmptyLine = line.trim() === ''
    const prevLineEmpty = index > 0 && lines[index - 1].trim() === ''
    
    if (isEmptyLine && prevLineEmpty) {
      if (currentBlock) {
        newBlocks.push(currentBlock)
        currentBlock = null
      }
      return
    }

    let blockType: Block['type'] = 'paragraph'
    if (!isEmptyLine) {
      if (line.match(/^#{1,6}\s/)) {
        blockType = 'heading'
      } else if (line.match(/^[\*\-\+]\s/) || line.match(/^\d+\.\s/)) {
        blockType = 'list'
      } else if (line.match(/^>\s/)) {
        blockType = 'blockquote'
      }
    }

    if (currentBlock) {
      if (isEmptyLine || currentBlock.type === blockType) {
        currentBlock.endLine = index
        currentBlock.content += '\n' + line
      } else {
        newBlocks.push(currentBlock)
        currentBlock = {
          type: blockType,
          startLine: index,
          endLine: index,
          content: line
        }
      }
    } else if (!isEmptyLine) {
      currentBlock = {
        type: blockType,
        startLine: index,
        endLine: index,
        content: line
      }
    }
  })

  if (currentBlock !== null) {
    const finalBlock = currentBlock as BlockWithoutId
    finalBlock.content = finalBlock.content.replace(/\n+$/, '')
    newBlocks.push(finalBlock)
  }

  return newBlocks
}

const updateBlocksSmartly = (oldBlocks: Block[], newRawBlocks: BlockWithoutId[]): Block[] => {
  return newRawBlocks.map((rawBlock, index) => {
    const oldBlock = oldBlocks[index]
    
    if (oldBlock && oldBlock.type === rawBlock.type) {
      return {
        ...rawBlock,
        id: oldBlock.id
      }
    }
    
    return {
      ...rawBlock,
      id: generateStableBlockId(rawBlock.startLine, rawBlock.type)
    }
  })
}

export const IREditor = React.forwardRef<IREditorHandle, IREditorProps>(
  ({ value, onChange, onBlur, placeholder, readonly, basePath, onDirtyChange }, ref) => {
    const { t } = useI18n('tools')
    const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
    const [editingContent, setEditingContent] = useState<string>('')
    const [blocks, setBlocks] = useState<Block[]>([])
    const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null)
    const editorRef = useRef<HTMLDivElement>(null)
    const blockRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())
    const lastValueRef = useRef<string>(value)
    
    const i18nCssVars = useMemo(() => {
      return {
        ['--m-editor-local-image-loading-text' as any]: JSON.stringify(t('editor.meditor.localImageLoading')),
        ['--m-editor-local-image-failed-text' as any]: JSON.stringify(t('editor.meditor.localImageFailed')),
      } as React.CSSProperties
    }, [t])
    
    const onChangeRef = useRef(onChange)
    const onDirtyChangeRef = useRef(onDirtyChange)
    onChangeRef.current = onChange
    onDirtyChangeRef.current = onDirtyChange

    const history = useEditorHistory({
      initialContent: value,
      maxHistorySize: 100,
      debounceMs: 300,
      onChange: useCallback((newContent: string) => {
        lastValueRef.current = newContent
        onChangeRef.current(newContent)
      }, []),
      onDirtyChange: useCallback((isDirty: boolean) => {
        onDirtyChangeRef.current?.(isDirty)
      }, [])
    })

    const lastExternalValueRef = useRef(value)
    useEffect(() => {
      if (value !== lastExternalValueRef.current && value !== history.content) {
        lastExternalValueRef.current = value
        history.setInitialContent(value)
      }
    }, [value, history])

    const currentContent = history.content
    useEffect(() => {
      if (editingBlockId && lastValueRef.current === currentContent) {
        return
      }
      
      lastValueRef.current = currentContent
      const rawBlocks = parseMarkdownToBlocksRaw(currentContent)
      const newBlocks = updateBlocksSmartly(blocks, rawBlocks)
      setBlocks(newBlocks)
    }, [currentContent, editingBlockId]) // blocks intentionally excluded to avoid loops

    const scrollToLine = useCallback((line: number, highlight: boolean = true) => {
      const targetBlock = blocks.find(
        block => line >= block.startLine + 1 && line <= block.endLine + 1
      )
      
      if (!targetBlock) {
        const closestBlock = blocks.reduce((closest, block) => {
          const currentDist = Math.min(
            Math.abs(block.startLine + 1 - line),
            Math.abs(block.endLine + 1 - line)
          )
          const closestDist = closest ? Math.min(
            Math.abs(closest.startLine + 1 - line),
            Math.abs(closest.endLine + 1 - line)
          ) : Infinity
          return currentDist < closestDist ? block : closest
        }, null as Block | null)
        
        if (closestBlock) {
          scrollToBlock(closestBlock.id, highlight)
        }
        return
      }
      
      scrollToBlock(targetBlock.id, highlight)
    }, [blocks])

    const scrollToBlock = useCallback((blockId: string, highlight: boolean = true) => {
      const blockElement = blockRefsMap.current.get(blockId)
      
      if (blockElement && editorRef.current) {
        blockElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
        
        if (highlight) {
          setHighlightedBlockId(blockId)
          setTimeout(() => {
            setHighlightedBlockId(prev => prev === blockId ? null : prev)
          }, 3000)
        }
      }
    }, [])

    useImperativeHandle(ref, () => ({
      scrollToLine,
      undo: history.undo,
      redo: history.redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      focus: () => editorRef.current?.focus(),
      getContent: () => history.content,
      markSaved: history.markSaved,
      setInitialContent: history.setInitialContent,
      isDirty: history.isDirty
    }), [scrollToLine, history])

    const handleBlockClick = useCallback((blockId: string) => {
      if (readonly) return
      
      const block = blocks.find(b => b.id === blockId)
      if (block) {
        setEditingBlockId(blockId)
        setEditingContent(block.content)
      }
    }, [readonly, blocks])

    const handleBlockContentChange = useCallback((newContent: string) => {
      setEditingContent(newContent)
      
      if (editingBlockId && editingBlockId !== 'empty-block') {
        const block = blocks.find(b => b.id === editingBlockId)
        if (block) {
          const lines = currentContent.split('\n')
          const before = lines.slice(0, block.startLine).join('\n')
          const after = lines.slice(block.endLine + 1).join('\n')
          const newValue = [before, newContent, after].filter(s => s !== '').join('\n')
          lastValueRef.current = newValue
          history.pushChange(newValue)
        }
      }
    }, [editingBlockId, blocks, currentContent, history])

    const handleBlockBlur = useCallback(() => {
      if (!editingBlockId || editingBlockId === 'empty-block') {
        setEditingBlockId(null)
        setEditingContent('')
        onBlur?.()
        return
      }
      
      const block = blocks.find(b => b.id === editingBlockId)
      if (!block) {
        setEditingBlockId(null)
        setEditingContent('')
        onBlur?.()
        return
      }

      setEditingBlockId(null)
      setEditingContent('')
      onBlur?.()
    }, [editingBlockId, blocks, onBlur])

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      const modKey = isModKey(e)
      
      if (e.key === 'Escape') {
        e.preventDefault()
        setEditingBlockId(null)
        setEditingContent('')
        const rawBlocks = parseMarkdownToBlocksRaw(currentContent)
        setBlocks(updateBlocksSmartly(blocks, rawBlocks))
        return
      }
      
      if (modKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (editingBlockId) {
          setEditingBlockId(null)
          setEditingContent('')
        }
        history.undo()
        return
      }
      
      if ((modKey && e.key === 'z' && e.shiftKey) || (e.ctrlKey && e.key === 'y')) {
        e.preventDefault()
        if (editingBlockId) {
          setEditingBlockId(null)
          setEditingContent('')
        }
        history.redo()
        return
      }
    }, [currentContent, blocks, editingBlockId, history])
    
    const handleBlockKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const modKey = isModKey(e)
      const textarea = e.currentTarget
      const { selectionStart, selectionEnd, value } = textarea
      
      handleKeyDown(e)
      if (e.defaultPrevented) return
      
      const currentBlockIndex = editingBlockId 
        ? blocks.findIndex(b => b.id === editingBlockId)
        : -1
      const currentBlock = currentBlockIndex >= 0 ? blocks[currentBlockIndex] : null
      
      if (e.key === 'Backspace' && !modKey && selectionStart === 0 && selectionEnd === 0) {
        if (value.trim() === '' && blocks.length > 1) {
          e.preventDefault()
          
          const lines = currentContent.split('\n')
          if (currentBlock) {
            const before = lines.slice(0, currentBlock.startLine).join('\n')
            const after = lines.slice(currentBlock.endLine + 1).join('\n')
            const newValue = [before, after].filter(s => s !== '').join('\n\n')
            
            setEditingBlockId(null)
            setEditingContent('')
            history.pushChange(newValue)
          }
          return
        } else if (currentBlockIndex > 0 && value.length > 0) {
          e.preventDefault()
          
          const prevBlock = blocks[currentBlockIndex - 1]
          const lines = currentContent.split('\n')
          const beforePrev = lines.slice(0, prevBlock.startLine).join('\n')
          const afterCurrent = lines.slice(currentBlock!.endLine + 1).join('\n')
          
          const mergedContent = prevBlock.content + '\n' + value
          const newValue = [beforePrev, mergedContent, afterCurrent].filter(s => s !== '').join('\n\n')
          
          setEditingBlockId(null)
          setEditingContent('')
          history.pushChange(newValue)
          
          setTimeout(() => {
            const newBlocks = parseMarkdownToBlocksRaw(newValue)
            if (newBlocks.length > 0 && currentBlockIndex - 1 < newBlocks.length) {
              const targetBlock = newBlocks[currentBlockIndex - 1]
              const newBlockId = generateStableBlockId(targetBlock.startLine, targetBlock.type)
              setEditingBlockId(newBlockId)
              setEditingContent(targetBlock.content)
            }
          }, 50)
          return
        }
      }
      
      if (modKey && e.key === 'Enter') {
        e.preventDefault()
        
        if (currentBlock) {
          const lines = currentContent.split('\n')
          const before = lines.slice(0, currentBlock.endLine + 1).join('\n')
          const after = lines.slice(currentBlock.endLine + 1).join('\n')
          const newValue = before + '\n\n' + after
          
          setEditingBlockId(null)
          setEditingContent('')
          history.pushChange(newValue)
        }
        return
      }
      
      if (e.key === 'Tab' && !modKey) {
        e.preventDefault()
        const result = e.shiftKey 
          ? outdentLines(value, selectionStart, selectionEnd)
          : indentLines(value, selectionStart, selectionEnd)
        
        textarea.value = result.text
        textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        const event = new Event('input', { bubbles: true })
        textarea.dispatchEvent(event)
        return
      }
      
      if (modKey && e.key === 'b') {
        e.preventDefault()
        const result = toggleBold(value, selectionStart, selectionEnd)
        textarea.value = result.text
        textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        const event = new Event('input', { bubbles: true })
        textarea.dispatchEvent(event)
        return
      }
      
      if (modKey && e.key === 'i') {
        e.preventDefault()
        const result = toggleItalic(value, selectionStart, selectionEnd)
        textarea.value = result.text
        textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        const event = new Event('input', { bubbles: true })
        textarea.dispatchEvent(event)
        return
      }
      
      if (modKey && e.key === 'k') {
        e.preventDefault()
        const result = insertLink(value, selectionStart, selectionEnd)
        textarea.value = result.text
        textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        const event = new Event('input', { bubbles: true })
        textarea.dispatchEvent(event)
        return
      }
    }, [handleKeyDown, editingBlockId, blocks, currentContent, history])

    const handleEmptyBlockChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      history.pushChange(e.target.value)
    }, [history])
    
    const handleEmptyBlockKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const modKey = isModKey(e)
      const textarea = e.currentTarget
      const { selectionStart, selectionEnd, value } = textarea
      
      handleKeyDown(e)
      if (e.defaultPrevented) return
      
      if (e.key === 'Tab' && !modKey) {
        e.preventDefault()
        const result = e.shiftKey 
          ? outdentLines(value, selectionStart, selectionEnd)
          : indentLines(value, selectionStart, selectionEnd)
        
        history.pushChange(result.text)
        setTimeout(() => {
          textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        }, 0)
        return
      }
      
      if (modKey && e.key === 'b') {
        e.preventDefault()
        const result = toggleBold(value, selectionStart, selectionEnd)
        history.pushChange(result.text)
        setTimeout(() => {
          textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        }, 0)
        return
      }
      
      if (modKey && e.key === 'i') {
        e.preventDefault()
        const result = toggleItalic(value, selectionStart, selectionEnd)
        history.pushChange(result.text)
        setTimeout(() => {
          textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        }, 0)
        return
      }
      
      if (modKey && e.key === 'k') {
        e.preventDefault()
        const result = insertLink(value, selectionStart, selectionEnd)
        history.pushChange(result.text)
        setTimeout(() => {
          textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
        }, 0)
        return
      }
    }, [handleKeyDown, history])

    const handleEmptyBlockClick = useCallback(() => {
      if (!readonly) {
        setEditingBlockId('empty-block')
      }
    }, [readonly])

    const handleEmptyBlockBlur = useCallback(() => {
      setEditingBlockId(null)
      onBlur?.()
    }, [onBlur])

    return (
      <div className="m-editor-ir" ref={editorRef} tabIndex={-1} onKeyDown={handleKeyDown} style={i18nCssVars}>
        {editingBlockId === 'empty-block' ? (
          <div className="m-editor-ir-block m-editor-ir-block-paragraph editing">
            <textarea
              className="m-editor-ir-block-textarea m-editor-ir-empty-textarea"
              value={currentContent}
              onChange={handleEmptyBlockChange}
              onBlur={handleEmptyBlockBlur}
              onKeyDown={handleEmptyBlockKeyDown}
              placeholder={placeholder}
              readOnly={readonly}
              autoFocus
            />
          </div>
        ) : (
          <>
            {blocks.length === 0 && (
              <div 
                className="m-editor-ir-placeholder"
                onClick={handleEmptyBlockClick}
              >
                {placeholder}
              </div>
            )}
        
            {blocks.map((block) => (
              <IRBlock
                key={block.id}
                block={block}
                isEditing={editingBlockId === block.id}
                isHighlighted={highlightedBlockId === block.id}
                editingContent={editingBlockId === block.id ? editingContent : block.content}
                onClick={() => handleBlockClick(block.id)}
                onChange={handleBlockContentChange}
                onBlur={handleBlockBlur}
                onKeyDown={handleBlockKeyDown}
                readonly={readonly}
                basePath={basePath}
                blockRef={(el) => {
                  if (el) {
                    blockRefsMap.current.set(block.id, el)
                  } else {
                    blockRefsMap.current.delete(block.id)
                  }
                }}
              />
            ))}
          </>
        )}
      </div>
    )
  }
)

IREditor.displayName = 'IREditor'

interface IRBlockProps {
  block: Block
  isEditing: boolean
  isHighlighted: boolean
  editingContent: string // Content used in edit mode
  onClick: () => void
  onChange: (content: string) => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  readonly?: boolean
  blockRef?: (el: HTMLDivElement | null) => void
  /**
   * Directory path of the Markdown file.
   * Used to resolve relative image paths.
   */
  basePath?: string
}

const IRBlock: React.FC<IRBlockProps> = memo(({
  block,
  isEditing,
  isHighlighted,
  editingContent,
  onClick,
  onChange,
  onBlur,
  onKeyDown,
  readonly,
  blockRef,
  basePath
}) => {
  const { t } = useI18n('tools')
  const markdownOptions = useMemo(() => ({ basePath }), [basePath])
  
  const { html } = useMarkdown(block.content, markdownOptions)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const mermaidService = useRef(MermaidService.getInstance())
  
  const lastHtmlRef = useRef<string>('')

  const adjustTextareaHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      const minHeight = 24
      const scrollHeight = textareaRef.current.scrollHeight
      textareaRef.current.style.height = `${Math.max(minHeight, scrollHeight)}px`
    }
  }, [])

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
      adjustTextareaHeight()
    }
  }, [isEditing, adjustTextareaHeight])

  useEffect(() => {
    if (isEditing) {
      adjustTextareaHeight()
    }
  }, [isEditing, editingContent, adjustTextareaHeight])

      useEffect(() => {
        if (!isEditing && html && previewRef.current) {
          const isEmpty = !previewRef.current.innerHTML
          const needsUpdate = isEmpty || lastHtmlRef.current !== html
          
          if (needsUpdate) {
            previewRef.current.innerHTML = html
            lastHtmlRef.current = html
          }
        }
      }, [isEditing, html, t])
  
      useEffect(() => {
        if (!isEditing && html && previewRef.current) {
          const mermaidContainers = previewRef.current.querySelectorAll('.mermaid-container:not(.mermaid-rendered)')
          if (mermaidContainers.length === 0) {
            return
          }
          
          let isCancelled = false
          
          const renderMermaidDiagrams = async () => {
            for (const container of Array.from(mermaidContainers)) {
              if (isCancelled) break
              
              const mermaidCode = container.getAttribute('data-mermaid-code')
              
              if (mermaidCode) {
                try {
                  const svg = await mermaidService.current.renderDiagram(mermaidCode)
                  if (!isCancelled && previewRef.current?.contains(container)) {
                    container.innerHTML = svg
                    container.classList.add('mermaid-rendered')
                  }
                } catch (error) {
                  log.error('Mermaid render failed', error)
                  if (!isCancelled && previewRef.current?.contains(container)) {
                    const rawMsg = error instanceof Error ? error.message : t('editor.meditor.unknownError')
                    const detail = rawMsg.replace(/^Render failed:\s*/i, '')
                    const title = escapeHtml(t('editor.meditor.mermaidRenderFailed'))
                    container.innerHTML = `<div class="mermaid-error"><div class="mermaid-error-title">${title}</div><hr class="mermaid-error-divider"/><div class="mermaid-error-detail">${escapeHtml(detail)}</div></div>`
                  }
                }
              }
            }
          }

          const loadImages = async () => {
            if (previewRef.current && !isCancelled) {
              await loadLocalImages(previewRef.current)
            }
          }

          renderMermaidDiagrams()
          loadImages()
          
          return () => {
            isCancelled = true
          }
        }
      }, [isEditing, html])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
  }, [onChange])

  const highlightClass = isHighlighted ? 'highlighted' : ''

  if (isEditing) {
    return (
      <div 
        ref={blockRef}
        className={`m-editor-ir-block m-editor-ir-block-${block.type} editing ${highlightClass}`}
      >
        <textarea
          ref={textareaRef}
          className="m-editor-ir-block-textarea"
          value={editingContent}
          onChange={handleChange}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          readOnly={readonly}
          style={{ overflow: 'hidden' }}
        />
      </div>
    )
  }

  return (
    <div
      ref={blockRef}
      className={`m-editor-ir-block m-editor-ir-block-${block.type} ${highlightClass}`}
      onClick={onClick}
    >
      {/* Use ref to manually control innerHTML, preventing React re-render from overwriting Mermaid SVG */}
      <div
        ref={previewRef}
        className="m-editor-ir-block-preview markdown-body"
      />
    </div>
  )
})

IRBlock.displayName = 'IRBlock'
