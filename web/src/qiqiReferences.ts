import type { Manifest } from '../../shared/types';
import type { QiqiContext } from './qiqiChat';
import { cached } from './data/localCache';
import { fileBlob, manifestKey } from './data/libraryRepository';

export function referenceLines(text: string, startLine: number, lineCount: number) {
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > 160
  )
    throw new Error('读取行号不正确');
  const lines = text.split(/\r\n|\r|\n/);
  if (startLine > lines.length) throw new Error(`原文共有 ${lines.length} 行，请调整行号`);
  const selected = lines
    .slice(startLine - 1, startLine - 1 + lineCount)
    .map((line, i) => `${startLine + i}: ${line}`)
    .join('\n');
  return {
    totalLines: lines.length,
    startLine,
    text: selected.slice(0, 12000),
    truncated: selected.length > 12000,
  };
}

export async function readQiqiReference(
  context: QiqiContext,
  startLine: number,
  lineCount: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (context.allowSourceRead !== true || !/^[a-f0-9]{64}$/.test(context.sourceHash || ''))
    throw new Error('这份引用未授权读取原文，请重新选择并勾选授权');
  const user = { id: context.identity.userId, username: '' };
  const manifest = await cached<Manifest>(manifestKey(user, context.identity.libraryId));
  signal.throwIfAborted();
  const entry = manifest?.files.find((file) => file.path === context.identity.path);
  if (
    !entry ||
    manifest?.library.id !== context.identity.libraryId ||
    entry.hash !== context.sourceHash
  )
    throw new Error('原文版本已变化或不在本机目录中，请重新打开并引用');
  if (!entry.isText || entry.size > 1024 * 1024)
    throw new Error('这份文件较大或不是文本，请直接选择需要的片段');
  let blob: Blob;
  try {
    blob = await fileBlob(user, context.identity.libraryId, entry, true, signal);
  } catch {
    signal.throwIfAborted();
    throw new Error('未能读取这份原文，请重新打开文件后重试');
  }
  if (blob.size > 1024 * 1024) throw new Error('这份文件较大，请直接选择需要的片段');
  const text = await blob.text();
  signal.throwIfAborted();
  return JSON.stringify({
    path: entry.path,
    sourceVersion: entry.hash,
    ...referenceLines(text, startLine, lineCount),
  });
}
