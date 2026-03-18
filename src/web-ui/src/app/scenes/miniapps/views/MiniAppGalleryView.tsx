import React, { useState, useMemo, useCallback } from 'react';
import {
  Box,
  FolderPlus,
  LayoutGrid,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Tag,
  Trash2,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import MiniAppCard from '../components/MiniAppCard';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { createLogger } from '@/shared/utils/logger';
import { Search, ConfirmDialog, Button, Badge } from '@/component-library';
import {
  GalleryDetailModal,
  GalleryEmpty,
  GalleryGrid,
  GalleryLayout,
  GalleryPageHeader,
  GallerySkeleton,
  GalleryZone,
} from '@/app/components';
import type { SceneTabId } from '@/app/components/SceneBar/types';
import { getMiniAppIconGradient, renderMiniAppIcon } from '../utils/miniAppIcons';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useMiniAppStore } from '../miniAppStore';
import './MiniAppGalleryView.scss';

const log = createLogger('MiniAppGalleryView');

const MiniAppGalleryView: React.FC = () => {
  const { t } = useI18n('common');
  const apps = useMiniAppStore((state) => state.apps);
  const loading = useMiniAppStore((state) => state.loading);
  const runningWorkerIds = useMiniAppStore((state) => state.runningWorkerIds);
  const setApps = useMiniAppStore((state) => state.setApps);
  const setLoading = useMiniAppStore((state) => state.setLoading);
  const markWorkerStopped = useMiniAppStore((state) => state.markWorkerStopped);
  const { workspacePath } = useCurrentWorkspace();
  const { openScene, activateScene, closeScene, openTabs } = useSceneManager();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<MiniAppMeta | null>(null);

  const openTabIds = useMemo(() => new Set(openTabs.map((tab) => tab.id)), [openTabs]);
  const runningIdSet = useMemo(() => new Set(runningWorkerIds), [runningWorkerIds]);

  const runningApps = useMemo(
    () =>
      runningWorkerIds
        .map((id) => apps.find((app) => app.id === id))
        .filter((app): app is MiniAppMeta => Boolean(app)),
    [runningWorkerIds, apps]
  );

  const categories = useMemo(() => {
    const values = Array.from(new Set(apps.map((app) => app.category).filter(Boolean)));
    return ['all', ...values];
  }, [apps]);

  const filtered = useMemo(() => {
    return apps.filter((app) => {
      const keyword = search.toLowerCase();
      const matchSearch =
        !search ||
        app.name.toLowerCase().includes(keyword) ||
        app.description.toLowerCase().includes(keyword) ||
        app.tags.some((tag) => tag.toLowerCase().includes(keyword));
      const matchCategory = categoryFilter === 'all' || app.category === categoryFilter;
      return matchSearch && matchCategory;
    });
  }, [apps, search, categoryFilter]);

  const handleOpenApp = useCallback(
    (appId: string) => {
      setSelectedApp(null);
      const tabId: SceneTabId = `miniapp:${appId}`;
      if (openTabIds.has(tabId)) {
        activateScene(tabId);
      } else {
        openScene(tabId);
      }
    },
    [openTabIds, activateScene, openScene]
  );

  const handleStopRunning = useCallback(
    async (appId: string) => {
      const tabId: SceneTabId = `miniapp:${appId}`;
      try {
        await miniAppAPI.workerStop(appId);
      } catch (error) {
        log.warn('Stop worker failed, removing local running state', error);
      } finally {
        markWorkerStopped(appId);
        if (openTabIds.has(tabId)) {
          closeScene(tabId);
        }
      }
    },
    [markWorkerStopped, closeScene, openTabIds]
  );

  const handleDeleteRequest = (appId: string) => {
    setPendingDeleteId(appId);
  };

  const handleDeleteConfirm = async () => {
    if (!pendingDeleteId) return;
    const appId = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await miniAppAPI.deleteMiniApp(appId);
      if (selectedApp?.id === appId) {
        setSelectedApp(null);
      }
      setApps(apps.filter((app) => app.id !== appId));
      markWorkerStopped(appId);
      const tabId: SceneTabId = `miniapp:${appId}`;
      if (openTabIds.has(tabId)) {
        closeScene(tabId);
      }
    } catch (error) {
      log.error('Delete failed', error);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const refreshed = await miniAppAPI.listMiniApps();
      setApps(refreshed);
    } finally {
      setLoading(false);
    }
  };

  const handleAddFromFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('miniApps.importFolderTitle'),
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;

      setLoading(true);
      const app = await miniAppAPI.importFromPath(path, workspacePath || undefined);
      setApps([app, ...apps]);
      handleOpenApp(app.id);
    } catch (error) {
      log.error('Import from folder failed', error);
    } finally {
      setLoading(false);
    }
  };

  const renderGrid = () => {
    if (loading && apps.length === 0) {
      return <GallerySkeleton count={8} cardHeight={152} />;
    }

    if (filtered.length === 0) {
      return (
        <GalleryEmpty
          icon={
            apps.length === 0
              ? <Sparkles size={36} strokeWidth={1.2} />
              : <LayoutGrid size={36} strokeWidth={1.2} />
          }
          message={apps.length === 0
            ? t('miniApps.emptyFirstApp')
            : t('miniApps.emptyNoMatch')}
        />
      );
    }

    return (
      <GalleryGrid>
        {filtered.map((app, index) => (
          <MiniAppCard
            key={app.id}
            app={app}
            index={index}
            isRunning={runningIdSet.has(app.id)}
            onOpenDetails={setSelectedApp}
            onOpen={handleOpenApp}
            onDelete={handleDeleteRequest}
          />
        ))}
      </GalleryGrid>
    );
  };

  return (
    <GalleryLayout className="miniapp-gallery">
      <GalleryPageHeader
        title={t('scenes.miniApps')}
        subtitle={t('miniApps.subtitle')}
        actions={(
          <>
            <Search value={search} onChange={setSearch} placeholder={t('miniApps.searchPlaceholder')} size="small" />
            <button
              type="button"
              className="gallery-action-btn gallery-action-btn--primary"
              onClick={handleAddFromFolder}
              disabled={loading}
              title={t('miniApps.importFromFolder')}
            >
              <FolderPlus size={15} />
            </button>
            <button
              type="button"
              className="gallery-action-btn"
              onClick={handleRefresh}
              disabled={loading}
              title={t('miniApps.refreshList')}
            >
              <RefreshCw
                size={15}
                className={loading ? 'gallery-spinning' : undefined}
              />
            </button>
          </>
        )}
      />

      <div className="gallery-zones">
        <GalleryZone
          title={t('miniApps.runningTitle')}
          tools={runningApps.length > 0 ? <span className="gallery-zone-badge">{runningApps.length}</span> : null}
        >
          {runningApps.length > 0 ? (
            <GalleryGrid>
              {runningApps.map((app, index) => (
                <MiniAppCard
                  key={app.id}
                  app={app}
                  index={index}
                  isRunning
                  onOpenDetails={setSelectedApp}
                  onOpen={handleOpenApp}
                  onDelete={handleDeleteRequest}
                  onStop={handleStopRunning}
                />
              ))}
            </GalleryGrid>
          ) : (
            <div className="gallery-run-empty">
              {t('miniApps.noRunningApps')}
            </div>
          )}
        </GalleryZone>

        <GalleryZone
          title={t('miniApps.allAppsTitle')}
          tools={(
            <>
              {categories.length > 1 ? (
                <div className="gallery-chip-row">
                  {categories.map((category) => (
                    <button
                      key={category}
                      type="button"
                      className={[
                        'gallery-cat-chip',
                        categoryFilter === category && 'gallery-cat-chip--active',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => setCategoryFilter(category)}
                    >
                      {category === 'all' ? t('miniApps.categories.all') : category}
                    </button>
                  ))}
                </div>
              ) : null}
              <span className="gallery-zone-count">{t('miniApps.count', { count: filtered.length })}</span>
            </>
          )}
        >
          {renderGrid()}
        </GalleryZone>
      </div>

      <GalleryDetailModal
        isOpen={Boolean(selectedApp)}
        onClose={() => setSelectedApp(null)}
        icon={selectedApp ? renderMiniAppIcon(selectedApp.icon || 'box', 24) : <Box size={24} />}
        iconGradient={selectedApp ? getMiniAppIconGradient(selectedApp.icon || 'box') : undefined}
        title={selectedApp?.name ?? ''}
        badges={selectedApp?.category ? <Badge variant="info">{selectedApp.category}</Badge> : null}
        description={selectedApp?.description}
        meta={selectedApp ? <span>v{selectedApp.version}</span> : null}
        actions={selectedApp ? (
          <>
            {runningIdSet.has(selectedApp.id) ? (
              <Button variant="secondary" size="small" onClick={() => void handleStopRunning(selectedApp.id)}>
                <Square size={14} />
                {t('actions.stop')}
              </Button>
            ) : null}
            <Button variant="danger" size="small" onClick={() => setPendingDeleteId(selectedApp.id)}>
              <Trash2 size={14} />
              {t('actions.delete')}
            </Button>
            <Button variant="primary" size="small" onClick={() => handleOpenApp(selectedApp.id)}>
              <Play size={14} />
              {t('actions.open')}
            </Button>
          </>
        ) : null}
      >
        {selectedApp?.tags.length ? (
          <div className="miniapp-gallery__detail-tags">
            {selectedApp.tags.map((tag) => (
              <span key={tag} className="miniapp-gallery__detail-tag">
                <Tag size={11} />
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </GalleryDetailModal>

      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        onClose={() => setPendingDeleteId(null)}
        onConfirm={handleDeleteConfirm}
        title={t('miniApps.deleteDialog.title', { name: apps.find((app) => app.id === pendingDeleteId)?.name ?? '' })}
        message={t('miniApps.deleteDialog.message')}
        type="warning"
        confirmDanger
        confirmText={t('actions.delete')}
        cancelText={t('actions.cancel')}
      />
    </GalleryLayout>
  );
};

export default MiniAppGalleryView;
