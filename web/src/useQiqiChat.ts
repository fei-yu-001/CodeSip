import { useEffect, useRef, useState } from 'react';
import { onPrivateDataCleared } from './data/session';
import {
  emptyQiqiConfig,
  loadQiqiConfig,
  loadQiqiConversations,
  saveQiqiConfig,
  saveQiqiConversations,
  streamQiqi,
  validateQiqiConfig,
  type QiqiConfig,
  type QiqiConversation,
  type QiqiMessage,
} from './qiqiChat';

const conversation = (): QiqiConversation => ({
  id: crypto.randomUUID(),
  title: '新对话',
  messages: [],
  updatedAt: Date.now(),
});
// Owns chat lifetime, persistence and transport. Panel drafts and navigation stay in the UI.
export function useQiqiChat(userId: string) {
  const [config, setConfig] = useState(() => {
    try {
      return loadQiqiConfig(localStorage, userId);
    } catch {
      return emptyQiqiConfig();
    }
  });
  const [conversations, setConversations] = useState(() => {
    try {
      const values = loadQiqiConversations(localStorage, userId);
      return values.length ? values : [conversation()];
    } catch {
      return [conversation()];
    }
  });
  const [activeId, setActiveId] = useState(conversations[0].id);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const validSession = useRef(true);
  const current = conversations.find((item) => item.id === activeId) || conversations[0];
  const stop = () => controller.current?.abort();
  useEffect(() => {
    validSession.current = true;
    const cleanup = onPrivateDataCleared(() => {
      validSession.current = false;
      controller.current?.abort();
      setConfig(emptyQiqiConfig());
      setConversations([conversation()]);
    });
    return () => {
      validSession.current = false;
      controller.current?.abort();
      cleanup();
    };
  }, [userId]);
  useEffect(() => {
    const save = () => {
      if (!validSession.current) return;
      try {
        saveQiqiConversations(localStorage, userId, conversations);
        setStorageError('');
      } catch {
        setStorageError('本机历史未能保存；当前对话仍可使用，请先复制重要内容。');
      }
    };
    const timer = setTimeout(save, 400);
    window.addEventListener('pagehide', save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', save);
    };
  }, [conversations, userId]);
  useEffect(() => {
    const removed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; libraryId: string }>).detail;
      if (detail?.userId !== userId) return;
      controller.current?.abort();
      setConversations((values) => {
        const kept = values.filter(
          (value) =>
            !value.messages.some(
              (message) => message.context?.identity.libraryId === detail.libraryId,
            ),
        );
        return kept.length ? kept : [conversation()];
      });
    };
    window.addEventListener('codesip:library-removed', removed);
    return () => window.removeEventListener('codesip:library-removed', removed);
  }, [userId]);
  const generate = (history: QiqiMessage[]) => {
    if (controller.current || !validSession.current) return false;
    validateQiqiConfig(config);
    const abort = new AbortController();
    controller.current = abort;
    const deadline = AbortSignal.timeout(120000);
    const signal = AbortSignal.any([abort.signal, deadline]);
    const id = current.id,
      answerId = crypto.randomUUID();
    const attached = [...history].reverse().find((message) => message.context)?.context;
    const update = (content: string, status: QiqiMessage['status']) => {
      if (!validSession.current || controller.current !== abort) return;
      setConversations((values) =>
        values.map((value) =>
          value.id !== id
            ? value
            : {
                ...value,
                updatedAt: Date.now(),
                messages: value.messages.map((message) =>
                  message.id === answerId ? { ...message, content, status } : message,
                ),
              },
        ),
      );
    };
    setConversations((values) =>
      values.map((value) =>
        value.id !== id
          ? value
          : {
              ...value,
              title: history[0]?.content.slice(0, 24) || '新对话',
              updatedAt: Date.now(),
              messages: [
                ...history,
                {
                  id: answerId,
                  role: 'assistant',
                  content: '',
                  context: attached,
                  status: 'stopped',
                },
              ],
            },
      ),
    );
    setRunning(true);
    setError('');
    void (async () => {
      let partial = '';
      try {
        const answer = await streamQiqi({
          config,
          messages: history,
          signal,
          onText: (text) => {
            partial = text;
            update(text, 'stopped');
          },
        });
        update(answer, 'complete');
      } catch (cause) {
        update(partial, abort.signal.aborted ? 'stopped' : 'error');
        if (!abort.signal.aborted && validSession.current)
          setError(
            deadline.aborted
              ? '等待回答超时，请重试或更换模型'
              : cause instanceof Error
                ? cause.message
                : '未能完成回答，请重试',
          );
      } finally {
        if (controller.current === abort) {
          controller.current = null;
          setRunning(false);
        }
      }
    })();
    return true;
  };
  return {
    config,
    conversations,
    current,
    running,
    error,
    storageError,
    setError,
    stop,
    generate,
    configure(value: QiqiConfig) {
      validateQiqiConfig(value);
      setConfig(value);
      try {
        saveQiqiConfig(localStorage, userId, value);
        return true;
      } catch {
        return false;
      }
    },
    newChat() {
      if (controller.current) return false;
      if (conversations.length >= 20) {
        setError('已保留 20 段对话，请先删除不再需要的对话');
        return false;
      }
      const value = conversation();
      setConversations((values) => [value, ...values]);
      setActiveId(value.id);
      setError('');
      return true;
    },
    selectChat(id: string) {
      if (!controller.current) setActiveId(id);
    },
    deleteChat(id: string) {
      if (controller.current) return;
      setConversations((values) => {
        const kept = values.filter((value) => value.id !== id);
        return kept.length ? kept : [conversation()];
      });
    },
  };
}
