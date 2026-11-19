import path from 'node:path';
export const MAX_FILE = 8 * 1024 * 1024;
export const MAX_TEXT = 2 * 1024 * 1024;
export const MAX_LIBRARY = 64 * 1024 * 1024;
export const MAX_FILES = 4000;
export const MAX_ARCHIVE = 24 * 1024 * 1024;
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function cleanPath(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > 700 ||
    /[\\\u0000-\u001f\u007f:]/.test(input) ||
    input.startsWith('/')
  )
    throw new ApiError(400, '文件路径无效');
  const parts = input.normalize('NFC').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.length > 255))
    throw new ApiError(400, '文件路径无效');
  return parts.join('/');
}
export function excludedPath(value: string): boolean {
  return value
    .split('/')
    .some(
      (p) =>
        [
          '.git',
          '.obsidian',
          'node_modules',
          '__MACOSX',
          '.DS_Store',
          '.hvigor',
          'oh_modules',
        ].includes(p) ||
        p === '.env' ||
        p.startsWith('.env.') ||
        p.startsWith('._'),
    );
}
const media: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};
export function classify(filePath: string, bytes: Buffer): { isText: boolean; mediaType: string } {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (media[extension] && extension !== '.svg')
    return { isText: false, mediaType: media[extension] };
  let isText = bytes.length <= MAX_TEXT && !bytes.includes(0);
  if (isText) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      isText = false;
    }
  }
  return {
    isText,
    mediaType:
      media[extension] ?? (isText ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
  };
}
