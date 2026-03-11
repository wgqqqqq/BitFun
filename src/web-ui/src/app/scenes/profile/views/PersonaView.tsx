import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight, Pencil, X,
  ListChecks, RotateCcw, Puzzle,
  Brain, Zap, Sliders,
} from 'lucide-react';
import { Input, Search, Select, Switch, type SelectOption } from '@/component-library';
import { AIRulesAPI, RuleLevel, type AIRule } from '@/infrastructure/api/service-api/AIRulesAPI';
import { getAllMemories, toggleMemory, type AIMemory } from '@/infrastructure/api/aiMemoryApi';
import { promptTemplateService } from '@/infrastructure/services/PromptTemplateService';
import type { PromptTemplate } from '@/shared/types/prompt-template';
import { MCPAPI, type MCPServerInfo } from '@/infrastructure/api/service-api/MCPAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type {
  ModeConfigItem, SkillInfo, AIModelConfig,
  DefaultModelsConfig, AIExperienceConfig,
} from '@/infrastructure/config/types';
import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import type { ConfigTab } from '@/app/scenes/settings/settingsConfig';
import { quickActions } from '@/shared/services/ide-control';
import { getCardGradient } from '@/shared/utils/cardGradients';
import { PersonaRadar } from './PersonaRadar';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import './PersonaView.scss';

const log = createLogger('PersonaView');

function navToSettings(tab: ConfigTab) {
  useSettingsStore.getState().setActiveTab(tab);
  quickActions.openSettings();
}

interface ToolInfo { name: string; description: string; is_readonly: boolean; }

const C = 'bp';
const IDENTITY_KEY = 'bf_agent_identity';
const DEFAULT_NAME = 'BitFun Agent';
const CHIP_LIMIT = 12;
const TOOL_LIST_LIMIT = 10;
const SKILL_GRID_LIMIT = 4;

// ── Zone switching drag mechanics ─────────────────────────────
const ZONE_ORDER = ['brain', 'capabilities', 'interaction'] as const;
type ZoneId = typeof ZONE_ORDER[number];
const DRAG_THRESHOLD = 200;  // accumulated deltaY to trigger switch
const MAX_DISPLACE    = 22;  // max visual translateY in px

/** Elastic displacement: fast start, asymptotically approaches MAX_DISPLACE */
function elasticDisplace(accum: number): number {
  const t = Math.min(Math.abs(accum) / DRAG_THRESHOLD, 1);
  return MAX_DISPLACE * (1 - Math.exp(-t * 3.4)) * Math.sign(accum);
}
/** Ghost opacity: 0 before 50% threshold, ramps to 0.36 at 100% */
function ghostOpacity(accum: number): number {
  const t = Math.min(Math.abs(accum) / DRAG_THRESHOLD, 1);
  return t < 0.5 ? 0 : ((t - 0.5) / 0.5) * 0.36;
}

// Structural slot keys only — labels/descs are resolved via i18n at render time
const MODEL_SLOT_KEYS = ['primary', 'fast', 'compression', 'image', 'voice', 'retrieval'] as const;
type ModelSlotKey = typeof MODEL_SLOT_KEYS[number];

// Preset option IDs per slot (no translated labels here)
const SLOT_PRESET_IDS: Record<ModelSlotKey, { id: string }[]> = {
  primary:     [{ id: 'primary' }],
  fast:        [{ id: 'fast' }],
  compression: [{ id: 'fast' }],
  image:       [],
  voice:       [],
  retrieval:   [],
};

function getImportanceDotCount(importance: number): number {
  if (importance >= 8) return 3;
  if (importance >= 4) return 2;
  return 1;
}

interface ToggleChipProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  accentColor?: string;
  tooltip?: string;
  loading?: boolean;
}
const ToggleChip: React.FC<ToggleChipProps> = ({
  label, enabled, onToggle, accentColor, tooltip, loading,
}) => (
  <button
    type="button"
    className={`${C}-chip ${enabled ? 'is-on' : 'is-off'} ${loading ? 'is-loading' : ''}`}
    onClick={onToggle}
    title={tooltip ?? label}
    disabled={loading}
    style={accentColor ? { '--chip-accent': accentColor } as React.CSSProperties : undefined}
  >
    <span className={`${C}-chip__label`}>{label}</span>
  </button>
);

interface ToolToggleRowProps {
  name: string;
  description?: string;
  enabled: boolean;
  loading?: boolean;
  onToggle: () => void;
}
const ToolToggleRow: React.FC<ToolToggleRowProps> = ({
  name, description, enabled, loading, onToggle,
}) => (
  <div className={`${C}-tool-row`}>
    <div className={`${C}-tool-row__meta`}>
      <span className={`${C}-tool-row__name`}>{name}</span>
      <span className={`${C}-tool-row__desc`} title={description || name}>
        {description || name}
      </span>
    </div>
    <Switch
      size="small"
      checked={enabled}
      loading={loading}
      onChange={() => onToggle()}
      aria-label={name}
      className={`${C}-tool-row__switch`}
    />
  </div>
);

interface SkillMiniCardProps {
  name: string;
  description?: string;
  enabled: boolean;
  loading?: boolean;
  onToggle: () => void;
  onOpen: () => void;
}
const SkillMiniCard: React.FC<SkillMiniCardProps> = ({
  name, description, enabled, loading, onToggle, onOpen,
}) => (
  <div
    className={`${C}-skill-mini`}
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen();
      }
    }}
    aria-label={name}
  >
    <div
      className={`${C}-skill-mini__icon`}
      style={{ '--skill-mini-gradient': getCardGradient(name) } as React.CSSProperties}
    >
      <Puzzle size={16} strokeWidth={1.8} />
    </div>
    <div className={`${C}-skill-mini__body`}>
      <span className={`${C}-skill-mini__name`}>{name}</span>
      <span className={`${C}-skill-mini__desc`} title={description || name}>
        {description || name}
      </span>
    </div>
    <div
      className={`${C}-skill-mini__switch`}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <Switch
        size="small"
        checked={enabled}
        loading={loading}
        onChange={() => onToggle()}
        aria-label={name}
      />
    </div>
  </div>
);

interface PrefToggleRowProps {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
}
const PrefToggleRow: React.FC<PrefToggleRowProps> = ({
  label, description, enabled, onToggle,
}) => (
  <div className={`${C}-pref-row`}>
    <div className={`${C}-pref-row__info`}>
      <span className={`${C}-pref-row__title`}>{label}</span>
      <span className={`${C}-pref-row__desc`}>{description}</span>
    </div>
    <Switch
      size="small"
      checked={enabled}
      onChange={() => onToggle()}
      aria-label={label}
      className={`${C}-pref-row__switch`}
    />
  </div>
);

