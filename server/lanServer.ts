import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import type { LocalIndexer } from './indexer';

export interface LanServerOptions {
  port?: number;
  host?: string;
  deviceName: string;
  deviceSecret: string;
  indexer: LocalIndexer;
  readNoteFile: (filePath: string) => Promise<string | null>;
  writeNoteFile: (filePath: string, content: string) => Promise<void>;
  readAssetFile: (hash: string) => Promise<Buffer | null>;
}

export function generateChallengeSignature(
  deviceSecret: string,
  nonce: string,
  timestamp: number,
): string {
  return createHmac('sha256', deviceSecret)
    .update(`${nonce}${timestamp}`)
    .digest('hex');
}

export function verifyChallengeResponse(
  deviceSecret: string,
  nonce: string,
  timestamp: number,
  signature: string,
): boolean {
  const expected = generateChallengeSignature(deviceSecret, nonce, timestamp);
  return expected === signature;
}

export class LanSyncServer {
  server: http.Server | null = null;
  activeTokens = new Map<string, number>();
  options: LanServerOptions;

  constructor(options: LanServerOptions) {
    this.options = options;
  }

  issueSessionToken(): string {
    const token = randomBytes(24).toString('hex');
    const expires = Date.now() + 5 * 60 * 1000;
    this.activeTokens.set(token, expires);
    return token;
  }

  isValidSessionToken(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.activeTokens.get(token);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.activeTokens.delete(token);
      return false;
    }
    return true;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
        }
      });

      this.server.listen(this.options.port || 0, this.options.host || '127.0.0.1', () => {
        const address = this.server?.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(port);
      });

      this.server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const str = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(str ? JSON.parse(str) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = req.headers['x-session-token'] as string | undefined;

    if (!this.isValidSessionToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or expired X-Session-Token' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/local/ping') {
      const allDirty = this.options.indexer.listDirtyNotes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          deviceName: this.options.deviceName,
          totalNotes: allDirty.length,
          timestamp: Date.now(),
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/local/sync/diff') {
      const body = await this.parseJsonBody(req);
      const phoneNotes = (body?.notes as Record<string, string>) || {};

      const localDirty = this.options.indexer.listDirtyNotes();
      const phoneMissingOrUpdate: string[] = [];
      const pcMissing: string[] = [];

      const localMap = new Map<string, string>();
      for (const n of localDirty) {
        localMap.set(n.note_id, n.content_hash);
      }

      for (const [id, hash] of localMap.entries()) {
        if (!phoneNotes[id] || phoneNotes[id] !== hash) {
          phoneMissingOrUpdate.push(id);
        }
      }

      for (const id of Object.keys(phoneNotes)) {
        if (!localMap.has(id)) {
          pcMissing.push(id);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          phoneNeedsUpdate: phoneMissingOrUpdate,
          pcNeedsUpdate: pcMissing,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/local/file/note/')) {
      const noteId = url.pathname.replace('/local/file/note/', '');
      const note = this.options.indexer.getNoteById(noteId);
      if (!note || note.is_deleted) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Note not found' }));
        return;
      }
      const content = await this.options.readNoteFile(note.file_path);
      if (content === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File content missing' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Content-Hash': note.content_hash,
      });
      res.end(content);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/local/file/asset/')) {
      const hash = url.pathname.replace('/local/file/asset/', '');
      const asset = this.options.indexer.getAsset(hash);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset not found' }));
        return;
      }
      const buffer = await this.options.readAssetFile(hash);
      if (!buffer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset file missing' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(buffer);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/local/sync/push-note') {
      const body = await this.parseJsonBody(req);
      if (!body?.filePath || !body?.content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing filePath or content' }));
        return;
      }

      await this.options.writeNoteFile(body.filePath, body.content);
      const { record } = this.options.indexer.saveNote(
        body.filePath,
        body.content,
        'phone-client',
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, noteId: record.note_id, hash: record.content_hash }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
}
