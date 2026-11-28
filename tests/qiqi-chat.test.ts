import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadQiqiConfig,
  saveQiqiConfig,
  loadQiqiConversations,
  saveQiqiConversations,
  qiqiEndpoint,
  qiqiContext,
  qiqiMessages,
  streamQiqi,
  QIQI_CONTEXT_LIMIT,
  type QiqiConfig,
  type QiqiMessage,
  type QiqiConversation,
} from '../web/src/qiqiChat';
const config: QiqiConfig = {
  baseUrl: 'https://provider.example/v1',
  model: 'test-model',
  apiKey: 'test-secret',
  rememberKey: false,
};
const context = {
  identity: { userId: 'user-a', libraryId: 'library-a', path: 'src/example.ts' },
  line: 12,
  snippet: 'const answer = 42;',
  note: '为什么这样写？',
  sourceHash: 'synthetic-version',
};
const question: QiqiMessage = { id: 'question', role: 'user', content: '解释一下', context };
const memory = () => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
  } satisfies Storage;
};
const sse = (value: string, chunkSize = 1, type = 'text/event-stream') => {
  const data = new TextEncoder().encode(value);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= data.length) controller.close();
        else {
          controller.enqueue(data.slice(offset, offset + chunkSize));
          offset += chunkSize;
        }
      },
    }),
    { headers: { 'Content-Type': type } },
  );
};
const chunk = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
const run = (response: Response, onText = (_text: string) => {}) =>
  streamQiqi({
    config,
    messages: [question],
    signal: new AbortController().signal,
    onText,
    fetcher: async () => response,
  });

test('API addresses preserve gateway paths, accept endpoints and reject embedded credentials', () => {
  assert.equal(
    qiqiEndpoint('https://provider.example'),
    'https://provider.example/v1/chat/completions',
  );
  assert.equal(
    qiqiEndpoint('https://provider.example/openai/v1/'),
    'https://provider.example/openai/v1/chat/completions',
  );
  assert.equal(
    qiqiEndpoint('https://provider.example/v1/chat/completions'),
    'https://provider.example/v1/chat/completions',
  );
  assert.equal(
    qiqiEndpoint('http://localhost:11434/v1'),
    'http://localhost:11434/v1/chat/completions',
  );
  for (const value of [
    'http://provider.example/v1',
    'file:///tmp/file',
    'javascript:alert(1)',
    'https://name:secret@provider.example',
    'https://provider.example?key=secret',
    'https://provider.example/#key',
  ])
    assert.throws(() => qiqiEndpoint(value));
});

test('keys are opt-in, isolated by account, and forgotten before a failing settings write', () => {
  const storage = memory();
  saveQiqiConfig(storage, 'a', config);
  assert.equal(loadQiqiConfig(storage, 'a').apiKey, '');
  assert.ok(!storage.getItem(storage.key(0)!)?.includes('test-secret'));
  saveQiqiConfig(storage, 'a', { ...config, rememberKey: true });
  assert.equal(loadQiqiConfig(storage, 'a').apiKey, 'test-secret');
  assert.equal(loadQiqiConfig(storage, 'b').baseUrl, '');
  const failing = {
    ...storage,
    setItem() {
      throw new Error('quota');
    },
  };
  assert.throws(() => saveQiqiConfig(failing, 'a', config));
  assert.equal(loadQiqiConfig(storage, 'a').apiKey, '');
});

test('only attached content enters the request and unfinished assistant responses are excluded', () => {
  const payload = qiqiMessages([
    question,
    { id: 'partial', role: 'assistant', content: 'unfinished private answer', status: 'stopped' },
    { id: 'next', role: 'user', content: '继续' },
  ]);
  assert.equal(payload.length, 3);
  assert.match(payload[1].content, /src\/example.ts/);
  assert.match(payload[1].content, /为什么这样写/);
  assert.match(payload[1].content, /synthetic-version/);
  assert.ok(!JSON.stringify(payload).includes('library-a'));
  assert.ok(!JSON.stringify(payload).includes('unfinished private answer'));
  assert.ok(!JSON.stringify(payload).includes('test-secret'));
  const long = qiqiContext({ ...context, snippet: 'x'.repeat(QIQI_CONTEXT_LIMIT + 5) });
  assert.equal(long.snippet.length, QIQI_CONTEXT_LIMIT);
  assert.equal(long.truncated, true);
  assert.throws(() => qiqiMessages([{ ...question, content: 'x'.repeat(240001) }]), /新建对话/);
});