interface ModelPillProps {
  slotKey: ModelSlotKey;
  slotLabel: string;
  slotDesc: string;
  currentId: string;
  models: AIModelConfig[];
  onChange: (id: string) => void;
}
const ModelPill: React.FC<ModelPillProps> = ({
  slotKey, slotLabel, slotDesc, currentId, models, onChange,
}) => {
  const { t } = useTranslation('scenes/profile');

  const presetDefs = SLOT_PRESET_IDS[slotKey];
  const isPreset = presetDefs.some(p => p.id === currentId);
  const isConfigured = currentId !== '';

  // Translate preset option labels
  const presetLabelFor = useCallback((id: string) => {
    if (id === 'primary') return t('slotDefault.primary');
    if (id === 'fast')    return t('slotDefault.fast');
    return id;
  }, [t]);

  // Placeholder when slot has no explicit assignment
  const defaultLabel = useMemo(() => {
    if (slotKey === 'primary')     return t('slotDefault.primary');
    if (slotKey === 'fast')        return t('slotDefault.fast');
    if (slotKey === 'compression') return t('slotDefault.fast');
    return t('slotDefault.unconfigured');
  }, [slotKey, t]);

  const options = useMemo<SelectOption[]>(() => {
    const presetOptions: SelectOption[] = presetDefs.map(p => ({
      value: `preset:${p.id}`,
      label: presetLabelFor(p.id),
      group: t('modelGroups.presets'),
    }));
    const modelOptions: SelectOption[] = models
      .filter(m => m.enabled && !!m.id)
      .map(m => ({
        value: `model:${m.id}`,
        label: m.name,
        group: t('modelGroups.models'),
      }));
    return [...presetOptions, ...modelOptions];
  }, [presetDefs, models, presetLabelFor, t]);

  const selectedValue = !currentId
    ? ''
    : isPreset
      ? `preset:${currentId}`
      : `model:${currentId}`;

  const handleSelect = useCallback((value: string | number | (string | number)[]) => {
    if (Array.isArray(value)) return;
    const raw = String(value);
    if (raw.startsWith('preset:')) {
      onChange(raw.replace('preset:', ''));
      return;
    }
    if (raw.startsWith('model:')) {
      onChange(raw.replace('model:', ''));
    }
  }, [onChange]);

  return (
    <div className={`${C}-model-cell`}>
      <div className={`${C}-model-cell__meta`}>
        <span className={`${C}-model-cell__label`}>{slotLabel}</span>
        <span className={`${C}-model-cell__desc`}>{slotDesc}</span>
      </div>
      <Select
        className={`${C}-model-select ${!isConfigured ? 'is-empty' : ''}`}
        size="small"
        options={options}
        value={selectedValue}
        onChange={handleSelect}
        placeholder={defaultLabel}
      />
    </div>
  );
};
const PersonaView: React.FC<{ workspacePath: string }> = ({ workspacePath }) => {
  const { t } = useTranslation('scenes/profile');

  // Initialize identity from localStorage immediately (lazy initializer avoids flash)
  const [identity, setIdentity] = useState<{ name: string; desc: string }>(() => {
    try {
      const s = localStorage.getItem(IDENTITY_KEY);
      if (s) return JSON.parse(s) as { name: string; desc: string };
    } catch { /* ignore */ }
    return { name: DEFAULT_NAME, desc: '' };
  });
  const [editingField, setEditingField] = useState<'name' | 'desc' | null>(null);
  const [editValue, setEditValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLInputElement>(null);

  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [, setDefaultModels] = useState<DefaultModelsConfig | null>(null);
  const [funcAgentModels, setFuncAgentModels] = useState<Record<string, string>>({});
  const [rules, setRules] = useState<AIRule[]>([]);
  const [memories, setMemories] = useState<AIMemory[]>([]);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);
  const [agenticConfig, setAgenticConfig] = useState<ModeConfigItem | null>(null);
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [aiExp, setAiExp] = useState<Partial<AIExperienceConfig>>({
    enable_visual_mode: false,
    enable_session_title_generation: true,
    enable_welcome_panel_ai_analysis: true,
  });

  // loading maps (optimistic toggle)
  const [rulesLoading,   setRulesLoading]   = useState<Record<string, boolean>>({});
  const [memoriesLoading, setMemoriesLoading] = useState<Record<string, boolean>>({});
  const [toolsLoading,   setToolsLoading]   = useState<Record<string, boolean>>({});
  const [skillsLoading,  setSkillsLoading]  = useState<Record<string, boolean>>({});

  const [rulesExpanded,    setRulesExpanded]    = useState(false);
  const [memoriesExpanded, setMemoriesExpanded] = useState(false);
  const [skillsExpanded,   setSkillsExpanded]   = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [toolQuery, setToolQuery] = useState('');

  const [activeZone, setActiveZone] = useState<'brain' | 'capabilities' | 'interaction'>('brain');
  const [railExpanded, setRailExpanded] = useState(false);

  const [radarOpen,    setRadarOpen]    = useState(false);
  const [radarClosing, setRadarClosing] = useState(false);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // home ↔ detail view transition
  const [detailMode, setDetailMode] = useState(false);

  // section refs for radar-click scroll navigation
  const rulesRef     = useRef<HTMLDivElement>(null);
  const memoryRef    = useRef<HTMLDivElement>(null);
  const toolsRef     = useRef<HTMLDivElement>(null);
  const skillsRef    = useRef<HTMLDivElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);
  const prefsRef     = useRef<HTMLDivElement>(null);

  // detail section ref (kept for internal scroll-to section)
  const detailRef = useRef<HTMLDivElement>(null);

  // panel refs for wheel drag mechanics
  const brainPanelRef        = useRef<HTMLDivElement>(null);
  const capabilitiesPanelRef = useRef<HTMLDivElement>(null);
  const interactionPanelRef  = useRef<HTMLDivElement>(null);
  const dragAccumRef         = useRef(0);
  const dragTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSwitchingRef       = useRef(false);
  // tab-rail dot refs for drag animation
  const tabDotsRef           = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [u, p, m] = await Promise.all([
          AIRulesAPI.getRules(RuleLevel.User),
          AIRulesAPI.getRules(RuleLevel.Project, workspacePath || undefined),
          getAllMemories(),
        ]);
        setRules([...u, ...p]);
        setMemories(m);
      } catch (e) { log.error('rules/memory', e); }
    })();
  }, [workspacePath]);

  useEffect(() => {
    const init = async () => {
      try { await promptTemplateService.initialize(); } finally {
        setTemplates(promptTemplateService.getAllTemplates());
      }
    };
    init();
    return promptTemplateService.subscribe(() => setTemplates(promptTemplateService.getAllTemplates()));
  }, []);

  const loadCaps = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const [tools, mcps, sks, modeConf, allModels, defModels, funcModels, exp] = await Promise.all([
        invoke<ToolInfo[]>('get_all_tools_info').catch(() => [] as ToolInfo[]),
        MCPAPI.getServers().catch(() => [] as MCPServerInfo[]),
        configAPI.getSkillConfigs({
          workspacePath: workspacePath || undefined,
        }).catch(() => [] as SkillInfo[]),
        configAPI.getModeConfig('agentic').catch(() => null as ModeConfigItem | null),
        (configManager.getConfig<AIModelConfig[]>('ai.models') as Promise<AIModelConfig[]>).catch(() => [] as AIModelConfig[]),
        (configManager.getConfig<DefaultModelsConfig>('ai.default_models') as Promise<DefaultModelsConfig | null>).catch(() => null),
        (configManager.getConfig<Record<string, string>>('ai.func_agent_models') as Promise<Record<string, string>>).catch(() => ({} as Record<string, string>)),
        configAPI.getConfig('app.ai_experience').catch(() => null) as Promise<AIExperienceConfig | null>,
      ]);
      setAvailableTools(tools);
      setMcpServers(mcps);
      setSkills(sks);
      setAgenticConfig(modeConf);
      setModels(allModels ?? []);
      setDefaultModels(defModels);
      setFuncAgentModels(funcModels ?? {});
      if (exp) setAiExp(exp);
    } catch (e) { log.error('capabilities', e); }
  }, [workspacePath]);
  useEffect(() => { loadCaps(); }, [loadCaps]);

  const startEdit = (field: 'name' | 'desc') => {
    setEditingField(field);
    setEditValue(field === 'name' ? identity.name : (identity.desc || t('defaultDesc')));
    setTimeout(() => (field === 'name' ? nameInputRef : descInputRef).current?.focus(), 10);
  };
  const commitEdit = useCallback(() => {
    if (!editingField) return;
    const fallback = editingField === 'name' ? DEFAULT_NAME : t('defaultDesc');
    const updated = { ...identity, [editingField === 'name' ? 'name' : 'desc']: editValue.trim() || fallback };
    setIdentity(updated);
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(updated));
    setEditingField(null);
  }, [editingField, editValue, identity, t]);
  const onEditKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditingField(null);
  };

  const openRadar  = useCallback(() => setRadarOpen(true), []);
  const closeRadar = useCallback(() => {
    setRadarClosing(true);
    closingTimer.current = setTimeout(() => { setRadarOpen(false); setRadarClosing(false); }, 220);
  }, []);
  useEffect(() => {
    if (!radarOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRadar(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [radarOpen, closeRadar]);
  useEffect(() => () => { if (closingTimer.current) clearTimeout(closingTimer.current); }, []);

  const ZONE_TABS = useMemo(() => [
    { id: 'brain'        as const, Icon: Brain,   label: t('sections.brain'),        shortLabel: t('nav.brain',        { defaultValue: '大脑' }) },
    { id: 'capabilities' as const, Icon: Zap,     label: t('sections.capabilities'), shortLabel: t('nav.capabilities', { defaultValue: '能力' }) },
    { id: 'interaction'  as const, Icon: Sliders,  label: t('sections.interaction'),  shortLabel: t('nav.interaction',  { defaultValue: '交互' }) },
  ], [t]);

  const dimToZone = useMemo<Record<string, 'brain' | 'capabilities' | 'interaction'>>(() => ({
    [t('radar.dims.rigor')]:        'brain',
    [t('radar.dims.memory')]:       'brain',
    [t('radar.dims.autonomy')]:     'capabilities',
    [t('radar.dims.adaptability')]: 'capabilities',
    [t('radar.dims.creativity')]:   'interaction',
    [t('radar.dims.expression')]:   'interaction',
  }), [t]);

  const handleRadarDimClick = useCallback((label: string) => {
    const zone = dimToZone[label];
    const refMap: Record<string, React.RefObject<HTMLDivElement>> = {
      [t('radar.dims.rigor')]:        rulesRef,
      [t('radar.dims.memory')]:       memoryRef,
      [t('radar.dims.autonomy')]:     toolsRef,
      [t('radar.dims.adaptability')]: skillsRef,
      [t('radar.dims.creativity')]:   templatesRef,
      [t('radar.dims.expression')]:   prefsRef,
    };
    if (zone) setActiveZone(zone);
    // delay to let panel become visible before scrollIntoView
    setTimeout(() => {
      const target = refMap[label];
      if (target?.current) {
        target.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.current.classList.add('is-pulse');
        setTimeout(() => target.current?.classList.remove('is-pulse'), 900);
      }
    }, 60);
    if (radarOpen) closeRadar();
  }, [dimToZone, radarOpen, closeRadar, t]);

  const handleModelChange = useCallback(async (key: string, id: string) => {
    try {
      const cur = await (configManager.getConfig<Record<string, string>>('ai.func_agent_models') as Promise<Record<string, string> | null>).catch(() => null) ?? {};
      const upd = { ...cur, [key]: id };
      await configManager.setConfig('ai.func_agent_models', upd);
      setFuncAgentModels(upd);
      notificationService.success(t('notifications.modelUpdated'), { duration: 1500 });
    } catch (e) { log.error('model update', e); notificationService.error(t('notifications.updateFailed')); }
  }, [t]);

  const toggleRule = useCallback(async (rule: AIRule) => {
    const key = `${rule.level}-${rule.name}`;
    const newEnabled = !rule.enabled;
    setRulesLoading(p => ({ ...p, [key]: true }));
    setRules(p => p.map(r => r.name === rule.name && r.level === rule.level ? { ...r, enabled: newEnabled } : r));
    try {
      await AIRulesAPI.updateRule(
        rule.level === RuleLevel.User ? RuleLevel.User : RuleLevel.Project,
        rule.name,
        { enabled: newEnabled },
        rule.level === RuleLevel.Project ? workspacePath || undefined : undefined,
      );
    } catch (e) {
      log.error('rule toggle', e);
      setRules(p => p.map(r => r.name === rule.name && r.level === rule.level ? { ...r, enabled: rule.enabled } : r));
      notificationService.error(t('notifications.toggleFailed'));
    } finally { setRulesLoading(p => { const n = { ...p }; delete n[key]; return n; }); }
  }, [t, workspacePath]);

  const toggleMem = useCallback(async (mem: AIMemory) => {
    setMemoriesLoading(p => ({ ...p, [mem.id]: true }));
    setMemories(p => p.map(m => m.id === mem.id ? { ...m, enabled: !m.enabled } : m));
    try { await toggleMemory(mem.id); }
    catch (e) {
      log.error('memory toggle', e);
      setMemories(p => p.map(m => m.id === mem.id ? { ...m, enabled: mem.enabled } : m));
      notificationService.error(t('notifications.toggleFailed'));
    } finally { setMemoriesLoading(p => { const n = { ...p }; delete n[mem.id]; return n; }); }
  }, [t]);

  const toggleTool = useCallback(async (name: string) => {
    if (!agenticConfig) return;
    setToolsLoading(p => ({ ...p, [name]: true }));
    const tools = agenticConfig.available_tools ?? [];
    const newTools = tools.includes(name) ? tools.filter(t => t !== name) : [...tools, name];
    const newCfg = { ...agenticConfig, available_tools: newTools };
    setAgenticConfig(newCfg);
    try {
      await configAPI.setModeConfig('agentic', newCfg);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
    } catch (e) {
      log.error('tool toggle', e);
      setAgenticConfig(agenticConfig);
      notificationService.error(t('notifications.toggleFailed'));
    } finally { setToolsLoading(p => { const n = { ...p }; delete n[name]; return n; }); }
  }, [agenticConfig, t]);

  const selectAllTools = useCallback(async () => {
    if (!agenticConfig) return;
    const c = { ...agenticConfig, available_tools: availableTools.map(t => t.name) };
    setAgenticConfig(c);
    try { await configAPI.setModeConfig('agentic', c); } catch { setAgenticConfig(agenticConfig); }
  }, [agenticConfig, availableTools]);

  const clearAllTools = useCallback(async () => {
    if (!agenticConfig) return;
    const c = { ...agenticConfig, available_tools: [] };
    setAgenticConfig(c);
    try { await configAPI.setModeConfig('agentic', c); } catch { setAgenticConfig(agenticConfig); }
  }, [agenticConfig]);

  const resetTools = useCallback(async () => {
    if (!window.confirm(t('notifications.resetConfirm'))) return;
    try { await configAPI.resetModeConfig('agentic'); await loadCaps(); notificationService.success(t('notifications.resetSuccess')); }
    catch { notificationService.error(t('notifications.resetFailed')); }
  }, [loadCaps, t]);

  const toggleSkill = useCallback(async (sk: SkillInfo) => {
    const newEnabled = !sk.enabled;
    setSkillsLoading(p => ({ ...p, [sk.name]: true }));
    setSkills(p => p.map(s => s.name === sk.name ? { ...s, enabled: newEnabled } : s));
    try {
      await configAPI.setSkillEnabled({
        skillName: sk.name,
        enabled: newEnabled,
        workspacePath: workspacePath || undefined,
      });
    }
    catch (e) {
      log.error('skill toggle', e);
      setSkills(p => p.map(s => s.name === sk.name ? { ...s, enabled: sk.enabled } : s));
      notificationService.error(t('notifications.toggleFailed'));
    } finally { setSkillsLoading(p => { const n = { ...p }; delete n[sk.name]; return n; }); }
  }, [t, workspacePath]);

  const togglePref = useCallback(async (key: keyof AIExperienceConfig) => {
    const cur = aiExp[key] as boolean;
    setAiExp(p => ({ ...p, [key]: !cur }));
    try { await configAPI.setConfig(`app.ai_experience.${key}`, !cur); }
    catch { setAiExp(p => ({ ...p, [key]: cur })); }
  }, [aiExp]);

  const openSkillsScene = useCallback(() => {
    window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'skills' } }));
  }, []);

  const goToDetail = useCallback((zone?: ZoneId) => {
    if (zone) setActiveZone(zone);
    setDetailMode(true);
  }, []);

  const goToHome = useCallback(() => {
    setDetailMode(false);
  }, []);

  const scrollToZone = useCallback((zone: ZoneId) => {
    goToDetail(zone);
  }, [goToDetail]);

  // Helper: get panel DOM element by zone id
  const getPanel = useCallback((id: ZoneId) => {
    if (id === 'brain')        return brainPanelRef.current;
    if (id === 'capabilities') return capabilitiesPanelRef.current;
    return interactionPanelRef.current;
  }, []);

  // Tab click — simple crossfade
  const handleTabClick = useCallback((id: ZoneId) => {
    if (id === activeZone || isSwitchingRef.current) return;
    isSwitchingRef.current = true;
    const cur = getPanel(activeZone);
    if (cur) {
      cur.style.transition = 'opacity 0.14s ease';
      cur.style.opacity = '0';
    }
    setTimeout(() => {
      if (cur) { cur.style.transition = ''; cur.style.opacity = ''; }
      setActiveZone(id);
      isSwitchingRef.current = false;
    }, 140);
  }, [activeZone, getPanel]);

  // Wheel — elastic resistance + ghost preview + slide switch + dot merge animation
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (isSwitchingRef.current) return;

    const curPanel = getPanel(activeZone);
    if (!curPanel) return;

    const goDown = e.deltaY > 0;
    const atBottom = curPanel.scrollTop + curPanel.clientHeight >= curPanel.scrollHeight - 2;
    const atTop    = curPanel.scrollTop <= 0;
    if (goDown && !atBottom) return;
    if (!goDown && !atTop)   return;

    const dir    = goDown ? 1 : -1;
    const idx    = ZONE_ORDER.indexOf(activeZone);
    const nextId = ZONE_ORDER[idx + dir] as ZoneId | undefined;
    if (!nextId) return;

    if (dragAccumRef.current !== 0 && Math.sign(e.deltaY) !== Math.sign(dragAccumRef.current)) {
      dragAccumRef.current = e.deltaY;
    } else {
      dragAccumRef.current += e.deltaY;
    }
    const accum    = dragAccumRef.current;
    const progress = Math.min(Math.abs(accum) / DRAG_THRESHOLD, 1);

    // ── panel visual feedback ──────────────────────────
    const displace  = elasticDisplace(accum);
    const gOpacity  = ghostOpacity(accum);
    const nextPanel = getPanel(nextId);

    curPanel.style.transform = `translateY(${displace}px)`;
    curPanel.style.opacity   = String(1 - gOpacity * 0.25);

    if (nextPanel) {
      if (gOpacity > 0) {
        const t = Math.min(Math.abs(accum) / DRAG_THRESHOLD, 1);
        const ghostOffset = dir * 28 * (1 - (t - 0.5) / 0.5);
        nextPanel.style.display        = 'flex';
        nextPanel.style.flexDirection  = 'column';
        nextPanel.style.position       = 'absolute';
        nextPanel.style.inset          = '0';
        nextPanel.style.overflowY      = 'hidden';
        nextPanel.style.pointerEvents  = 'none';
        nextPanel.style.zIndex         = '0';
        nextPanel.style.transform      = `translateY(${ghostOffset}px)`;
        nextPanel.style.opacity        = String(gOpacity);
      } else {
        nextPanel.style.display   = '';
        nextPanel.style.position  = '';
        nextPanel.style.transform = '';
        nextPanel.style.opacity   = '';
      }
    }

    // ── dot merge animation ────────────────────────────
    const curDot  = tabDotsRef.current[idx];
    const nextDot = tabDotsRef.current[idx + dir];

    if (curDot) {
      // active dot stretches into a pill toward the next dot
      const stretchH    = 8 + progress * 18;           // 8px → 26px
      const pillMove    = dir * (stretchH - 8) / 2;    // keep one edge anchored
      curDot.style.transition  = 'none';
      curDot.style.height      = `${stretchH}px`;
      curDot.style.borderRadius = progress > 0.08 ? '3px' : '50%';
      curDot.style.transform   = `translateY(${pillMove}px)`;
    }
    if (nextDot) {
      // next dot grows and brightens with accent color
      const nextScale = 1 + progress * 0.65;
      nextDot.style.transition  = 'none';
      nextDot.style.transform   = `scale(${nextScale})`;
      nextDot.style.background  = 'var(--color-accent-500)';
      nextDot.style.opacity     = String(0.25 + progress * 0.75);
    }

    // ── threshold → execute switch ─────────────────────
    if (Math.abs(accum) >= DRAG_THRESHOLD) {
      if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
      isSwitchingRef.current = true;
      dragAccumRef.current   = 0;

      curPanel.style.transition = 'transform 0.22s cubic-bezier(0.4,0,1,0.6), opacity 0.22s ease';
      curPanel.style.transform  = `translateY(${dir * -44}px)`;
      curPanel.style.opacity    = '0';

      if (nextPanel) {
        nextPanel.style.transition    = '';
        nextPanel.style.position      = 'absolute';
        nextPanel.style.inset         = '0';
        nextPanel.style.display       = 'flex';
        nextPanel.style.flexDirection = 'column';
        nextPanel.style.overflowY     = 'auto';
        nextPanel.style.zIndex        = '1';
        nextPanel.style.pointerEvents = 'none';
        nextPanel.style.transform     = `translateY(${dir * 34}px)`;
        nextPanel.style.opacity       = '0.28';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (nextPanel) {
            nextPanel.style.transition = 'transform 0.28s cubic-bezier(0.2,0,0.2,1), opacity 0.28s ease';
            nextPanel.style.transform  = '';
            nextPanel.style.opacity    = '';
          }
        }));
      }

      // commit state — clear all inline styles so CSS class takes over
      setTimeout(() => {
        curPanel.style.cssText = '';
        if (nextPanel) nextPanel.style.cssText = '';
        if (curDot)  curDot.style.cssText  = '';
        if (nextDot) nextDot.style.cssText  = '';
        setActiveZone(nextId);
        isSwitchingRef.current = false;
      }, 295);
      return;
    }

    // ── spring-back timer ──────────────────────────────
    if (dragTimerRef.current) clearTimeout(dragTimerRef.current);
    dragTimerRef.current = setTimeout(() => {
      dragAccumRef.current = 0;
      dragTimerRef.current = null;

      // panel spring back with overshoot
      curPanel.style.transition = 'transform 0.36s cubic-bezier(0.34,1.56,0.64,1), opacity 0.28s ease';
      curPanel.style.transform  = '';
      curPanel.style.opacity    = '';
      setTimeout(() => { curPanel.style.transition = ''; }, 360);

      if (nextPanel && parseFloat(nextPanel.style.opacity || '0') > 0) {
        nextPanel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        nextPanel.style.opacity    = '0';
        setTimeout(() => { if (nextPanel) nextPanel.style.cssText = ''; }, 200);
      }

      // dot spring back — current dot un-stretches with overshoot
      if (curDot) {
        curDot.style.transition   = 'height 0.36s cubic-bezier(0.34,1.56,0.64,1), transform 0.36s cubic-bezier(0.34,1.56,0.64,1), border-radius 0.2s ease';
        curDot.style.height       = '';
        curDot.style.borderRadius = '';
        curDot.style.transform    = '';
        setTimeout(() => { if (curDot) curDot.style.transition = ''; }, 360);
      }
      if (nextDot) {
        nextDot.style.transition  = 'transform 0.22s ease, opacity 0.22s ease, background 0.22s ease';
        nextDot.style.transform   = '';
        nextDot.style.opacity     = '';
        nextDot.style.background  = '';
        setTimeout(() => { if (nextDot) nextDot.style.transition = ''; }, 220);
      }
    }, 160);
  }, [activeZone, getPanel]);

  const sortRules = useMemo(() =>
    [...rules].sort((a, b) => a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1), [rules]);
  const sortMem = useMemo(() =>
    [...memories].sort((a, b) => a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : b.importance - a.importance),
    [memories]);
  const sortTools = useMemo(() => {
    const en = agenticConfig?.available_tools ?? [];
    return [...availableTools].sort((a, b) => {
      const ao = en.includes(a.name), bo = en.includes(b.name);
      return ao !== bo ? (ao ? -1 : 1) : a.name.localeCompare(b.name);
    });
  }, [availableTools, agenticConfig]);
  const sortSkills = useMemo(() =>
    [...skills].sort((a, b) => a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : a.name.localeCompare(b.name)),
    [skills]);
  const sortTemplates = useMemo(() =>
    [...templates].sort((a, b) => a.isFavorite !== b.isFavorite ? (a.isFavorite ? -1 : 1) : b.usageCount - a.usageCount),
    [templates]);
  const userRulesList = useMemo(
    () => sortRules.filter(rule => rule.level === RuleLevel.User),
    [sortRules],
  );
  const projectRulesList = useMemo(
    () => sortRules.filter(rule => rule.level === RuleLevel.Project),
    [sortRules],
  );
  const filteredTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    if (!query) return sortTools;
    return sortTools.filter(tool =>
      tool.name.toLowerCase().includes(query)
      || tool.description.toLowerCase().includes(query),
    );
  }, [sortTools, toolQuery]);
  const visibleTools = useMemo(
    () => (toolsExpanded ? filteredTools : filteredTools.slice(0, TOOL_LIST_LIMIT)),
    [filteredTools, toolsExpanded],
  );
  const visibleSkills = useMemo(
    () => (skillsExpanded ? sortSkills : sortSkills.slice(0, SKILL_GRID_LIMIT)),
    [sortSkills, skillsExpanded],
  );

  const enabledRules = useMemo(() => rules.filter(r => r.enabled).length, [rules]);
  const userRules    = useMemo(() => rules.filter(r => r.level === RuleLevel.User).length, [rules]);
  const projRules    = useMemo(() => rules.filter(r => r.level === RuleLevel.Project).length, [rules]);
  const enabledMems  = useMemo(() => memories.filter(m => m.enabled).length, [memories]);
  const enabledTools = useMemo(() => agenticConfig?.available_tools?.length ?? 0, [agenticConfig]);
  const enabledSkls  = useMemo(() => skills.filter(s => s.enabled).length, [skills]);
  const healthyMcp   = useMemo(() => mcpServers.filter(s => s.status === 'Healthy' || s.status === 'Connected').length, [mcpServers]);

  const skillEn  = useMemo(() => skills.filter(s => s.enabled), [skills]);
  const memEn    = useMemo(() => memories.filter(m => m.enabled).length, [memories]);
  const rulesEn  = useMemo(() => rules.filter(r => r.enabled), [rules]);
  const avgImp   = useMemo(() => memEn > 0 ? memories.filter(m => m.enabled).reduce((s, m) => s + m.importance, 0) / memEn : 0, [memories, memEn]);
  const favCount = useMemo(() => templates.filter(t => t.isFavorite).length, [templates]);
  const radarDims = useMemo(() => [
    { label: t('radar.dims.creativity'),   value: Math.min(10, templates.length * 0.6 + skillEn.length * 0.5) },
    { label: t('radar.dims.rigor'),        value: Math.min(10, rulesEn.length * 1.5) },
    { label: t('radar.dims.autonomy'),     value: agenticConfig?.enabled
      ? Math.min(10, 4 + (agenticConfig.available_tools?.length ?? 0) * 0.25 + mcpServers.length * 0.5)
      : Math.min(10, enabledTools * 0.3 + healthyMcp * 0.8) },
    { label: t('radar.dims.memory'),       value: Math.min(10, memEn * 0.7 + avgImp * 0.3) },
    { label: t('radar.dims.expression'),   value: Math.min(10, templates.length * 0.5 + favCount * 1.2) },
    { label: t('radar.dims.adaptability'), value: Math.min(10, skillEn.length * 1.2 + mcpServers.length * 0.8) },
  ], [templates, skillEn, rulesEn, agenticConfig, mcpServers, enabledTools, healthyMcp, memEn, avgImp, favCount, t]);

  // model slot current IDs (with fallbacks)
  const slotIds: Record<ModelSlotKey, string> = useMemo(() => ({
    primary:     funcAgentModels['primary']     ?? 'primary',
    fast:        funcAgentModels['fast']        ?? 'fast',
    compression: funcAgentModels['compression'] ?? 'fast',
    image:       funcAgentModels['image']       ?? '',
    voice:       funcAgentModels['voice']       ?? '',
    retrieval:   funcAgentModels['retrieval']   ?? '',
  }), [funcAgentModels]);

  // Tool KPI text
  const toolKpi = useMemo(() => {
    if (mcpServers.length > 0) {
      return t('kpi.toolStatsMcp', {
        enabled: enabledTools,
        total: availableTools.length,
        mcpHealthy: healthyMcp,
        mcpTotal: mcpServers.length,
      });
    }
    return t('kpi.toolStats', { enabled: enabledTools, total: availableTools.length });
  }, [t, enabledTools, availableTools.length, healthyMcp, mcpServers.length]);

  // Preference items — computed inside render to use t()
  const prefItems = useMemo(() => [
    {
      key: 'enable_visual_mode' as keyof AIExperienceConfig,
      label: t('prefs.visualMode'),
      desc:  t('prefs.visualModeDesc'),
    },
    {
      key: 'enable_session_title_generation' as keyof AIExperienceConfig,
      label: t('prefs.sessionTitle'),
      desc:  t('prefs.sessionTitleDesc'),
    },
    {
      key: 'enable_welcome_panel_ai_analysis' as keyof AIExperienceConfig,
      label: t('prefs.welcomeAnalysis'),
      desc:  t('prefs.welcomeAnalysisDesc'),
    },
  ], [t]);

  const HOME_ZONES = useMemo(() => [
    { id: 'brain'        as ZoneId, Icon: Brain,   label: t('sections.brain'),        desc: t('home.brainDesc',        { defaultValue: '模型 · 规则 · 记忆' }) },
    { id: 'capabilities' as ZoneId, Icon: Zap,     label: t('sections.capabilities'), desc: t('home.capabilitiesDesc', { defaultValue: '工具 · 技能 · MCP' }) },
    { id: 'interaction'  as ZoneId, Icon: Sliders, label: t('sections.interaction'),  desc: t('home.interactionDesc',  { defaultValue: '模板 · 偏好' }) },
  ], [t]);

  return (
    <div className={C}>

      {/* ══════════ Home / 首页 ══════════════════════════════ */}
      <section className={`${C}-home${detailMode ? ' is-hidden' : ''}`}>

        {/* Left — Full-body panda */}
        <div className={`${C}-home__left`}>
          <div className={`${C}-home__panda`}>
            <img className={`${C}-home__panda-img ${C}-home__panda-img--default`} src="/panda_full_1.png" alt={t('hero.avatarAlt', { defaultValue: 'Agent avatar' })} />
            <img className={`${C}-home__panda-img ${C}-home__panda-img--hover`} src="/panda_full_2.png" alt="" />
          </div>
        </div>

        {/* Right — Identity + body row + CTA */}
        <div className={`${C}-home__right`}>

          {/* Name row */}
          <div className={`${C}-home__name-row`}>
            {editingField === 'name' ? (
              <Input
                ref={nameInputRef}
                className={`${C}-home__name-input`}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={onEditKey}
                inputSize="small"
              />
            ) : (
              <h1
                className={`${C}-home__name`}
                onClick={() => startEdit('name')}
                title={t('hero.editNameTitle')}
              >
                {identity.name}
                <Pencil size={12} className={`${C}-home__name-edit`} strokeWidth={1.5} />
              </h1>
            )}
            <div className={`${C}-home__wip`} title="功能开发中，敬请期待">
              <span className={`${C}-home__wip-dot`} />
              WIP · 建设中
            </div>
          </div>

          {/* Description + Radar side by side */}
          <div className={`${C}-home__body-row`}>
            <div className={`${C}-home__desc-block`} onClick={() => !editingField && startEdit('desc')}>
              {editingField === 'desc' ? (
                <Input
                  ref={descInputRef}
                  className={`${C}-home__desc-input`}
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={onEditKey}
                  placeholder={t('hero.descPlaceholder')}
                  inputSize="small"
                />
              ) : (
                <p
                  className={`${C}-home__desc`}
                  title={t('hero.editDescTitle')}
                >
                  {identity.desc || t('defaultDesc')}
                </p>
              )}
              {!editingField && (
                <p className={`${C}-home__desc-block-hint`}>
                  {t('home.descHint', { defaultValue: '点击编辑，描述你的大熊猫 Agent 风格与偏好' })}
                </p>
              )}
            </div>
          </div>

          {/* Hint + inline CTA */}
          <p className={`${C}-home__hint`}>
            {t('home.hint', { defaultValue: '选择章节装配你的大熊猫，或' })}
            <button type="button" className={`${C}-home__enter`} onClick={() => goToDetail()}>
              {t('home.viewDetail', { defaultValue: '查看详情' })}
            </button>
          </p>

          {/* Category chips */}
          <div className={`${C}-home__action-row`}>
            {HOME_ZONES.map(({ id, Icon, label, desc }) => (
              <button
                key={id}
                type="button"
                className={`${C}-home__cat`}
                onClick={() => scrollToZone(id)}
              >
                <Icon size={14} strokeWidth={1.8} />
                <span className={`${C}-home__cat-label`}>{label}</span>
                <span className={`${C}-home__cat-desc`}>{desc}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════ Detail / 章节 ═════════════════════════════ */}
      <div ref={detailRef} className={`${C}-detail${detailMode ? '' : ' is-hidden'}`}>

      {/* ── Persistent header ────────────────────────────── */}
      <header className={`${C}-hero`}>
        <div className={`${C}-hero__left`}>
          <div
            className={`${C}-hero__panda`}
            role="button"
            tabIndex={0}
            onClick={goToHome}
            title={t('hero.backTitle', { defaultValue: '点击返回首页' })}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToHome(); } }}
          >
            <img className={`${C}-hero__panda-default`} src="/panda_full_1.png" alt={t('hero.avatarAlt', { defaultValue: 'Agent avatar' })} />
            <img className={`${C}-hero__panda-hover`} src="/panda_full_2.png" alt="" />
          </div>
          <div className={`${C}-hero__info`}>
            <div className={`${C}-hero__name-row`}>
              <h2 className={`${C}-hero__name`} onClick={() => startEdit('name')} title={t('hero.editNameTitle')}>
                {identity.name}
                <Pencil size={10} className={`${C}-hero__name-edit`} strokeWidth={1.6} />
              </h2>
            </div>
            <p className={`${C}-hero__desc`} onClick={() => startEdit('desc')} title={t('hero.editDescTitle')}>
              {identity.desc || t('defaultDesc')}
            </p>
          </div>
        </div>
        <div className={`${C}-hero__radar`} title={t('hero.radarTitle')}>
          <PersonaRadar dims={radarDims} size={110} onDimClick={handleRadarDimClick} onChartClick={openRadar} />
        </div>
      </header>

      {/* ── Content: zone viewport + tab rail ───────────── */}
      <div className={`${C}-content`}>
        <div className={`${C}-zone-viewport`} onWheel={handleWheel}>

          {/* Brain */}
          <div className={`${C}-zone-panel ${activeZone === 'brain' ? 'is-active' : ''}`} ref={brainPanelRef}>
          <div className={`${C}-zone-inner`}>
            <div className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.model')}</span>
                <button type="button" className={`${C}-link`} onClick={() => navToSettings('models')}>
                  {t('actions.globalManage')} <ChevronRight size={11} />
                </button>
              </div>
              <div className={`${C}-model-grid`}>
                <div className={`${C}-model-grid__col ${C}-model-grid__col--primary`}>
                  {(['primary', 'fast'] as ModelSlotKey[]).map(key => (
                    <ModelPill
                      key={key}
                      slotKey={key}
                      slotLabel={t(`modelSlots.${key}.label`)}
                      slotDesc={t(`modelSlots.${key}.desc`)}
                      currentId={slotIds[key]}
                      models={models}
                      onChange={id => handleModelChange(key, id)}
                    />
                  ))}
                </div>
                <div className={`${C}-model-grid__divider`} />
                <div className={`${C}-model-grid__col ${C}-model-grid__col--secondary`}>
                  {(['compression', 'image', 'voice', 'retrieval'] as ModelSlotKey[]).map(key => (
                    <ModelPill
                      key={key}
                      slotKey={key}
                      slotLabel={t(`modelSlots.${key}.label`)}
                      slotDesc={t(`modelSlots.${key}.desc`)}
                      currentId={slotIds[key]}
                      models={models}
                      onChange={id => handleModelChange(key, id)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div ref={rulesRef} className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.rules')}</span>
                <span className={`${C}-card__kpi`}>
                  {t('kpi.rules', { user: userRules, project: projRules, enabled: enabledRules })}
                </span>
                <button type="button" className={`${C}-link`} onClick={() => navToSettings('ai-context')}>
                  {t('actions.manage')} <ChevronRight size={11} />
                </button>
              </div>
              {sortRules.length === 0 && <span className={`${C}-empty-hint`}>{t('empty.rules')}</span>}
              {sortRules.length > 0 && (
                <>
                  {[
                    { label: 'User', items: userRulesList },
                    { label: 'Project', items: projectRulesList },
                  ].map(group => {
                    const groupItems = rulesExpanded ? group.items : group.items.slice(0, CHIP_LIMIT);
                    if (group.items.length === 0) return null;
                    return (
                      <div key={group.label} className={`${C}-rules-group`}>
                        <span className={`${C}-rules-group__label`}>{group.label}</span>
                        <div className={`${C}-chip-row`}>
                          {groupItems.map(rule => (
                            <ToggleChip
                              key={`${rule.level}-${rule.name}`}
                              label={rule.name}
                              enabled={rule.enabled}
                              onToggle={() => toggleRule(rule)}
                              accentColor="#60a5fa"
                              loading={rulesLoading[`${rule.level}-${rule.name}`]}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {rules.length > CHIP_LIMIT && (
                    <button type="button" className={`${C}-chip ${C}-chip--more`} onClick={() => setRulesExpanded(v => !v)}>
                      {rulesExpanded ? t('actions.collapse') : `+${rules.length - CHIP_LIMIT}`}
                    </button>
                  )}
                </>
              )}
            </div>
            <div ref={memoryRef} className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.memory')}</span>
                <span className={`${C}-card__kpi`}>{t('kpi.memory', { count: enabledMems })}</span>
                <button type="button" className={`${C}-link`} onClick={() => navToSettings('ai-context')}>
                  {t('actions.manage')} <ChevronRight size={11} />
                </button>
              </div>
              <div className={`${C}-chip-row`}>
                {(memories.length > CHIP_LIMIT && !memoriesExpanded ? sortMem.slice(0, CHIP_LIMIT) : sortMem).map(m => (
                  <div key={m.id} className={`${C}-memory-chip`}>
                    <ToggleChip
                      label={m.title}
                      enabled={m.enabled}
                      onToggle={() => toggleMem(m)}
                      accentColor="#c9944d"
                      loading={memoriesLoading[m.id]}
                      tooltip={m.title}
                    />
                    <span className={`${C}-imp-dots`} aria-hidden="true">
                      {Array.from({ length: getImportanceDotCount(m.importance) }, (_, index) => (
                        <span
                          key={`${m.id}-dot-${index + 1}`}
                          className={`${C}-imp-dot ${m.enabled ? 'is-on' : 'is-off'}`}
                        />
                      ))}
                    </span>
                  </div>
                ))}
                {sortMem.length === 0 && <span className={`${C}-empty-hint`}>{t('empty.memory')}</span>}
                {memories.length > CHIP_LIMIT && (
                  <button type="button" className={`${C}-chip ${C}-chip--more`} onClick={() => setMemoriesExpanded(v => !v)}>
                    {memoriesExpanded ? t('actions.collapse') : `+${memories.length - CHIP_LIMIT}`}
                  </button>
                )}
              </div>
            </div>
          </div></div>

          {/* Capabilities */}
          <div className={`${C}-zone-panel ${activeZone === 'capabilities' ? 'is-active' : ''}`} ref={capabilitiesPanelRef}>
          <div className={`${C}-zone-inner`}>
            <div ref={toolsRef} className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.toolsMcp')}</span>
                <span className={`${C}-card__kpi`}>{toolKpi}</span>
                <div className={`${C}-card__actions`}>
                  <button type="button" className={`${C}-icon-btn`} onClick={selectAllTools} title={t('actions.selectAll')}>
                    <ListChecks size={13} strokeWidth={1.8} />
                  </button>
                  <button type="button" className={`${C}-icon-btn`} onClick={clearAllTools} title={t('actions.clearAll')}>
                    <X size={13} strokeWidth={1.8} />
                  </button>
                  <button type="button" className={`${C}-icon-btn`} onClick={resetTools} title={t('actions.reset')}>
                    <RotateCcw size={13} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
              {availableTools.length > 15 && (
                <Search
                  size="small"
                  value={toolQuery}
                  onChange={setToolQuery}
                  placeholder={t('profile.toolSearch', { defaultValue: '搜索工具' })}
                  className={`${C}-tool-search`}
                />
              )}
              <div className={`${C}-tool-grid`}>
                {visibleTools.map(tool => (
                  <ToolToggleRow
                    key={tool.name}
                    name={tool.name}
                    description={tool.description}
                    enabled={agenticConfig?.available_tools?.includes(tool.name) ?? false}
                    loading={toolsLoading[tool.name]}
                    onToggle={() => toggleTool(tool.name)}
                  />
                ))}
              </div>
              {filteredTools.length === 0 && (
                <span className={`${C}-empty-hint`}>
                  {toolQuery.trim()
                    ? t('profile.toolSearchEmpty', { defaultValue: '没有匹配的工具' })
                    : t('empty.tools')}
                </span>
              )}
              {filteredTools.length > TOOL_LIST_LIMIT && (
                <button type="button" className={`${C}-chip ${C}-chip--more`} onClick={() => setToolsExpanded(v => !v)}>
                  {toolsExpanded ? t('actions.collapse') : `+${filteredTools.length - TOOL_LIST_LIMIT}`}
                </button>
              )}
              {mcpServers.length > 0 && (
                <div className={`${C}-mcp-row`}>
                  <span className={`${C}-mcp-row__label`}>MCP</span>
                  {mcpServers.map(srv => {
                    const ok = srv.status === 'Healthy' || srv.status === 'Connected';
                    return (
                      <span key={srv.id} className={`${C}-mcp-tag ${ok ? 'is-ok' : 'is-err'}`}>
                        <span className={`${C}-mcp-tag__dot`} />
                        {srv.name}
                      </span>
                    );
                  })}
                  <button type="button" className={`${C}-link`} onClick={() => navToSettings('mcp-tools')}>
                    {t('actions.manage')} <ChevronRight size={11} />
                  </button>
                </div>
              )}
            </div>
            <div ref={skillsRef} className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.skills')}</span>
                <span className={`${C}-card__kpi`}>{t('kpi.skills', { count: enabledSkls })}</span>
                <button type="button" className={`${C}-link`} onClick={openSkillsScene}>
                  {t('actions.manage')} <ChevronRight size={11} />
                </button>
              </div>
              <div className={`${C}-skill-grid`}>
                {visibleSkills.map(sk => (
                  <SkillMiniCard
                    key={sk.name}
                    name={sk.name}
                    description={sk.description}
                    enabled={sk.enabled}
                    loading={skillsLoading[sk.name]}
                    onToggle={() => toggleSkill(sk)}
                    onOpen={openSkillsScene}
                  />
                ))}
              </div>
              {sortSkills.length === 0 && <span className={`${C}-empty-hint`}>{t('empty.skills')}</span>}
              {skills.length > SKILL_GRID_LIMIT && (
                <button type="button" className={`${C}-chip ${C}-chip--more`} onClick={() => setSkillsExpanded(v => !v)}>
                  {skillsExpanded ? t('actions.collapse') : `+${skills.length - SKILL_GRID_LIMIT}`}
                </button>
              )}
            </div>
          </div></div>

          {/* Interaction */}
          <div className={`${C}-zone-panel ${activeZone === 'interaction' ? 'is-active' : ''}`} ref={interactionPanelRef}>
          <div className={`${C}-zone-inner`}>
            <div ref={templatesRef} className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.templates')}</span>
                <span className={`${C}-card__kpi`}>{t('kpi.templateCount', { count: templates.length })}</span>
                <button type="button" className={`${C}-link`} onClick={() => navToSettings('prompt-templates')}>
                  {t('actions.manage')} <ChevronRight size={11} />
                </button>
              </div>
              <div className={`${C}-chip-row`}>
                {sortTemplates.slice(0, 14).map(tmpl => (
                  <span key={tmpl.id} className={`${C}-tpl-chip ${tmpl.isFavorite ? 'is-fav' : ''}`}>
                    {tmpl.isFavorite && '★ '}{tmpl.name}
                  </span>
                ))}
                {templates.length === 0 && <span className={`${C}-empty-hint`}>{t('empty.templates')}</span>}
              </div>
            </div>
            <div ref={prefsRef} className={`${C}-card`}>
              <div className={`${C}-card__head`}>
                <span className={`${C}-card__label`}>{t('cards.preferences')}</span>
              </div>
              <div className={`${C}-pref-list`}>
                {prefItems.map(({ key, label, desc }) => (
                  <PrefToggleRow
                    key={key}
                    label={label}
                    description={desc}
                    enabled={!!aiExp[key]}
                    onToggle={() => togglePref(key)}
                  />
                ))}
              </div>
            </div>
          </div></div>

        </div>

        {/* ── Tab Rail ─────────────────────────────────── */}
        {/* nav stays 28 px wide in layout; list floats as overlay */}
        <nav
          className={`${C}-tab-rail${railExpanded ? ' is-expanded' : ''}`}
          aria-label="Section navigation"
          onMouseEnter={() => setRailExpanded(true)}
          onMouseLeave={() => setRailExpanded(false)}
        >
          {/* dots column — always in flow */}
          <div className={`${C}-tab-rail__dots`}>
            {ZONE_TABS.map(({ id }, zi) => (
              <button
                key={id}
                type="button"
                className={`${C}-tab-btn ${activeZone === id ? 'is-active' : ''}`}
                onClick={() => handleTabClick(id)}
                aria-pressed={activeZone === id}
              >
                <span
                  className={`${C}-tab-btn__dot`}
                  ref={el => { tabDotsRef.current[zi] = el; }}
                />
              </button>
            ))}
          </div>

          {/* overlay list — absolutely positioned, no layout impact */}
          <div className={`${C}-tab-rail__list`} role="menu">
            {ZONE_TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className={`${C}-tab-rail__item ${activeZone === id ? 'is-active' : ''}`}
                onClick={() => handleTabClick(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      </div>{/* ── /detail ── */}

      {radarOpen && createPortal(
        <div
          className={`${C}-modal${radarClosing ? ' is-closing' : ''}`}
          onClick={closeRadar}
        >
          <div className={`${C}-modal__box`} onClick={e => e.stopPropagation()}>
            <div className={`${C}-modal__head`}>
              <div>
                <p className={`${C}-modal__title`}>{t('radar.title')}</p>
                <p className={`${C}-modal__sub`}>{t('radar.subtitle')}</p>
              </div>
              <button className={`${C}-modal__close`} onClick={closeRadar}>
                <X size={15} strokeWidth={1.8} />
              </button>
            </div>
            <div className={`${C}-modal__radar`}>
              <PersonaRadar dims={radarDims} size={280} onDimClick={handleRadarDimClick} />
            </div>
            <div className={`${C}-modal__dims`}>
              {radarDims.map(d => (
                <div key={d.label} className={`${C}-modal__dim`}>
                  <span className={`${C}-modal__dim-label`}>{d.label}</span>
                  <div className={`${C}-modal__dim-track`}>
                    <div className={`${C}-modal__dim-fill`} style={{ width: `${d.value * 10}%` }} />
                  </div>
                  <span className={`${C}-modal__dim-val`}>{d.value.toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default PersonaView;
