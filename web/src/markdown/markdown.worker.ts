import { parseMarkdown } from './parse';
import type { MarkdownDocument, ParseRequest, ParseResponse } from './types';

let document: MarkdownDocument | undefined;
let cursor = 0;
const send = (message: ParseResponse) => self.postMessage(message);
self.onmessage = (event: MessageEvent<ParseRequest>) => {
  try {
    if (event.data.type === 'parse') {
      document = parseMarkdown(event.data.text);
      cursor = 0;
      send({ type: 'document', outline: document.outline, total: document.chunks.length });
      if (!document.chunks.length) self.close();
    } else if (document && cursor < document.chunks.length) {
      send({ type: 'chunk', chunk: document.chunks[cursor++] });
      if (cursor === document.chunks.length) {
        document = undefined;
        self.close();
      }
    }
  } catch {
    document = undefined;
    // Never put note text or parser diagnostics containing it into logs or UI.
    send({ type: 'error' });
  }
};
