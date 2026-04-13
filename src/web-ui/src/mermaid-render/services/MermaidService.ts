/**
 * Mermaid rendering service for Markdown blocks.
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

  private setupThemeListener(): void {
    this.cleanupThemeListener = setupThemeListener(() => {});
  }

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

  public async renderDiagram(sourceCode: string): Promise<string> {
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

  public getCurrentThemeType(): 'dark' | 'light' {
    return getThemeType();
  }

  public dispose(): void {
    if (this.cleanupThemeListener) {
      this.cleanupThemeListener();
      this.cleanupThemeListener = null;
    }
  }
}

export const mermaidService = MermaidService.getInstance();
