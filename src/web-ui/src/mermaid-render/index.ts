/**
 * Mermaid runtime for Markdown diagram blocks only (no standalone editor).
 */

export { MermaidService, mermaidService, MERMAID_THEME_CHANGE_EVENT } from './services/MermaidService';
export {
  getMermaidConfig,
  getThemeType,
  setupThemeListener,
  getRuntimeColors,
} from './theme';
