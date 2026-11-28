import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../../shared/types';
import { HttpError } from './data/http';
import { onPrivateDataCleared } from './data/session';
import { synchronizeLibraryData } from './localSync';
import { syncResultMessage, type SyncResult } from './sync/librarySync';
import { useUpdateGuard } from './useUpdateGuard';

interface Options {
  user: User | null;
  currentId?: string;
  blocked: boolean;
  onSynced: (result: SyncResult) => void | Promise<void>;
  onError: (error: unknown) => void;
  notify: (message: string) => void;
}
export function useLibrarySync(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<SyncResult>();
  const [error, setError] = useState('');
  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);
  useEffect(() => {
    const reset = () => {
      controller.current?.abort();
      controller.current = null;
      setRunning(false);
      setProgress('');
      setResult(undefined);
      setError('');
    };
    reset();
    const dispose = onPrivateDataCleared(reset);
    return () => {
      cancel();
      controller.current = null;
      dispose();
    };
  }, [options.user?.id, cancel]);
  useUpdateGuard(running ? '项目正在同步，请等待完成或取消同步' : undefined);
  const run = useCallback(async (onlyIds?: string[]) => {
    const start = latest.current;
    if (!start.user || start.blocked || controller.current) return;
    const active = new AbortController();
    controller.current = active;
    const current = () =>
      controller.current === active &&
      !active.signal.aborted &&
      latest.current.user?.id === start.user?.id;
    setRunning(true);
    setError('');
    try {
      const next = await synchronizeLibraryData(
        start.user,
        (value) => {
          if (current()) setProgress(value);
        },
        active.signal,
        start.currentId,
        onlyIds,
      );
      if (!current()) return;
      setResult(next);
      await latest.current.onSynced(next);
      if (current()) latest.current.notify(syncResultMessage(next));
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof HttpError && cause.status === 401) latest.current.onError(cause);
      else {
        const message = `同步未完成，已有本机内容保留。${cause instanceof Error ? cause.message : '请联网后重试'}`;
        setError(message);
        latest.current.notify(message);
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setRunning(false);
        setProgress('');
        if (active.signal.aborted) latest.current.notify('已取消同步，已有本机内容保留');
      }
    }
  }, []);
  return {
    running,
    progress,
    result,
    error,
    run,
    cancel,
    retry: () =>
      run(
        result?.failures.length
          ? [...new Set(result.failures.map((failure) => failure.libraryId))]
          : undefined,
      ),
    dismiss: () => {
      setResult(undefined);
      setError('');
    },
  };
}
