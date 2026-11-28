import assert from 'node:assert/strict';
import test from 'node:test';
import { streamQiqi, type QiqiMessage, type QiqiRunOptions } from '../web/src/qiqiChat';
import { referenceLines, readQiqiReference } from '../web/src/qiqiReferences';

const config = {
  baseUrl: 'https://synthetic.example/v1',
  model: 'custom-model',
  apiKey: 'synthetic-key',
  rememberKey: false,
};
const question: QiqiMessage = {
  id: 'q1',
  role: 'user',
  content: '解释这份文件的下一行',
  context: {
    identity: { userId: 'u1', libraryId: 'lib1', path: 'source.ts' },
    line: 1,
    snippet: '// selected',
    sourceHash: 'a'.repeat(64),
    allowSourceRead: true,
  },
};
const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
    headers: { 'content-type': 'application/json' },
  });
const call = (args: unknown = { startLine: 2, lineCount: 2 }, name = 'read_reference') =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call1',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
const run = (options: Partial<QiqiRunOptions>) =>
  streamQiqi({
    config,
    messages: [question],
    signal: new AbortController().signal,
    onText() {},
    ...options,
  });

test('Pi executes the permitted tool and sends its result back to the configured model', async () => {
  const payloads: any[] = [],
    activity: string[] = [];
  let reads = 0;
  const text = await run({
    onActivity: (value) => activity.push(value),
    readReference: async (context, startLine, lineCount) => {
      reads++;
      assert.equal(context, question.context);
      assert.deepEqual([startLine, lineCount], [2, 2]);
      return '2: const value = 42;';
    },
    fetcher: async (_url, init) => {
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'custom-model');
      assert.ok(!JSON.stringify(body).includes(config.apiKey));
      payloads.push(body);
      return payloads.length === 1 ? call() : reply('这行定义了常量。');
    },
  });
  assert.equal(text, '这行定义了常量。');
  assert.equal(reads, 1);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].tools[0].function.name, 'read_reference');
  assert.deepEqual(
    payloads[1].messages.map((m: any) => m.role),
    ['system', 'user', 'assistant', 'tool'],
  );
  assert.equal(payloads[1].messages.at(-1).tool_call_id, 'call1');
  assert.equal(payloads[1].messages.at(-1).content, '2: const value = 42;');
  assert.ok(activity.some((item) => item.includes('source.ts · L2')));
  assert.equal(activity.at(-1), '');
});

test('prior permission does not enable tools on a later message or after a restored conversation', async () => {
  for (const messages of [
    [{ ...question, context: { ...question.context!, allowSourceRead: false } }],
    [question, { id: 'q2', role: 'user' as const, content: '继续' }],
  ]) {
    await run({
      messages,
      readReference: async () => {
        throw new Error('must not read');
      },
      fetcher: async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).tools, undefined);
        return reply('只根据已经附上的片段解释。');
      },
    });
  }
});

test('ungranted and fabricated tool calls never execute a file read', async () => {
  let reads = 0;
  await assert.rejects(
    run({
      messages: [{ ...question, context: undefined }],
      readReference: async () => {
        reads++;
        return '';
      },
      fetcher: async () => call(),
    }),
    /未启用/,
  );
  let calls = 0;
  await run({
    readReference: async () => {
      reads++;
      return '';
    },
    fetcher: async (_url, init) => {
      if (++calls === 1) return call({}, 'read_any_file');
      assert.match(JSON.parse(String(init?.body)).messages.at(-1).content, /not found|unknown/i);
      return reply('无法读取未授权的文件。');
    },
  });
  assert.equal(reads, 0);
});

for (const args of [
  { startLine: 0, lineCount: 2 },
  { startLine: 1, lineCount: 161 },
  { startLine: 1.5, lineCount: 2 },
  { startLine: 1, lineCount: 2, path: 'other.md' },
]) {
  test(`Pi rejects invalid tool arguments before reading: ${JSON.stringify(args)}`, async () => {
    let calls = 0,
      reads = 0;
    await run({
      readReference: async () => {
        reads++;
        return '';
      },
      fetcher: async () => (++calls === 1 ? call(args) : reply('请调整读取范围。')),
    });
    assert.equal(reads, 0);
  });
}

test('streamed tool JSON can cross UTF-8 boundaries, but an incomplete response never executes', async () => {
  const chunks = [
    {
      tool_calls: [
        { index: 0, id: 'call1', function: { name: 'read_reference', arguments: '{"start' } },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: 'Line":2,"lineCount":1}' } }] },
  ];
  const source = chunks
    .map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
    .join('');
  const response = (done: boolean) => {
    const bytes = new TextEncoder().encode(source + (done ? 'data: [DONE]\n\n' : ''));
    let i = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (i === bytes.length) controller.close();
          else controller.enqueue(bytes.slice(i, ++i));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  let reads = 0,
    calls = 0;
  const readReference = async () => {
    reads++;
    return '2: 下一行';
  };
  await run({
    readReference,
    fetcher: async () => (++calls === 1 ? response(true) : reply('读取完成')),
  });
  assert.equal(reads, 1);
  await assert.rejects(run({ readReference, fetcher: async () => response(false) }), /连接中断/);
  assert.equal(reads, 1);
});

test('stop during a tool aborts its work and prevents the next model request', async () => {
  const abort = new AbortController();
  let calls = 0,
    cancelled = false;
  await assert.rejects(
    run({
      signal: abort.signal,
      fetcher: async () => {
        calls++;
        return call();
      },
      readReference: async (_context, _start, _count, signal) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
          },
          { once: true },
        );
        abort.abort();
        signal.throwIfAborted();
        return '';
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('repeated tool calls are bounded and never marked as a completed answer', async () => {
  let calls = 0,
    reads = 0;
  await assert.rejects(
    run({
      readReference: async () => {
        reads++;
        return 'source';
      },
      fetcher: async () => {
        calls++;
        return call();
      },
    }),
    /上限/,
  );
  assert.equal(calls, 4);
  assert.equal(reads, 3);
});

test('reference extraction has accurate mixed-newline line numbers and bounded output', () => {
  assert.deepEqual(referenceLines('one\r\ntwo\rthree\nfour', 2, 2), {
    totalLines: 4,
    startLine: 2,
    text: '2: two\n3: three',
    truncated: false,
  });
  const result = referenceLines('x'.repeat(13000), 1, 1);
  assert.equal(result.text.length, 12000);
  assert.equal(result.truncated, true);
  assert.throws(() => referenceLines('one', 2, 1), /共有 1 行/);
  assert.throws(() => referenceLines('one', 0, 1), /行号/);
});

test('ungranted or unversioned references fail before touching storage or the network', async () => {
  for (const context of [
    { ...question.context!, allowSourceRead: false },
    { ...question.context!, sourceHash: '' },
  ])
    await assert.rejects(readQiqiReference(context, 1, 1, new AbortController().signal), /未授权/);
});

test('quoted source text is passed intact without silently cutting a JSON result', async () => {
  const source = JSON.stringify({ text: '"'.repeat(12000), truncated: false });
  let calls = 0;
  await run({
    readReference: async () => source,
    fetcher: async (_url, init) => {
      if (++calls === 1) return call();
      assert.equal(JSON.parse(String(init?.body)).messages.at(-1).content, source);
      return reply('已读取带引号的原文。');
    },
  });
});