test('conversation restoration rejects cross-account attachments and malformed data', () => {
  const storage = memory();
  const chat: QiqiConversation = { id: 'chat', title: '阅读', updatedAt: 1, messages: [question] };
  saveQiqiConversations(storage, 'user-a', [chat]);
  assert.equal(loadQiqiConversations(storage, 'user-a').length, 1);
  saveQiqiConversations(storage, 'user-b', [chat]);
  assert.equal(loadQiqiConversations(storage, 'user-b').length, 0);
  storage.setItem(storage.key(0)!, '{bad json');
  assert.deepEqual(loadQiqiConversations(storage, 'user-a'), []);
});

for (const newline of ['\n', '\r\n', '\r']) {
  test(`stream handles UTF-8 and SSE boundaries split at every byte (${JSON.stringify(newline)})`, async () => {
    const updates: string[] = [];
    const source = [
      `: keepalive${newline}${newline}`,
      `data: ${chunk('你好')}${newline}${newline}`,
      `data: ${chunk('，七七👋')}${newline}${newline}`,
      `data: [DONE]${newline}${newline}`,
    ].join('');
    assert.equal(await run(sse(source), (text) => updates.push(text)), '你好，七七👋');
    assert.deepEqual(updates, ['你好', '你好，七七👋']);
  });
}

test('request uses only explicit key, no cookies or referrer, and no redirects', async () => {
  let calls = 0;
  await streamQiqi({
    config,
    messages: [question],
    signal: new AbortController().signal,
    onText() {},
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, 'https://provider.example/v1/chat/completions');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.referrerPolicy, 'no-referrer');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-secret');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, config.model);
      assert.equal(body.stream, true);
      return sse(`data: ${chunk('说明')}\n\ndata: [DONE]\n\n`, 32);
    },
  });
  assert.equal(calls, 1);
});

test('gateways returning ordinary JSON are supported', async () => {
  assert.equal(
    await run(
      sse(
        JSON.stringify({ choices: [{ message: { content: '回答' }, finish_reason: 'stop' }] }),
        5,
        'application/json',
      ),
    ),
    '回答',
  );
});

test('truncated, empty, malformed and upstream error responses are not marked complete', async () => {
  await assert.rejects(run(sse(`data: ${chunk('半段')}\n\n`)), /连接中断/);
  await assert.rejects(run(sse('data: [DONE]\n\n')), /没有返回文字/);
  await assert.rejects(run(sse('data: invalid\n\n')), /无法识别/);
  await assert.rejects(
    run(sse('data: {"error":{"message":"test-secret"}}\n\n')),
    (error: Error) => !error.message.includes('test-secret'),
  );
  await assert.rejects(run(new Response('test-secret', { status: 401 })), /密钥/);
  await assert.rejects(run(new Response('test-secret', { status: 429 })), /额度/);
  const limited = { choices: [{ delta: { content: '半段' }, finish_reason: 'length' }] };
  await assert.rejects(run(sse(`data: ${JSON.stringify(limited)}\n\n`)), /长度限制/);
});

test('stop cancels an in-flight reader and keeps already delivered text', async () => {
  const abort = new AbortController();
  let cancelled = false,
    delivered = '';
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${chunk('可保留的半段')}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  await assert.rejects(
    streamQiqi({
      config,
      messages: [question],
      signal: abort.signal,
      fetcher: async () => response,
      onText(text) {
        delivered = text;
        abort.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(delivered, '可保留的半段');
  assert.equal(cancelled, true);
});

test('oversized API data is bounded before being shown or saved', async () => {
  await assert.rejects(run(sse(`data: ${chunk('x'.repeat(100001))}\n\n`, 16384)), /回答过长/);
});
