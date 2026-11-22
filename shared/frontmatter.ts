import type { NoteFrontmatter } from './types';

function parseYamlValue(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => parseYamlValue(item.trim()))
      .filter((v) => v !== undefined);
  }
  return trimmed;
}

export function parseFrontmatter(text: string): {
  frontmatter: NoteFrontmatter | null;
  content: string;
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: null, content: text };
  }
  const rawYaml = match[1];
  const content = text.slice(match[0].length);
  const data: Record<string, any> = {};
  const lines = rawYaml.split(/\r?\n/);
  let currentKey: string | null = null;
  let arrayCollector: any[] | null = null;

  for (const line of lines) {
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey && arrayCollector) {
      arrayCollector.push(parseYamlValue(listMatch[1]));
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const valStr = kvMatch[2].split('#')[0].trim();
      currentKey = key;
      if (!valStr) {
        arrayCollector = [];
        data[key] = arrayCollector;
      } else {
        arrayCollector = null;
        data[key] = parseYamlValue(valStr);
      }
    }
  }

  if (!data.note_id && !data.title && !data.created_at) {
    return { frontmatter: null, content: text };
  }

  const fm: NoteFrontmatter = {
    note_id: String(data.note_id || ''),
    title: String(data.title || ''),
    course: data.course ? String(data.course) : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
    languages: Array.isArray(data.languages) ? data.languages.map(String) : undefined,
    created_at: String(data.created_at || new Date().toISOString()),
    updated_at: String(data.updated_at || new Date().toISOString()),
    revision: Number.isInteger(data.revision) ? data.revision : 1,
    device_id: String(data.device_id || ''),
  };
  return { frontmatter: fm, content };
}

export function extractLanguages(text: string): string[] {
  const langs = new Set<string>();
  const regex = /```([a-zA-Z0-9_+#.-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const lang = match[1].toLowerCase();
    if (lang && !['text', 'txt'].includes(lang)) {
      langs.add(lang);
    }
  }
  return Array.from(langs);
}

export function extractAssetReferences(text: string): string[] {
  const assets = new Set<string>();
  const mdImg = /!\[.*?\]\((?:assets\/)?([a-f0-9]{16,64})(?:\.[a-zA-Z0-9]+)?\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdImg.exec(text)) !== null) {
    assets.add(match[1]);
  }
  const wikiImg = /!\[\[(?:assets\/)?([a-f0-9]{16,64})(?:\.[a-zA-Z0-9]+)?\]\]/g;
  while ((match = wikiImg.exec(text)) !== null) {
    assets.add(match[1]);
  }
  return Array.from(assets);
}

export function formatFrontmatter(fm: NoteFrontmatter, content: string): string {
  const lines: string[] = ['---'];
  lines.push(`note_id: "${fm.note_id}"`);
  lines.push(`title: "${fm.title.replace(/"/g, '\\"')}"`);
  if (fm.course) lines.push(`course: "${fm.course.replace(/"/g, '\\"')}"`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  if (fm.languages && fm.languages.length > 0) {
    lines.push(`languages: [${fm.languages.map((l) => JSON.stringify(l)).join(', ')}]`);
  }
  lines.push(`created_at: "${fm.created_at}"`);
  lines.push(`updated_at: "${fm.updated_at}"`);
  lines.push(`revision: ${fm.revision}`);
  lines.push(`device_id: "${fm.device_id}"`);
  lines.push('---');
  return `${lines.join('\n')}\n${content.startsWith('\n') ? content.slice(1) : content}`;
}

export function ensureFrontmatter(
  text: string,
  defaults: {
    noteId?: string;
    filePath: string;
    deviceId: string;
    title?: string;
    now?: string;
  },
): { fullMarkdown: string; frontmatter: NoteFrontmatter } {
  const { frontmatter: existing, content } = parseFrontmatter(text);
  const now = defaults.now || new Date().toISOString();
  const title =
    existing?.title ||
    defaults.title ||
    defaults.filePath.split('/').pop()?.replace(/\.md$/i, '') ||
    'Untitled';
  const autoLangs = extractLanguages(content);
  const languages = existing?.languages?.length ? existing.languages : autoLangs;

  const fm: NoteFrontmatter = {
    note_id: existing?.note_id || defaults.noteId || crypto.randomUUID(),
    title,
    course: existing?.course,
    tags: existing?.tags,
    languages: languages.length ? languages : undefined,
    created_at: existing?.created_at || now,
    updated_at: now,
    revision: existing ? existing.revision + 1 : 1,
    device_id: defaults.deviceId,
  };

  return {
    fullMarkdown: formatFrontmatter(fm, content),
    frontmatter: fm,
  };
}
