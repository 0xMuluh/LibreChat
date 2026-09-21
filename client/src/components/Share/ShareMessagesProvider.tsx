import React, { useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { MessagesViewContextValue } from '~/Providers/MessagesViewContext';
import { MessagesViewContext } from '~/Providers/MessagesViewContext';

interface ShareMessagesProviderProps {
  messages: TMessage[];
  conversationId?: string;
  children: React.ReactNode;
}

/**
 * Minimal MessagesViewContext provider for share view.
 * Provides conversation data needed by message components.
 * Uses the same MessagesViewContext as the main app for compatibility with existing hooks.
 */
export function ShareMessagesProvider({
  messages,
  conversationId,
  children,
}: ShareMessagesProviderProps) {
  const contextValue = useMemo<MessagesViewContextValue>(
    () => ({
      conversation: null,
      conversationId: conversationId || undefined,
      // These are required by the context but not used in share view
      ask: () => {},
      regenerate: () => {},
      handleContinue: () => {},
      latestMessageId: messages[messages.length - 1]?.messageId,
      latestMessageDepth: messages[messages.length - 1]?.depth,
      isSubmitting: false,
      abortScroll: false,
      setAbortScroll: () => {},
      index: 0,
      getMessages: () => messages,
      setMessages: () => {},
    }),
    [messages],
  );

  return (
    <MessagesViewContext.Provider value={contextValue}>{children}</MessagesViewContext.Provider>
  );
}
