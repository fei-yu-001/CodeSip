import yauzl from 'yauzl';
import {
  ApiError,
  cleanPath,
  excludedPath,
  MAX_ARCHIVE,
  MAX_FILE,
  MAX_FILES,
  MAX_LIBRARY,
} from './paths';
export interface ImportedFile {
  path: string;
  bytes: Buffer;
}
export async function readArchive(buffer: Buffer): Promise<ImportedFile[]> {
  if (buffer.length > MAX_ARCHIVE) throw new ApiError(413, 'ZIP 不得超过 24 MB');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (err, zip) => {
        if (err || !zip) return reject(new ApiError(400, '无法读取 ZIP，请检查文件是否完整'));
        let total = 0,
          entries = 0,
          done = false;
        const files: ImportedFile[] = [];
        const names = new Set<string>();
        const fail = (error: Error) => {
          if (!done) {
            done = true;
            zip.close();
            reject(
              error instanceof ApiError ? error : new ApiError(400, 'ZIP 文件内容不完整或不受支持'),
            );
          }
        };
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          try {
            if (++entries > MAX_FILES + 1000) throw new ApiError(413, 'ZIP 内文件数量过多');
            const raw = entry.fileName.replace(/\/$/, '');
            const name = cleanPath(raw);
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
              throw new ApiError(400, '不支持 ZIP 中的符号链接');
            if (entry.fileName.endsWith('/') || excludedPath(name)) return zip.readEntry();
            if (names.has(name)) throw new ApiError(400, 'ZIP 存在重复文件路径');
            names.add(name);
            if (
              entry.uncompressedSize > MAX_FILE ||
              total + entry.uncompressedSize > MAX_LIBRARY ||
              files.length >= MAX_FILES
            )
              throw new ApiError(413, '解压后大小超限：单文件 8 MB，项目 64 MB，最多 4000 个文件');
            zip.openReadStream(entry, (error, stream) => {
              if (error || !stream) return fail(error || new Error('stream'));
              const chunks: Buffer[] = [];
              let size = 0;
              stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                total += chunk.length;
                if (size > MAX_FILE || total > MAX_LIBRARY) {
                  stream.destroy();
                  fail(new ApiError(413, '解压后文件过大'));
                } else chunks.push(chunk);
              });
              stream.on('error', fail);
              stream.on('end', () => {
                if (!done) {
                  files.push({ path: name, bytes: Buffer.concat(chunks) });
                  zip.readEntry();
                }
              });
            });
          } catch (error) {
            fail(error as Error);
          }
        });
        zip.on('end', () => {
          if (done) return;
          if (!files.length) return fail(new ApiError(400, 'ZIP 中没有可阅读的文件'));
          const root = files[0].path.split('/')[0];
          if (files.every((f) => f.path.startsWith(root + '/')))
            for (const file of files) file.path = file.path.slice(root.length + 1);
          done = true;
          resolve(files);
        });
        zip.readEntry();
      },
    );
  });
}
