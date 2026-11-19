import { Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, App } from 'obsidian';
import { createHash } from 'crypto';
interface Settings {
  server: string;
  libraryId: string;
  token: string;
  folder: string;
  automatic: boolean;
  boundVault: string;
  boundFolder: string;
  bindingId: string;
}
const defaults: Settings = {
  server: '',
  libraryId: '',
  token: '',
  folder: '',
  automatic: false,
  boundVault: '',
  boundFolder: '',
  bindingId: '',
};
interface RemoteManifest {
  library: { id: string; revision: number };
  files: { path: string; hash: string; size: number }[];
}
export default class CodeSipSync extends Plugin {
  settings: Settings = defaults;
  status!: HTMLElement;
  running = false;
  timer: number | undefined;
  pending = false;
  disposed = false;
  lastResult = '尚未同步';
  async onload() {
    this.settings = { ...defaults, ...(await this.loadData()) };
    this.status = this.addStatusBarItem();
    this.updateStatus('待连接');
    this.addSettingTab(new CodeSipSettings(this.app, this));
    this.addCommand({
      id: 'sync-now',
      name: '立即同步笔记到 CodeSip',
      callback: () => void this.sync(true),
    });
    const schedule = () => {
      if (!this.settings.automatic) return;
      this.pending = true;
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.sync(false), 2500);
    };
    this.registerEvent(this.app.vault.on('create', schedule));
    this.registerEvent(this.app.vault.on('modify', schedule));
    this.registerEvent(this.app.vault.on('delete', schedule));
    this.registerEvent(this.app.vault.on('rename', schedule));
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.automatic) void this.sync(false);
      }, 60000),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.automatic) void this.sync(false);
    });
  }
  onunload() {
    this.disposed = true;
    if (this.timer) window.clearTimeout(this.timer);
  }
  updateStatus(text: string) {
    this.lastResult = text;
    this.status?.setText(`CodeSip · ${text}`);
  }
  async persist() {
    await this.saveData(this.settings);
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await requestUrl({
      url: this.settings.server + path,
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(response.json?.error || `服务返回 ${response.status}`);
    return response.json as T;
  }
  async sync(manual: boolean) {
    if (this.running) {
      this.pending = true;
      if (manual) new Notice('同步正在进行，完成后会检查新变化');
      return;
    }
    if (!this.settings.server || !this.settings.libraryId || !this.settings.token) {
      if (manual) new Notice('请先粘贴 CodeSip 连接信息');
      return;
    }
    this.running = true;
    this.pending = false;
    this.updateStatus('同步中…');
    try {
      const folder = this.settings.folder.trim().replace(/^\/+|\/+$/g, '');
      if (folder.split('/').some((p) => p === '..' || p === '.') || folder.includes('\\'))
        throw new Error('同步目录请使用笔记库内的相对路径');
      const vault = this.app.vault.getName();
      const bindingId = this.settings.server + '|' + this.settings.libraryId;
      if (
        this.settings.bindingId === bindingId &&
        ((this.settings.boundVault && this.settings.boundVault !== vault) ||
          this.settings.boundFolder !== folder)
      )
        throw new Error(
          '这个连接已绑定其他笔记库或目录。请在 CodeSip 新建笔记库并生成连接，避免覆盖已有内容',
        );
      const manifest = await this.request<RemoteManifest>(
        `/api/libraries/${this.settings.libraryId}/manifest`,
      );
      const pathAllowed = (path: string) =>
        !path
          .split('/')
          .some(
            (p) =>
              ['.git', '.obsidian', 'node_modules', '.DS_Store', '.trash'].includes(p) ||
              p === '.env' ||
              p.startsWith('.env.'),
          );
      const all = this.app.vault.getFiles().filter((file) => pathAllowed(file.path));
      const notes = all.filter(
        (file) =>
          file.extension.toLowerCase() === 'md' && (!folder || file.path.startsWith(folder + '/')),
      );
      const wanted = new Map<string, TFile>();
      for (const note of notes) {
        wanted.set(note.path, note);
        const metadata = this.app.metadataCache.getFileCache(note);
        for (const link of [...(metadata?.embeds || []), ...(metadata?.links || [])]) {
          const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, note.path);
          if (dest && dest.extension.toLowerCase() !== 'md' && pathAllowed(dest.path))
            wanted.set(dest.path, dest);
        }
      }
      for (const file of all)
        if (
          (!folder || file.path.startsWith(folder + '/')) &&
          /^(png|jpe?g|gif|webp|avif|svg|pdf)$/i.test(file.extension)
        )
          wanted.set(file.path, file);
      if (wanted.size > 4000) throw new Error('笔记库超过 4000 个文件，请选择较小的目录');
      const remote = new Map(manifest.files.map((file) => [file.path, file.hash]));
      const changed: { path: string; content: string }[] = [];
      let bytes = 0;
      for (const file of wanted.values()) {
        const stat = this.app.vault.getAbstractFileByPath(file.path);
        if (!(stat instanceof TFile)) throw new Error('文件正在变动，将在下一次同步重试');
        if (file.stat.size > 8 * 1024 * 1024) throw new Error(`${file.path} 超过单文件 8 MB 限制`);
        const before = file.stat.mtime;
        const content = Buffer.from(await this.app.vault.readBinary(file));
        if (file.stat.mtime !== before) throw new Error('笔记正在写入，将在下一次同步重试');
        bytes += content.length;
        if (bytes > 64 * 1024 * 1024) throw new Error('笔记与附件合计超过 64 MB，请缩小同步范围');
        const hash = createHash('sha256').update(content).digest('hex');
        if (remote.get(file.path) !== hash)
          changed.push({ path: file.path, content: content.toString('base64') });
      }
      const deleted = manifest.files
        .filter((file) => !wanted.has(file.path))
        .map((file) => file.path);
      const mayDelete = this.settings.bindingId === bindingId;
      changed.sort((a, b) => Number(a.path.endsWith('.md')) - Number(b.path.endsWith('.md')));
      let batch: typeof changed = [];
      let batchBytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const result = await this.request<{ revision: number }>(
          `/api/libraries/${this.settings.libraryId}/sync`,
          { baseRevision: manifest.library.revision, upserts: batch, deleted: [] },
        );
        manifest.library.revision = result.revision;
        batch = [];
        batchBytes = 0;
      };
      for (const item of changed) {
        if (batch.length >= 60 || batchBytes + item.content.length > 10 * 1024 * 1024)
          await flush();
        batch.push(item);
        batchBytes += item.content.length;
      }
      await flush();
      if (mayDelete && deleted.length)
        await this.request(`/api/libraries/${this.settings.libraryId}/sync`, {
          baseRevision: manifest.library.revision,
          upserts: [],
          deleted,
        });
      this.settings.boundVault = vault;
      this.settings.boundFolder = folder;
      this.settings.bindingId = bindingId;
      await this.persist();
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.updateStatus(`${time} 已同步`);
      if (manual)
        new Notice(
          `CodeSip 同步完成：更新 ${changed.length} 个文件${mayDelete ? `，删除 ${deleted.length} 个旧副本` : ''}`,
        );
    } catch (error) {
      this.updateStatus('同步失败');
      if (manual) new Notice(`CodeSip：${(error as Error).message}`, 8000);
      console.warn('CodeSip sync failed:', (error as Error).message);
    } finally {
      this.running = false;
      if (this.pending && this.settings.automatic && !this.disposed)
        this.timer = window.setTimeout(() => void this.sync(false), 3000);
    }
  }
}
class CodeSipSettings extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: CodeSipSync,
  ) {
    super(app, plugin);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('codesip-sync-settings');
    containerEl.createEl('h2', { text: 'CodeSip · 随身阅读' });
    containerEl.createEl('p', {
      text: '从 CodeSip 的「连接 Obsidian」复制连接信息，电脑写笔记，手机随时查看。',
      cls: 'codesip-warning',
    });
    let connection = '';
    new Setting(containerEl)
      .setName('连接信息')
      .setDesc('仅保存在本地插件设置中，请勿分享。')
      .addTextArea((input) =>
        input
          .setPlaceholder('{"server": "https://…", "libraryId": "…", "token": "…"}')
          .onChange((value) => (connection = value)),
      )
      .setClass('codesip-connection');
    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText('保存连接')
        .setCta()
        .onClick(async () => {
          try {
            if (this.plugin.running) throw new Error('请等待当前同步结束');
            const parsed = JSON.parse(connection);
            const url = new URL(parsed.server);
            if (
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              url.pathname !== '/' ||
              !(
                url.protocol === 'https:' ||
                (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
              )
            )
              throw new Error('服务器必须使用 HTTPS，或本机开发地址');
            if (
              typeof parsed.token !== 'string' ||
              !parsed.token.startsWith('csp_') ||
              typeof parsed.libraryId !== 'string' ||
              !/^[a-zA-Z0-9-]{36}$/.test(parsed.libraryId)
            )
              throw new Error('连接信息不完整');
            const previous = this.plugin.settings.server + '|' + this.plugin.settings.libraryId;
            const next = url.origin + '|' + parsed.libraryId;
            this.plugin.settings.server = url.origin;
            this.plugin.settings.libraryId = parsed.libraryId;
            this.plugin.settings.token = parsed.token;
            if (previous !== next) {
              this.plugin.settings.bindingId = '';
              this.plugin.settings.boundVault = '';
              this.plugin.settings.boundFolder = '';
            }
            await this.plugin.persist();
            this.plugin.updateStatus('已连接');
            new Notice('连接已保存，请选择目录后立即同步');
            this.display();
          } catch (e) {
            new Notice((e as Error).message);
          }
        }),
    );
    if (this.plugin.settings.server)
      containerEl.createEl('p', {
        text: `服务：${this.plugin.settings.server}`,
        cls: 'codesip-warning',
      });
    new Setting(containerEl)
      .setName('同步目录')
      .setDesc(
        '相对于当前笔记库，留空代表全部笔记。首次同步后固定；更换目录请创建新的 CodeSip 笔记库。',
      )
      .addText((input) =>
        input
          .setValue(this.plugin.settings.folder)
          .setPlaceholder('学习笔记')
          .onChange(async (value) => {
            if (this.plugin.running) return;
            this.plugin.settings.folder = value;
            await this.plugin.persist();
          }),
      );
    new Setting(containerEl)
      .setName('自动同步')
      .setDesc('修改后合并同步，并每分钟检查一次；Obsidian 关闭后暂停。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.automatic).onChange(async (value) => {
          this.plugin.settings.automatic = value;
          await this.plugin.persist();
        }),
      );
    new Setting(containerEl)
      .setName('立即同步')
      .setDesc(this.plugin.lastResult)
      .addButton((button) =>
        button
          .setButtonText('同步到 CodeSip')
          .setCta()
          .onClick(async () => {
            await this.plugin.sync(true);
            this.display();
          }),
      );
    containerEl.createEl('p', {
      text: '仅上传 Markdown 和相关附件。不上传 Obsidian 配置；手机只读，不回写电脑笔记。连接信息可在 CodeSip 中撤销。',
      cls: 'codesip-warning',
    });
  }
}
