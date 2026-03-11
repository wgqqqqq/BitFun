/**
 * Input history store for navigating previously sent messages.
 * Provides terminal-like up/down arrow navigation through message history.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface InputHistoryState {
  /** List of previously sent messages (most recent first) */
  messages: string[];
  /** Maximum number of messages to keep */
  maxHistorySize: number;
  
  /** Add a message to history */
  addMessage: (message: string) => void;
  /** Clear all history */
  clearHistory: () => void;
  /** Get message at index (0 = most recent) */
  getMessage: (index: number) => string | null;
  /** Get total count */
  getCount: () => number;
}

export const useInputHistoryStore = create<InputHistoryState>()(
  persist(
    (set, get) => ({
      messages: [],
      maxHistorySize: 100,
      
      addMessage: (message: string) => {
        const trimmed = message.trim();
        if (!trimmed) return;
        
        set((state) => {
          // Don't add duplicates in a row
          if (state.messages[0] === trimmed) {
            return state;
          }
          
          // Remove the message if it exists elsewhere in history
          const filtered = state.messages.filter(m => m !== trimmed);
          
          // Add to front, limit size
          const newMessages = [trimmed, ...filtered].slice(0, state.maxHistorySize);
          
          return { messages: newMessages };
        });
      },
      
      clearHistory: () => set({ messages: [] }),
      
      getMessage: (index: number) => {
        const { messages } = get();
        if (index < 0 || index >= messages.length) return null;
        return messages[index];
      },
      
      getCount: () => get().messages.length,
    }),
    {
      name: 'bitfun-input-history',
      version: 1,
    }
  )
);
