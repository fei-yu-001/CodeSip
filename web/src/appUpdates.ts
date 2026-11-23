export type UpdatePhase =
  'idle' | 'checking' | 'downloading' | 'ready' | 'applying' | 'current' | 'error' | 'unsupported';
export interface UpdateState {
  phase: UpdatePhase;
  downloaded: number;
  total: number;
  version?: string;
  message?: string;
}
export const pageVersion = document.querySelector<HTMLMetaElement>(
  'meta[name="codesip-version"]',
)?.content;
let state: UpdateState = { phase: 'idle', downloaded: 0, total: 0 };
const listeners = new Set<() => void>();
export const getUpdateState = () => state;
export const subscribeUpdates = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function setState(next: Partial<UpdateState>) {
  state = { ...state, message: undefined, ...next };
  for (const listener of listeners) listener();
}
let started = false;
let registration: ServiceWorkerRegistration | undefined;
let registering: Promise<void> | undefined;
let checking = false;
let lastCheck = 0;
let applying = false;
let applyTimer: ReturnType<typeof setTimeout> | undefined;
const watched = new WeakSet<ServiceWorker>();
function askStatus(worker?: ServiceWorker | null) {
  worker?.postMessage({ type: 'CODESIP_UPDATE_STATUS' });
}
function watch(worker: ServiceWorker | null) {
  if (!worker || watched.has(worker)) return;
  watched.add(worker);
  const changed = () => {
    if (worker.state === 'installed') askStatus(worker);
    if (worker.state === 'redundant' && state.phase === 'downloading')
      setState({ phase: 'error', message: '下载未完成，仍可使用当前版本。请联网后重试。' });
  };
  worker.addEventListener('statechange', changed);
  changed();
  if (worker.state === 'installed' || worker.state === 'activated') askStatus(worker);
}
function clientReady() {
  navigator.serviceWorker.controller?.postMessage({
    type: 'CODESIP_CLIENT_READY',
    version: pageVersion,
  });
}
function observeRegistration(value: ServiceWorkerRegistration) {
  if (registration !== value) {
    registration = value;
    value.addEventListener('updatefound', () => watch(value.installing));
  }
  watch(value.installing);
  watch(value.waiting);
  askStatus(value.active);
  clientReady();
}
function registerWorker() {
  registering = (async () => {
    // A complete pending update remains usable after closing and reopening
    // the app offline, even if fetching sw.js for registration now fails.
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) observeRegistration(existing);
    const value = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    lastCheck = Date.now();
    observeRegistration(value);
  })().catch(() => {
    if (state.phase === 'checking' && !registration?.waiting)
      setState({ phase: 'error', message: '暂时无法检查更新，请联网后重试。' });
    registering = undefined;
  });
}
export function startAppUpdates() {
  if (started) return;
  started = true;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const update = event.data;
    if (
      update?.type !== 'codesip:update' ||
      !/^[a-f0-9]{12}$/.test(update.version) ||
      !['downloading', 'ready', 'error'].includes(update.phase) ||
      !Number.isFinite(update.downloaded) ||
      !Number.isFinite(update.total)
    )
      return;
    if (update.version === pageVersion) {
      // A newly opened page may already contain the new UI during migration
      // from the old worker. It needs no second reload or update prompt.
      if (
        update.phase === 'ready' &&
        registration?.waiting &&
        registration.waiting === event.source
      )
        registration.waiting.postMessage({ type: 'CODESIP_APPLY_UPDATE' });
      if (state.phase === 'checking' && update.phase === 'ready') setState({ phase: 'current' });
      return;
    }
    if (applying) return;
    // Ignore the previous active worker replying while a newer one downloads.
    if (registration?.installing && event.source === registration.active) return;
    setState({
      phase:
        update.phase === 'ready' && (event.source as ServiceWorker)?.state === 'installing'
          ? 'downloading'
          : update.phase,
      version: update.version,
      downloaded: Math.max(0, Math.min(update.downloaded, update.total)),
      total: Math.max(0, update.total),
      message:
        update.phase === 'error' ? '下载未完成，仍可使用当前版本。请联网后重试。' : undefined,
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) {
      clearTimeout(applyTimer);
      location.reload();
    } else {
      askStatus(navigator.serviceWorker.controller);
      clientReady();
    }
  });
  registerWorker();
  const backgroundCheck = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= 60000)
      void checkForUpdates(false);
  };
  window.addEventListener('online', backgroundCheck);
  document.addEventListener('visibilitychange', backgroundCheck);
  window.setInterval(backgroundCheck, 5 * 60000);
}
export async function checkForUpdates(manual = true) {
  startAppUpdates();
  if (!('serviceWorker' in navigator)) {
    if (manual)
      setState({
        phase: 'unsupported',
        message: '此浏览器不支持应用内更新，重新打开应用即可获取新版。',
      });
    return;
  }
  if (checking || applying || state.phase === 'downloading') return;
  if (state.phase === 'ready') {
    if (manual) setState({ phase: 'ready' });
    return;
  }
  checking = true;
  if (manual) setState({ phase: 'checking' });
  try {
    if (!registration && !registering) registerWorker();
    await registering;
    if (!registration) throw new Error('Registration unavailable');
    if (registration.waiting) {
      askStatus(registration.waiting);
      return;
    }
    lastCheck = Date.now();
    await registration.update();
    watch(registration.installing);
    watch(registration.waiting);
    if (registration.waiting) askStatus(registration.waiting);
    else if (!registration.installing && state.phase === 'checking') setState({ phase: 'current' });
  } catch {
    if (manual || getUpdateState().phase === 'downloading')
      setState({ phase: 'error', message: '暂时无法检查更新，请联网后重试。' });
  } finally {
    checking = false;
  }
}
export function applyAppUpdate() {
  if (applying || state.phase !== 'ready') return;
  const before = new Event('codesip:before-update', { cancelable: true });
  if (!window.dispatchEvent(before)) {
    setState({ message: '请先保存或关闭正在编辑的批注，再重载更新。' });
    return;
  }
  applying = true;
  setState({ phase: 'applying' });
  try {
    sessionStorage.setItem('codesip:updated-version', state.version || '');
  } catch {
    /* Reload works without session storage. */
  }
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'CODESIP_APPLY_UPDATE' });
    applyTimer = setTimeout(() => {
      applying = false;
      setState({ phase: 'ready', message: '重载尚未完成，请重试。' });
    }, 15000);
  } else location.reload();
}
