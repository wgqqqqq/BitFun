/**
 * Mermaid rendering service.
 * Principle: fetch config from the theme system, avoid hard-coded colors.
 */

import mermaid from 'mermaid';
import { getMermaidConfig, setupThemeListener, MERMAID_THEME_CHANGE_EVENT, getThemeType } from '../theme/mermaidTheme';

export { MERMAID_THEME_CHANGE_EVENT };

export class MermaidService {
  private static instance: MermaidService;
  private cleanupThemeListener: (() => void) | null = null;

  public static getInstance(): MermaidService {
    if (!MermaidService.instance) {
      MermaidService.instance = new MermaidService();
    }
    return MermaidService.instance;
  }

  constructor() {
    this.setupThemeListener();
  }

  /** Set up theme listener. */
  private setupThemeListener(): void {
    this.cleanupThemeListener = setupThemeListener(() => {
      // Theme changes emit events consumed by UI components.
    });
  }

  /** Initialize Mermaid before each render. */
  private initializeMermaid(): void {
    const config = getMermaidConfig();
    
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      fontFamily: '"Inter", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
      fontSize: 13,
      ...config,
    } as any);
  }

  /** Render a Mermaid diagram. */
  public async renderDiagram(sourceCode: string): Promise<string> {
    // Reinitialize per render to ensure correct theme.
    this.initializeMermaid();

    try {
      if (!sourceCode.trim()) {
        throw new Error('Source code is empty');
      }

      await mermaid.parse(sourceCode);

      const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const result = await mermaid.render(id, sourceCode);
      return result.svg;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Render failed: ${errorMessage}`);
    }
  }

  /** Validate Mermaid code (boolean result). */
  public async validateSourceCode(sourceCode: string): Promise<boolean> {
    try {
      if (!sourceCode.trim()) return false;
      await mermaid.parse(sourceCode);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate Mermaid code with detailed error information.
   * Used by auto-fix to surface parsing errors.
   */
  public async validateMermaidCode(sourceCode: string): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!sourceCode.trim()) {
        return { valid: false, error: 'Source code is empty' };
      }
      await mermaid.parse(sourceCode);
      return { valid: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { valid: false, error: errorMessage };
    }
  }

  /** Get current theme type. */
  public getCurrentThemeType(): 'dark' | 'light' {
    return getThemeType();
  }

  /** Get default template. */
  public getDefaultTemplate(): string {
    return `flowchart TD
    A[Start] --> B[Process Data]
    B --> C{Successful?}
    C -->|Yes| D[Save Result]
    C -->|No| E[Handle Error]
    D --> F[End]
    E --> F`;
  }

  /** Export as SVG. */
  public async exportAsSVG(sourceCode: string): Promise<string> {
    return this.renderDiagram(sourceCode);
  }

  /** Export as PNG. */
  public async exportAsPNG(sourceCode: string, scale: number = 2): Promise<Blob> {
    const svg = await this.exportAsSVG(sourceCode);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create canvas');
    
    const img = new Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    
    return new Promise((resolve, reject) => {
      img.onload = () => {
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          blob ? resolve(blob) : reject(new Error('Unable to generate PNG'));
        }, 'image/png');
      };
      
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Unable to load SVG'));
      };
      
      img.src = url;
    });
  }

  /** Dispose resources. */
  public dispose(): void {
    if (this.cleanupThemeListener) {
      this.cleanupThemeListener();
      this.cleanupThemeListener = null;
    }
  }
}

export const mermaidService = MermaidService.getInstance();
