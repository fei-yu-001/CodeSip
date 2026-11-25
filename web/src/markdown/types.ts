import type { Root } from 'hast';
import type { OutlineItem } from '../readerState';

export interface MarkdownChunk {
  tree: Root;
  startLine: number;
  endLine: number;
}
export interface MarkdownDocument {
  chunks: MarkdownChunk[];
  outline: OutlineItem[];
}
export type ParseRequest = { type: 'parse'; text: string } | { type: 'next' };
export type ParseResponse =
  | { type: 'document'; outline: OutlineItem[]; total: number }
  | { type: 'chunk'; chunk: MarkdownChunk }
  | { type: 'error' };
