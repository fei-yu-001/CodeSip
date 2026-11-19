import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { buildApp } from '../server/app';
const require = createRequire(import.meta.url);
test('Obsidian bridge uploads notes and linked attachments, handles rename/delete, preserves excluded files and refuses rebinding', async (t) => {
  const { app, store } = await buildApp({
    database: ':memory:',
    setupToken: 'plugin-test-setup-key',
    rateLimit: false,
  });
  t.after(() => app.close());
  const user = await store.createUser('plugin', 'plugin-test-password');
  const library = store.createLibrary(user.id, 'Study', 'notes');
  const token = store.issueToken(user.id, library.id);
  class TFile {
    path: string;
    extension: string;
    stat: { size: number; mtime: number };
    constructor(
      path: string,
      public bytes: Buffer,
    ) {
      this.path = path;
      this.extension = path.split('.').pop()!;
      this.stat = { size: bytes.length, mtime: 1 };
    }
  }
  const local = new Map<string, TFile>();
  const add = (path: string, text: string | Buffer) => {
    const file = new TFile(path, Buffer.isBuffer(text) ? text : Buffer.from(text));
    local.set(path, file);
    return file;
  };
  add('学习/记录.md', '# Study\n![[image.png]]');
  add('附件/image.png', Buffer.from([137, 80, 78, 71]));
  add('其他/私密.md', 'not selected');
  add('.obsidian/config.md', 'private');
  const notices: string[] = [];
  const emitted = await build({
    entryPoints: ['plugin/src/main.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['obsidian', 'crypto'],
  });
  const mod = { exports: {} as any };
  const mocks = {
    Plugin: class {},
    PluginSettingTab: class {},
    Setting: class {},
    App: class {},
    TFile,
    Notice: class {
      constructor(message: string) {
        notices.push(message);
      }
    },
    requestUrl: async (options: any) => {
      const response = await app.inject({
        method: options.method,
        url: new URL(options.url).pathname,
        headers: options.headers,
        payload: options.body,
      });
      return { status: response.statusCode, json: response.json() };
    },
  };
  vm.runInNewContext(emitted.outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    require: (name: string) => (name === 'obsidian' ? mocks : require(name)),
    Buffer,
    console,
    window: { setTimeout, clearTimeout },
    URL,
  });
  const Plugin = mod.exports.default;
  const plugin = new Plugin();
  plugin.settings = {
    server: 'https://example.invalid',
    libraryId: library.id,
    token,
    folder: '学习',
    automatic: false,
    boundVault: '',
    boundFolder: '',
    bindingId: '',
  };
  plugin.saveData = async () => {};
  plugin.app = {
    vault: {
      getName: () => 'test-vault',
      getFiles: () => [...local.values()],
      getAbstractFileByPath: (p: string) => local.get(p),
      readBinary: async (f: TFile) => f.bytes,
    },
    metadataCache: {
      getFileCache: () => ({ embeds: [{ link: 'image.png' }] }),
      getFirstLinkpathDest: () => local.get('附件/image.png'),
    },
  };
  await plugin.sync(true);
  assert.deepEqual(
    store.manifest(user.id, library.id).files.map((f) => f.path),
    ['学习/记录.md', '附件/image.png'],
  );
  assert.match(notices.at(-1)!, /同步完成/);
  const revision = store.library(user.id, library.id).revision;
  await plugin.sync(true);
  assert.equal(store.library(user.id, library.id).revision, revision);
  local.delete('学习/记录.md');
  add('学习/改名.md', '# Renamed');
  await plugin.sync(true);
  assert.deepEqual(
    store.manifest(user.id, library.id).files.map((f) => f.path),
    ['学习/改名.md', '附件/image.png'],
  );
  plugin.settings.folder = '其他';
  await plugin.sync(true);
  assert.match(notices.at(-1)!, /绑定其他笔记库或目录/);
  assert.deepEqual(
    store.manifest(user.id, library.id).files.map((f) => f.path),
    ['学习/改名.md', '附件/image.png'],
  );
});
