import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Manifest, User } from '../../shared/types';
import { fileBlob } from './api';
function wikiLinks() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!node.children || ['code', 'inlineCode', 'link', 'image'].includes(node.type)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const pieces: any[] = [];
        const rx = /(!?)\[\[([^\]]+)\]\]/g;
        let start = 0;
        let match;
        while ((match = rx.exec(child.value))) {
          if (match.index > start)
            pieces.push({ type: 'text', value: child.value.slice(start, match.index) });
          const [target, label] = match[2].split('|');
          pieces.push(
            match[1]
              ? { type: 'image', url: encodeURI(target), alt: label || target }
              : {
                  type: 'link',
                  url: encodeURI(target),
                  children: [{ type: 'text', value: label || target }],
                },
          );
          start = rx.lastIndex;
        }
        if (start < child.value.length)
          pieces.push({ type: 'text', value: child.value.slice(start) });
        return pieces.length ? pieces : [child];
      });
    };
    visit(tree);
  };
}
export function resolveFile(source: string, target: string, paths: string[]): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split('#')[0].split('?')[0]);
  } catch {
    return;
  }
  if (!decoded) return source;
  const normalize = (p: string) => {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  };
  const parent = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
  const candidates = [normalize(parent + decoded), normalize(decoded)];
  for (const c of candidates)
    for (const value of [c, c + '.md']) if (paths.includes(value)) return value;
  const matches = paths.filter(
    (p) => p.split('/').pop() === decoded || p.split('/').pop() === decoded + '.md',
  );
  return matches.length === 1 ? matches[0] : undefined;
}
function VaultImage({
  src,
  alt,
  user,
  manifest,
  path,
  offline,
}: {
  src?: string;
  alt?: string;
  user: User;
  manifest: Manifest;
  path: string;
  offline: boolean;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    setUrl('');
    setError('');
    if (!src) return;
    if (/^https?:\/\//.test(src)) {
      setError('外部图片未缓存，可在原笔记中查看');
      return;
    }
    const resolved = resolveFile(
      path,
      src,
      manifest.files.map((f) => f.path),
    );
    const file = manifest.files.find((f) => f.path === resolved);
    if (!file || !file.mediaType.startsWith('image/')) {
      setError('图片未同步');
      return;
    }
    fileBlob(user, manifest.library.id, file, !offline)
      .then((blob) => {
        if (alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, path, manifest, offline]);
  return url ? (
    <img src={url} alt={alt || ''} loading="lazy" />
  ) : (
    <span className="image-fallback">
      {error || '加载图片…'}
      {alt ? ` · ${alt}` : ''}
    </span>
  );
}
export default function MarkdownReader({
  text,
  path,
  user,
  manifest,
  offline,
  navigate,
  notify,
}: {
  text: string;
  path: string;
  user: User;
  manifest: Manifest;
  offline: boolean;
  navigate: (path: string) => void;
  notify: (message: string) => void;
}) {
  return (
    <article className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, wikiLinks]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                if (/^https?:\/\/|^mailto:/.test(href || '')) return;
                event.preventDefault();
                const target = resolveFile(
                  path,
                  href || '',
                  manifest.files.map((f) => f.path),
                );
                if (target) {
                  navigate(target);
                  if (href?.includes('#')) notify('已打开目标笔记；标题和块定位将在后续版本支持');
                } else notify('未找到链接目标，请确认该笔记已同步且名称唯一');
              }}
              target={/^https?:\/\//.test(href || '') ? '_blank' : undefined}
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <VaultImage
              src={typeof src === 'string' ? src : undefined}
              alt={alt}
              user={user}
              manifest={manifest}
              path={path}
              offline={offline}
            />
          ),
          code: ({ children, className }) => <code className={className}>{children}</code>,
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}
