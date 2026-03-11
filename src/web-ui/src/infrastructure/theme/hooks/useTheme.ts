 

import { useEffect, useMemo } from 'react';
import { useThemeStore } from '../store/themeStore';
import { ThemeType } from '../types';
export function useTheme() {
  const {
    currentTheme,
    currentThemeId,
    themes,
    loading,
    error,
    initialize,
    setTheme,
    refreshThemes,
  } = useThemeStore();
  
  
  useEffect(() => {
    if (!currentTheme && !loading) {
      initialize();
    }
  }, [currentTheme, loading, initialize]);
  
  return {
    
    theme: currentTheme,
    themeId: currentThemeId,
    themeType: currentTheme?.type || 'dark' as ThemeType,
    themes,
    loading,
    error,
    
    
    setTheme,
    refreshThemes,
    
    
    isDark: currentTheme?.type === 'dark',
    isLight: currentTheme?.type === 'light',
  };
}

 
export function useThemeConfig() {
  const { theme } = useTheme();
  
  return useMemo(() => {
    if (!theme) {
      return null;
    }
    
    return {
      colors: theme.colors,
      effects: theme.effects,
      motion: theme.motion,
      typography: theme.typography,
    };
  }, [theme]);
}

 
export function useThemeColors() {
  const { theme } = useTheme();
  return theme?.colors || null;
}

 
export function useThemeEffects() {
  const { theme } = useTheme();
  return theme?.effects || null;
}

 
export function useThemeManagement() {
  const {
    themes,
    addTheme,
    removeTheme,
    exportTheme,
    importTheme,
    refreshThemes,
  } = useThemeStore();
  
  return {
    themes,
    addTheme,
    removeTheme,
    exportTheme,
    importTheme,
    refreshThemes,
  };
}

 
export function useThemeToggle() {
  const { themeId, themes, setTheme, isDark, isLight } = useTheme();
  
  
  const toggleTheme = () => {
    const targetType = isDark ? 'light' : 'dark';
    const targetTheme = themes.find(t => t.type === targetType);
    
    if (targetTheme) {
      setTheme(targetTheme.id);
    }
  };
  
  
  const nextTheme = () => {
    const currentIndex = themes.findIndex(t => t.id === themeId);
    const nextIndex = (currentIndex + 1) % themes.length;
    const nextTheme = themes[nextIndex];
    
    if (nextTheme) {
      setTheme(nextTheme.id);
    }
  };
  
  
  const prevTheme = () => {
    const currentIndex = themes.findIndex(t => t.id === themeId);
    const prevIndex = (currentIndex - 1 + themes.length) % themes.length;
    const prevTheme = themes[prevIndex];
    
    if (prevTheme) {
      setTheme(prevTheme.id);
    }
  };
  
  return {
    toggleTheme,
    nextTheme,
    prevTheme,
    isDark,
    isLight,
  };
}




