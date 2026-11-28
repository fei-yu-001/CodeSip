import { memo } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import type { MarkdownChunk } from './types';

export const MarkdownChunkView = memo(function MarkdownChunkView({
  chunk,
  components,
}: {
  chunk: MarkdownChunk;
  components: Partial<Components>;
}) {
  return toJsxRuntime(chunk.tree, {
    Fragment,
    jsx,
    jsxs,
    components,
    ignoreInvalidStyle: true,
    passKeys: true,
    passNode: true,
  });
});
