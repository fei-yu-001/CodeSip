import { useEffect, useRef, useState } from 'react';
import type { MarkdownChunk, ParseResponse } from './types';
import type { OutlineItem } from '../readerState';

interface Snapshot {
  text: string;
  chunks: MarkdownChunk[];
  outline: OutlineItem[];
  total: number | undefined;
  error: boolean;
}
const empty = (text: string): Snapshot => ({
  text,
  chunks: [],
  outline: [],
  total: undefined,
  error: false,
});

export function useMarkdownDocument(text: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(text));
  const [attempt, setAttempt] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const current = snapshot.text === text ? snapshot : empty(text);
  useEffect(() => {
    setSnapshot(empty(text));
    let worker: Worker;
    try {
      worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setSnapshot({ ...empty(text), error: true });
      return;
    }
    workerRef.current = worker;
    worker.onmessage = ({ data }: MessageEvent<ParseResponse>) => {
      if (data.type === 'document') {
        setSnapshot({ text, chunks: [], outline: data.outline, total: data.total, error: false });
      } else if (data.type === 'chunk') {
        setSnapshot((state) => ({ ...state, chunks: [...state.chunks, data.chunk] }));
      } else {
        setSnapshot((state) => ({ ...state, error: true }));
        worker.terminate();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      setSnapshot((state) => ({ ...state, error: true }));
      worker.terminate();
    };
    worker.postMessage({ type: 'parse', text });
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, [text, attempt]);
  useEffect(() => {
    if (current.error || current.total === undefined || current.chunks.length === current.total)
      return;
    // Pull only after the previous React commit and a paint, so parsing cannot
    // flood the main thread with messages or starve touch/scroll input.
    let timer: ReturnType<typeof setTimeout>;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => workerRef.current?.postMessage({ type: 'next' }), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [text, current.error, current.total, current.chunks.length, attempt]);
  return {
    ...current,
    done: current.total !== undefined && current.chunks.length === current.total,
    retry: () => setAttempt((value) => value + 1),
  };
}
