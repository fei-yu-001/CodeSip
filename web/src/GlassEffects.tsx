import { useEffect } from 'react';
const svgNS = 'http://www.w3.org/2000/svg';
// Original rounded-surface optical map: only the narrow rim bends the backdrop.
export function displacementMap(width: number, height: number, radius: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(canvas.width, canvas.height);
  const r = Math.min(radius, width / 2, height / 2);
  const band = Math.min(20, height * 0.27, r);
  const scale = Math.min(32, height * 0.55);
  const eta = 1 / 1.5;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++) {
      const cx = Math.max(r, Math.min(width - r, x + 0.5)),
        cy = Math.max(r, Math.min(height - r, y + 0.5));
      const dx = x + 0.5 - cx,
        dy = y + 0.5 - cy;
      const length = Math.hypot(dx, dy);
      const depth = r - length;
      let ox = 0,
        oy = 0;
      if (length > 0 && depth >= 0 && depth < band) {
        const t = Math.min(0.985, 1 - depth / band);
        const theta = Math.asin(t);
        const refracted = Math.asin(eta * Math.sin(theta));
        const shift =
          Math.min(scale * 0.43, Math.tan(theta - refracted) * band * 0.75) *
          Math.min(1, depth / 1.5);
        ox = (dx / length) * shift;
        oy = (dy / length) * shift;
      }
      const i = (y * canvas.width + x) * 4;
      data.data[i] = Math.round(127.5 + (ox / scale) * 255);
      data.data[i + 1] = Math.round(127.5 + (oy / scale) * 255);
      data.data[i + 2] = 128;
      data.data[i + 3] = 255;
    }
  ctx.putImageData(data, 0, 0);
  return { url: canvas.toDataURL(), scale };
}
export default function GlassEffects() {
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)'),
      opaque = matchMedia('(prefers-reduced-transparency: reduce)');
    const chromium =
      /Chrome|Chromium|Edg\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    Object.assign(svg.style, { position: 'fixed', width: '0', height: '0', pointerEvents: 'none' });
    document.body.append(svg);
    const defs = document.createElementNS(svgNS, 'defs');
    svg.append(defs);
    let counter = 0;
    const attached = new Map<
      HTMLElement,
      { filter: SVGElement; resize: ResizeObserver; cleanup: () => void }
    >();
    const selectors =
      '.mobile-nav,.search-input,.topbar,.modal,.button.primary,.button.secondary,.sidebar nav';
    const attach = (el: HTMLElement) => {
      el.classList.add('liquid');
      if (attached.has(el)) return;
      const id = `codesip-glass-${++counter}`;
      const filter = document.createElementNS(svgNS, 'filter');
      filter.id = id;
      filter.setAttribute('x', '0%');
      filter.setAttribute('y', '0%');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const image = document.createElementNS(svgNS, 'feImage');
      image.setAttribute('result', 'map');
      image.setAttribute('preserveAspectRatio', 'none');
      const displacement = document.createElementNS(svgNS, 'feDisplacementMap');
      displacement.setAttribute('in', 'SourceGraphic');
      displacement.setAttribute('in2', 'map');
      displacement.setAttribute('xChannelSelector', 'R');
      displacement.setAttribute('yChannelSelector', 'G');
      filter.append(image, displacement);
      defs.append(filter);
      let size = '';
      let timer: number;
      const update = () => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const key = `${Math.ceil(rect.width)}:${Math.ceil(rect.height)}:${opaque.matches}`;
        if (size === key) return;
        size = key;
        if (chromium && CSS.supports('backdrop-filter', 'url(#codesip-probe)') && !opaque.matches) {
          const map = displacementMap(
            rect.width,
            rect.height,
            parseFloat(getComputedStyle(el).borderRadius) || 24,
          );
          image.setAttribute('href', map.url);
          image.setAttribute('width', String(Math.ceil(rect.width)));
          image.setAttribute('height', String(Math.ceil(rect.height)));
          displacement.setAttribute('scale', String(map.scale));
          el.style.setProperty('--glass-filter', `url(#${id}) blur(.35px)`);
          el.dataset.optics = 'refraction';
        } else {
          el.style.setProperty('--glass-filter', opaque.matches ? 'none' : 'blur(14px)');
          el.dataset.optics = opaque.matches ? 'opaque' : 'frosted';
        }
      };
      const resize = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = window.setTimeout(update, 50);
      });
      resize.observe(el);
      update();
      const move = (event: PointerEvent) => {
        if (reduced.matches) return;
        const box = el.getBoundingClientRect();
        el.style.setProperty(
          '--glint-x',
          `${Math.round(((event.clientX - box.left) / box.width) * 100)}%`,
        );
      };
      el.addEventListener('pointermove', move);
      const change = () => {
        size = '';
        update();
      };
      opaque.addEventListener('change', change);
      attached.set(el, {
        filter,
        resize,
        cleanup: () => {
          clearTimeout(timer);
          el.removeEventListener('pointermove', move);
          opaque.removeEventListener('change', change);
        },
      });
    };
    const scan = () => {
      document.querySelectorAll<HTMLElement>(selectors).forEach(attach);
      for (const [el, item] of attached)
        if (!el.isConnected) {
          item.resize.disconnect();
          item.cleanup();
          item.filter.remove();
          attached.delete(el);
        }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    scan();
    // Sliding navigation responds to drag; cancellation restores the selected tab.
    let gesture:
      | { nav: HTMLElement; start: number; last: number; selected: HTMLElement; pointerId: number }
      | undefined;
    const selectPosition = (nav: HTMLElement, target: HTMLElement) => {
      nav.style.setProperty('--selection-x', `${target.offsetLeft}px`);
      nav.style.setProperty('--selection-y', `${target.offsetTop}px`);
      nav.style.setProperty('--selection-w', `${target.offsetWidth}px`);
      nav.style.setProperty('--selection-h', `${target.offsetHeight}px`);
    };
    const position = () =>
      document.querySelectorAll<HTMLElement>('.mobile-nav,.sidebar nav').forEach((nav) => {
        const selected = nav.querySelector<HTMLElement>('button.active,button.selected');
        if (selected) selectPosition(nav, selected);
      });
    const down = (event: PointerEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.mobile-nav>button');
      if (!target || target.hasAttribute('aria-haspopup')) return;
      const nav = target.parentElement!;
      const selected = nav.querySelector<HTMLElement>('button.active') || target;
      gesture = {
        nav,
        start: event.clientX,
        last: event.clientX,
        selected,
        pointerId: event.pointerId,
      };
    };
    const drag = (event: PointerEvent) => {
      if (!gesture) return;
      gesture.last = event.clientX;
      if (Math.abs(gesture.last - gesture.start) > 8) {
        if (!gesture.nav.hasPointerCapture(gesture.pointerId))
          gesture.nav.setPointerCapture(gesture.pointerId);
        gesture.nav.classList.add('dragging');
      }
      const delta = Math.max(-65, Math.min(65, event.clientX - gesture.start));
      gesture.nav.style.setProperty('--drag-x', `${delta}px`);
    };
    const settle = (event: PointerEvent) => {
      if (!gesture) return;
      const g = gesture;
      gesture = undefined;
      g.nav.classList.remove('dragging');
      g.nav.style.setProperty('--drag-x', '0px');
      if (g.nav.hasPointerCapture(g.pointerId)) g.nav.releasePointerCapture(g.pointerId);
      if (event.type === 'pointerup' && Math.abs(g.last - g.start) > 18) {
        const candidates = Array.from(g.nav.querySelectorAll<HTMLButtonElement>('button')).slice(
          0,
          2,
        );
        const target = candidates.reduce((a, b) =>
          Math.abs(b.getBoundingClientRect().x + b.offsetWidth / 2 - g.last) <
          Math.abs(a.getBoundingClientRect().x + a.offsetWidth / 2 - g.last)
            ? b
            : a,
        );
        target.click();
      } else selectPosition(g.nav, g.selected);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', drag);
    document.addEventListener('pointerup', settle);
    document.addEventListener('pointercancel', settle);
    const positionObserver = new MutationObserver(position);
    positionObserver.observe(document.getElementById('root')!, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', position);
    position();
    return () => {
      observer.disconnect();
      positionObserver.disconnect();
      window.removeEventListener('resize', position);
      for (const item of attached.values()) {
        item.resize.disconnect();
        item.cleanup();
      }
      svg.remove();
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', drag);
      document.removeEventListener('pointerup', settle);
      document.removeEventListener('pointercancel', settle);
    };
  }, []);
  return null;
}
