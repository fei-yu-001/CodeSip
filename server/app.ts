import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Store, digest } from './store';
import { ApiError, MAX_ARCHIVE } from './paths';
import { readArchive } from './zip';
import { compressReadingResponse } from './readingTransport';
import type { User, SyncPatch, AnnotationWrite, DocumentCopyWrite } from '../shared/types';
export interface AppOptions {
  database: string;
  setupToken: string;
  publicUrl?: string;
  staticDir?: string;
  production?: boolean;
  logger?: boolean;
  rateLimit?: boolean;
}
declare module 'fastify' {
  interface FastifyRequest {
    identity?: { user: User; libraryId?: string };
  }
}
export async function buildApp(options: AppOptions) {
  if (!options.setupToken || options.setupToken.length < 16)
    throw new Error('CODESIP_SETUP_TOKEN must contain at least 16 characters');
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }
      : false,
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: '127.0.0.1',
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status === 500) req.log.error({ err: e }, 'request failed');
    reply.code(status).send({
      error:
        status === 500
          ? '服务暂时无法完成请求，请稍后重试'
          : status === 429
            ? '操作太频繁，请稍后再试'
            : e.message,
    });
  });
  const store = new Store(options.database);
  let settingUp = false;
  app.addHook('onClose', () => store.db.close());
  await app.register(cookie);
  await app.register(rateLimit, {
    allowList: (req) => !req.url.startsWith('/api/'),
    max: options.rateLimit === false ? 100000 : 400,
    timeWindow: '1 minute',
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_ARCHIVE, files: 1, fields: 0, parts: 1 },
  });
  const allowedOrigins = new Set(
    [
      options.publicUrl && new URL(options.publicUrl).origin,
      ...(!options.production
        ? [
            'http://127.0.0.1:5173',
            'http://localhost:5173',
            'http://127.0.0.1:4318',
            'http://localhost:4318',
          ]
        : []),
    ].filter(Boolean),
  );
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      !req.headers.authorization?.startsWith('Bearer ')
    ) {
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.has(origin))
        throw new ApiError(403, '请求来源无效，请从 CodeSip 页面操作');
    }
    if (
      !req.url.startsWith('/api/') ||
      [
        '/api/health',
        '/api/status',
        '/api/auth/setup',
        '/api/auth/login',
        '/api/v1/auth/login',
      ].includes(req.url.split('?')[0])
    )
      return;
    const bearer = req.headers.authorization?.startsWith('Bearer ');
    const token = bearer ? req.headers.authorization!.slice(7) : req.cookies.codesip_session;
    req.identity = token ? store.authenticate(token, !!bearer) : undefined;
    if (!req.identity) throw new ApiError(401, '请登录 CodeSip');
    if (req.identity.libraryId) {
      const allowed = `/api/libraries/${req.identity.libraryId}`;
      if (
        !(req.method === 'GET' && req.url.split('?')[0] === `${allowed}/manifest`) &&
        !(req.method === 'POST' && req.url === `${allowed}/sync`)
      )
        throw new ApiError(403, '此令牌仅能同步绑定的笔记库');
    }
  });
  const setSession = (reply: any, user: User) =>
    reply.setCookie('codesip_session', store.session(user.id), {
      path: '/',
      httpOnly: true,
      secure: !!options.production,
      sameSite: 'strict',
      maxAge: 30 * 86400,
    });
  app.get('/api/health', async () => ({ status: 'ok', app: 'codesip', version: '0.1.0' }));
  app.get('/api/status', async () => ({ needsSetup: store.needsSetup }));
  const authLimit = {
    config: { rateLimit: { max: options.rateLimit === false ? 10000 : 8, timeWindow: '1 minute' } },
  };
  app.post<{ Body: { username: string; password: string; setupToken: string } }>(
    '/api/auth/setup',
    authLimit,
    async (req, reply) => {
      if (!store.needsSetup || settingUp) throw new ApiError(409, '账号已经建立，请登录');
      if (
        typeof req.body?.setupToken !== 'string' ||
        !timingSafeEqual(
          Buffer.from(digest(req.body.setupToken)),
          Buffer.from(digest(options.setupToken)),
        )
      )
        throw new ApiError(403, '首次设置密钥不正确');
      settingUp = true;
      try {
        const user = await store.createUser(req.body.username, req.body.password);
        setSession(reply, user);
        return { user };
      } finally {
        settingUp = false;
      }
    },
  );
  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    authLimit,
    async (req, reply) => {
      const user = await store.login(req.body?.username, req.body?.password);
      setSession(reply, user);
      return { user };
    },
  );
  app.post<{
    Body: {
      username: string;
      password: string;
      device_id: string;
      device_name?: string;
      platform?: string;
    };
  }>('/api/v1/auth/login', authLimit, async (req, reply) => {
    const user = await store.login(req.body?.username, req.body?.password);
    const deviceId = req.body?.device_id || 'unknown-device';
    const deviceName = req.body?.device_name || 'My Device';
    const platform = req.body?.platform || 'web';
    const reg = store.syncServer.registerDevice(user.id, deviceId, deviceName, platform);
    const token = store.session(user.id);
    setSession(reply, user);
    return {
      access_token: token,
      refresh_token: token,
      device_secret: reg.device_secret,
      user,
    };
  });
  app.get<{ Querystring: { since_seq?: string; limit?: string } }>(
    '/api/v1/sync/changes',
    async (req) => {
      const sinceSeq = parseInt(req.query.since_seq || '0', 10) || 0;
      const limit = parseInt(req.query.limit || '200', 10) || 200;
      return store.syncServer.getChanges(req.identity!.user.id, sinceSeq, limit);
    },
  );
  app.post<{ Body: { hashes: string[] } }>('/api/v1/assets/check', async (req) => {
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
    const missing = store.syncServer.checkMissingAssets(req.identity!.user.id, hashes);
    const uploadUrls: Record<string, string> = {};
    for (const h of missing) uploadUrls[h] = `/api/v1/assets/upload?hash=${encodeURIComponent(h)}`;
    return { missing_hashes: missing, upload_urls: uploadUrls };
  });
  app.post<{ Querystring: { hash?: string } }>('/api/v1/assets/upload', async (req) => {
    const part = await req.file();
    if (!part) throw new ApiError(400, '缺少资产文件');
    const bytes = await part.toBuffer();
    const hash = req.query.hash || digest(bytes);
    store.syncServer.saveAsset(req.identity!.user.id, hash, bytes);
    return { ok: true, hash };
  });
  app.get<{ Params: { hash: string } }>('/api/v1/assets/:hash', async (req, reply) => {
    const content = store.syncServer.getAsset(req.identity!.user.id, req.params.hash);
    if (!content) throw new ApiError(404, '资产不存在');
    // Authenticated assets must not enter shared caches or survive logout there.
    return reply.type('image/png').send(content);
  });
  app.post<{
    Body: {
      device_id: string;
      notes: Array<{
        note_id: string;
        file_path: string;
        content: string;
        content_hash: string;
        is_deleted?: number;
      }>;
    };
  }>('/api/v1/sync/push', async (req) => {
    if (!req.body?.device_id || !Array.isArray(req.body?.notes)) {
      throw new ApiError(400, '请求数据格式不正确');
    }
    const results = store.syncServer.pushNotes(
      req.identity!.user.id,
      req.body.device_id,
      req.body.notes,
    );
    return { results };
  });
  app.get('/api/session', async (req) => ({ user: req.identity!.user }));
  app.post('/api/auth/logout', async (req, reply) => {
    if (req.cookies.codesip_session)
      store.db
        .prepare('DELETE FROM sessions WHERE hash=?')
        .run(digest(req.cookies.codesip_session));
    reply.clearCookie('codesip_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/libraries', async (req) => ({ libraries: store.libraries(req.identity!.user.id) }));
  app.post<{ Body: { name: string; kind: string } }>('/api/libraries', async (req) => ({
    library: store.createLibrary(req.identity!.user.id, req.body?.name, req.body?.kind),
  }));
  app.get<{ Params: { id: string } }>(
    '/api/libraries/:id/manifest',
    { onSend: compressReadingResponse },
    async (req) => store.manifest(req.identity!.user.id, req.params.id),
  );
  const readerSession = async (req: import('fastify').FastifyRequest) => {
    if (!req.cookies.codesip_session || req.headers.authorization || req.identity?.libraryId)
      throw new ApiError(403, '请通过网页登录后管理阅读内容');
  };
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/libraries/:id/document-copy',
    { preHandler: readerSession },
    async (req) => ({
      copy: store.documentCopies.get(req.identity!.user.id, req.params.id, req.query.path),
    }),
  );
  app.put<{ Params: { id: string }; Body: DocumentCopyWrite }>(
    '/api/libraries/:id/document-copy',
    { preHandler: readerSession, bodyLimit: 3 * 1024 * 1024 },
    async (req) => ({
      copy: store.documentCopies.put(req.identity!.user.id, req.params.id, req.body),
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/libraries/:id/annotations',
    { preHandler: readerSession },
    async (req) => ({
      annotations: store.annotations.list(req.identity!.user.id, req.params.id, req.query.path),
    }),
  );
  app.put<{ Params: { id: string; annotationId: string }; Body: AnnotationWrite }>(
    '/api/libraries/:id/annotations/:annotationId',
    { preHandler: readerSession, bodyLimit: 64 * 1024 },
    async (req) => ({
      annotation: store.annotations.put(
        req.identity!.user.id,
        req.params.id,
        req.params.annotationId,
        req.body,
      ),
    }),
  );
  app.delete<{ Params: { id: string; annotationId: string }; Body: { expectedUpdatedAt: number } }>(
    '/api/libraries/:id/annotations/:annotationId',
    { preHandler: readerSession, bodyLimit: 1024 },
    async (req) => {
      store.annotations.delete(
        req.identity!.user.id,
        req.params.id,
        req.params.annotationId,
        req.body?.expectedUpdatedAt,
      );
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/libraries/:id', async (req) => {
    store.library(req.identity!.user.id, req.params.id);
    store.db.prepare('DELETE FROM libraries WHERE id=?').run(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/libraries/:id/file',
    { onSend: compressReadingResponse },
    async (req, reply) => {
      const row = store.file(req.identity!.user.id, req.params.id, req.query.path);
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      const attachment = req.query.path.toLowerCase().endsWith('.svg');
      return reply
        .type(row.is_text && !attachment ? 'text/plain; charset=utf-8' : row.media_type)
        .send(Buffer.from(row.content));
    },
  );
  app.delete<{ Params: { id: string }; Body: { path: string; baseRevision: number } }>(
    '/api/libraries/:id/file',
    { preHandler: readerSession, bodyLimit: 4096 },
    async (req) => store.removeFile(req.identity!.user.id, req.params.id, req.body),
  );
  app.get<{ Params: { id: string }; Querystring: { q: string } }>(
    '/api/libraries/:id/search',
    async (req) => ({
      results: store.search(req.identity!.user.id, req.params.id, req.query.q || ''),
    }),
  );
  app.post<{ Params: { id: string }; Body: SyncPatch }>('/api/libraries/:id/sync', async (req) =>
    store.sync(req.identity!.user.id, req.params.id, req.body),
  );
  app.post<{ Params: { id: string } }>('/api/libraries/:id/token', async (req) => ({
    token: store.issueToken(req.identity!.user.id, req.params.id),
  }));
  app.delete<{ Params: { id: string } }>('/api/libraries/:id/token', async (req) => {
    store.library(req.identity!.user.id, req.params.id);
    store.db.prepare('DELETE FROM tokens WHERE library_id=?').run(req.params.id);
    return { ok: true };
  });
  app.post<{
    Querystring: { name: string; kind: string; libraryId?: string; baseRevision?: string };
  }>('/api/import', async (req) => {
    const part = await req.file();
    if (!part) throw new ApiError(400, '请选择 ZIP 文件');
    const bytes = await part.toBuffer();
    const files = await readArchive(bytes);
    if (req.query.libraryId) {
      const previous = store.manifest(req.identity!.user.id, req.query.libraryId);
      if (previous.library.kind !== (req.query.kind || 'code'))
        throw new ApiError(400, '更新目标的项目类型不匹配');
      const revision = Number(req.query.baseRevision);
      if (!req.query.baseRevision || !Number.isSafeInteger(revision) || revision < 0)
        throw new ApiError(400, '更新项目需要有效的版本号');
      const incoming = new Set(files.map((file) => file.path));
      store.put(
        previous.library.id,
        files,
        previous.files.filter((file) => !incoming.has(file.path)).map((file) => file.path),
        revision,
      );
      return { library: store.library(req.identity!.user.id, previous.library.id) };
    }
    const lib = store.createLibrary(
      req.identity!.user.id,
      req.query.name || part.filename.replace(/\.zip$/i, ''),
      req.query.kind || 'code',
    );
    try {
      store.put(lib.id, files, [], 0);
    } catch (error) {
      store.db.prepare('DELETE FROM libraries WHERE id=?').run(lib.id);
      throw error;
    }
    return { library: store.library(req.identity!.user.id, lib.id) };
  });
  app.post('/api/demo', async (req) => {
    const userId = req.identity!.user.id;
    const code = store.createLibrary(userId, '一杯代码 · 示例项目', 'code');
    store.put(
      code.id,
      [
        {
          path: 'README.md',
          bytes: Buffer.from(
            '# 一杯代码\n\n从一个小函数开始，读懂整个项目。\n\n- `src/brew.ts`：冲泡逻辑\n- `src/types.ts`：数据定义\n\n这是 CodeSip 内置的阅读示例，可以随时删除。\n',
          ),
        },
        {
          path: 'src/brew.ts',
          bytes: Buffer.from(
            'import type { Coffee, BrewOptions } from "./types";\n\n/** 把阅读代码的时间，留给一杯咖啡。 */\nexport function brew(options: BrewOptions): Coffee {\n  const { beans, water, temperature = 92 } = options;\n  const ratio = water / beans;\n\n  return {\n    name: ratio > 15 ? "轻盈手冲" : "浓郁一杯",\n    temperature,\n    ready: temperature >= 85,\n  };\n}\n',
          ),
        },
        {
          path: 'src/types.ts',
          bytes: Buffer.from(
            'export interface BrewOptions {\n  beans: number;\n  water: number;\n  temperature?: number;\n}\n\nexport interface Coffee {\n  name: string;\n  temperature: number;\n  ready: boolean;\n}\n',
          ),
        },
      ],
      [],
      0,
    );
    const notes = store.createLibrary(userId, '随手学 · 示例笔记', 'notes');
    store.put(
      notes.id,
      [
        {
          path: '开始阅读.md',
          bytes: Buffer.from(
            '# 给思考，留一点空间\n\n欢迎来到 **CodeSip**。电脑上整理的知识，可以在这里慢慢读。\n\n## 阅读清单\n\n- [x] 打开第一篇笔记\n- [ ] 连接 Obsidian\n- [ ] 收藏今天的发现\n\n## 小小的代码块\n\n```typescript\nconst learn = (idea: string) => `今天学到了：${idea}`;\n```\n\n继续读 [[学习方法]]，或者点右上角保存离线副本。\n\n> 阅读不必匆忙，理解会慢慢发生。\n',
          ),
        },
        {
          path: '学习方法.md',
          bytes: Buffer.from(
            '# 学习方法\n\n1. 先看目录，找到入口。\n2. 带着一个问题读代码。\n3. 把结论写成自己的话。\n\n回到 [[开始阅读]]。\n',
          ),
        },
      ],
      [],
      0,
    );
    return { libraries: store.libraries(userId) };
  });
  if (options.staticDir && existsSync(options.staticDir)) {
    await app.register(staticFiles, {
      root: path.resolve(options.staticDir),
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`))
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
    app.addHook('onSend', async (req, reply, payload) => {
      if (!req.url.startsWith('/api/'))
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        );
      return payload;
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }

  return { app, store };
}
