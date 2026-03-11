/**
 * Rehype plugin: Mermaid code blocks.
 * Converts Mermaid code blocks into a renderable container.
 */
import { visit } from 'unist-util-visit';
import { i18nService } from '@/infrastructure/i18n';

type Root = any;
type Element = any;

export function rehypeMermaid() {
  return (tree: Root) => {
    const placeholderText = i18nService.t('tools:editor.meditor.mermaidRendering');
    visit(tree, 'element', (node: Element, index, parent) => {
      if (
        node.tagName === 'pre' &&
        node.children &&
        node.children.length === 1
      ) {
        const codeNode = node.children[0] as Element;
        
        if (
          codeNode.tagName === 'code' &&
          codeNode.properties &&
          Array.isArray(codeNode.properties.className)
        ) {
          const classes = codeNode.properties.className as string[];
          
          if (classes.includes('language-mermaid')) {
            const textNode = codeNode.children[0];
            const mermaidCode = textNode && 'value' in textNode ? textNode.value as string : '';
            
            const mermaidContainer: Element = {
              type: 'element',
              tagName: 'div',
              properties: {
                className: ['mermaid-container'],
                'data-mermaid-code': mermaidCode
              },
              children: [
                {
                  type: 'element',
                  tagName: 'div',
                  properties: {
                    className: ['mermaid-placeholder']
                  },
                  children: [
                    {
                      type: 'text',
                      value: placeholderText
                    }
                  ]
                }
              ]
            };
            
            if (parent && typeof index === 'number') {
              parent.children[index] = mermaidContainer;
            }
          }
        }
      }
    });
  };
}
