 

import { 
  PromptTemplate, 
  PromptTemplateConfig, 
  TemplateSearchResult
} from '@/shared/types/prompt-template';
import { parseTemplate, fillTemplate, hasPlaceholders } from '@/shared/utils/templateParser';
import { promptTemplateAPI } from '@/infrastructure/api/service-api/PromptTemplateAPI';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('PromptTemplateService');


const DEFAULT_CONFIG: PromptTemplateConfig = {
  templates: [],
  globalShortcut: 'Ctrl+Shift+P',
  enableAutoComplete: true,
  recentTemplates: []
};



 
export class PromptTemplateService {
  private static instance: PromptTemplateService;
  private config: PromptTemplateConfig;
  private listeners: Set<(config: PromptTemplateConfig) => void> = new Set();

  private constructor() {
    this.config = this.loadConfig();
  }

   
  public static getInstance(): PromptTemplateService {
    if (!PromptTemplateService.instance) {
      PromptTemplateService.instance = new PromptTemplateService();
    }
    return PromptTemplateService.instance;
  }

  

   
  private loadConfig(): PromptTemplateConfig {
    
    return { ...DEFAULT_CONFIG };
  }
  
   
  private async loadConfigAsync(): Promise<PromptTemplateConfig> {
    try {
      const config = await promptTemplateAPI.getConfig();
      return config;
    } catch (error) {
      log.error('Failed to load config from backend', error);
      
      return { ...DEFAULT_CONFIG };
    }
  }

   
  private async saveConfig(config: PromptTemplateConfig): Promise<void> {
    try {
      config.lastSyncTime = Date.now();
      await promptTemplateAPI.saveConfig(config);
      this.config = config;
      this.notifyListeners();
    } catch (error) {
      log.error('Failed to save config to backend', error);
      throw error;
    }
  }
  
   
  public async initialize(): Promise<void> {
    try {
      this.config = await this.loadConfigAsync();
      this.notifyListeners();
    } catch (error) {
      log.error('Failed to initialize', error);
    }
  }

   
  public getConfig(): PromptTemplateConfig {
    return { ...this.config };
  }

   
  public async updateConfig(updates: Partial<PromptTemplateConfig>): Promise<void> {
    await this.saveConfig({ ...this.config, ...updates });
  }

   
  public async resetConfig(): Promise<void> {
    try {
      await promptTemplateAPI.resetTemplates();
      this.config = await this.loadConfigAsync();
      this.notifyListeners();
    } catch (error) {
      log.error('Failed to reset config', error);
      throw error;
    }
  }

  

   
  public async createTemplate(
    template: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>
  ): Promise<PromptTemplate> {
    const newTemplate: PromptTemplate = {
      ...template,
      id: this.generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usageCount: 0
    };

    const templates = [...this.config.templates, newTemplate];
    await this.saveConfig({ ...this.config, templates });

    return newTemplate;
  }

   
  public async updateTemplate(id: string, updates: Partial<PromptTemplate>): Promise<boolean> {
    const index = this.config.templates.findIndex(t => t.id === id);
    if (index === -1) {
      log.warn('Template not found', { id });
      return false;
    }

    const templates = [...this.config.templates];
    templates[index] = {
      ...templates[index],
      ...updates,
      updatedAt: Date.now()
    };

    await this.saveConfig({ ...this.config, templates });
    return true;
  }

   
  public async deleteTemplate(id: string): Promise<boolean> {
    const templates = this.config.templates.filter(t => t.id !== id);
    if (templates.length === this.config.templates.length) {
      log.warn('Template not found', { id });
      return false;
    }

    
    const recentTemplates = this.config.recentTemplates.filter(tid => tid !== id);

    await this.saveConfig({ ...this.config, templates, recentTemplates });
    return true;
  }

   
  public getTemplate(id: string): PromptTemplate | null {
    return this.config.templates.find(t => t.id === id) || null;
  }

   
  public getAllTemplates(): PromptTemplate[] {
    return [...this.config.templates];
  }

   
  public getFavoriteTemplates(): PromptTemplate[] {
    return this.config.templates.filter(t => t.isFavorite);
  }

   
  public getRecentTemplates(limit: number = 5): PromptTemplate[] {
    return this.config.recentTemplates
      .slice(0, limit)
      .map(id => this.getTemplate(id))
      .filter((t): t is PromptTemplate => t !== null);
  }

   
  public getTemplatesByCategory(category: string): PromptTemplate[] {
    return this.config.templates.filter(t => t.category === category);
  }

   
  public getCategories(): string[] {
    const categories = new Set<string>();
    this.config.templates.forEach(t => {
      if (t.category) {
        categories.add(t.category);
      }
    });
    return Array.from(categories).sort();
  }

  

   
  public searchTemplates(query: string): TemplateSearchResult[] {
    if (!query.trim()) {
      return this.config.templates.map(template => ({
        template,
        matchScore: 1,
        matchedFields: []
      }));
    }

    const lowerQuery = query.toLowerCase();
    const results: TemplateSearchResult[] = [];

    for (const template of this.config.templates) {
      let matchScore = 0;
      const matchedFields: string[] = [];

      
      if (template.name.toLowerCase().includes(lowerQuery)) {
        matchScore += 10;
        matchedFields.push('name');
      }

      
      if (template.description?.toLowerCase().includes(lowerQuery)) {
        matchScore += 5;
        matchedFields.push('description');
      }

      
      if (template.category?.toLowerCase().includes(lowerQuery)) {
        matchScore += 3;
        matchedFields.push('category');
      }

      
      if (template.content.toLowerCase().includes(lowerQuery)) {
        matchScore += 1;
        matchedFields.push('content');
      }

      if (matchScore > 0) {
        results.push({
          template,
          matchScore,
          matchedFields
        });
      }
    }

    
    results.sort((a, b) => b.matchScore - a.matchScore);

    return results;
  }

  

   
  public async recordUsage(id: string): Promise<void> {
    const template = this.getTemplate(id);
    if (!template) {
      return;
    }

    
    await this.updateTemplate(id, {
      usageCount: template.usageCount + 1
    });

    
    let recentTemplates = this.config.recentTemplates.filter(tid => tid !== id);
    recentTemplates = [id, ...recentTemplates].slice(0, 10); 

    await this.saveConfig({ ...this.config, recentTemplates });
  }

   
  public parseTemplate(content: string) {
    return parseTemplate(content);
  }

   
  public fillTemplate(content: string, values: Record<string, string>): string {
    return fillTemplate(content, values);
  }

   
  public hasPlaceholders(content: string): boolean {
    return hasPlaceholders(content);
  }

  

   
  public async exportConfig(): Promise<string> {
    try {
      return await promptTemplateAPI.exportTemplates();
    } catch (error) {
      log.error('Failed to export config', error);
      
      return JSON.stringify(this.config, null, 2);
    }
  }

   
  public async importConfig(json: string): Promise<boolean> {
    try {
      await promptTemplateAPI.importTemplates(json);
      
      this.config = await this.loadConfigAsync();
      this.notifyListeners();
      return true;
    } catch (error) {
      log.error('Failed to import config', error);
      return false;
    }
  }

   
  public exportTemplate(id: string): string | null {
    const template = this.getTemplate(id);
    if (!template) {
      return null;
    }
    return JSON.stringify(template, null, 2);
  }

   
  public async importTemplate(json: string): Promise<PromptTemplate | null> {
    try {
      const template = JSON.parse(json) as Partial<PromptTemplate>;
      
      if (!template.name || !template.content) {
        throw new Error('Template is missing required fields');
      }

      return await this.createTemplate({
        name: template.name,
        description: template.description,
        content: template.content,
        category: template.category,
        shortcut: template.shortcut,
        isFavorite: template.isFavorite || false,
        order: template.order || this.config.templates.length
      });
    } catch (error) {
      log.error('Failed to import template', error);
      return null;
    }
  }

  

   
  public async reorderTemplates(templateIds: string[]): Promise<void> {
    const templates = [...this.config.templates];
    
    templateIds.forEach((id, index) => {
      const template = templates.find(t => t.id === id);
      if (template) {
        template.order = index;
      }
    });

    templates.sort((a, b) => a.order - b.order);
    await this.saveConfig({ ...this.config, templates });
  }

   
  public async deleteTemplates(ids: string[]): Promise<number> {
    const templates = this.config.templates.filter(t => !ids.includes(t.id));
    const deletedCount = this.config.templates.length - templates.length;

    if (deletedCount > 0) {
      const recentTemplates = this.config.recentTemplates.filter(tid => !ids.includes(tid));
      await this.saveConfig({ ...this.config, templates, recentTemplates });
    }

    return deletedCount;
  }

  

   
  public subscribe(listener: (config: PromptTemplateConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

   
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.config);
      } catch (error) {
        log.error('Listener execution failed', error);
      }
    });
  }

  

   
  private generateId(): string {
    return `template_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}


export const promptTemplateService = PromptTemplateService.getInstance();
