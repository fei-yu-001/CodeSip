import test from 'node:test';
import assert from 'node:assert/strict';
import { streamQiqiCompletion } from '../web/src/qiqiTransport';
import { qiqiServiceError } from '../web/src/qiqiServiceError';
const secret = 'synthetic-private-api-key';
const config = {
  baseUrl: 'https://model.example/v1',
  model: 'synthetic-model',
  apiKey: secret,
  rememberKey: false,
};
const signal = () => new AbortController().signal;
const response = (body: object) => Response.json(body, { status: 503 });

test('503 classifies known service reasons without displaying provider text, keys or prompts', async () => {
  for (const [error, expected] of [
    [
      { code: 'model_not_found', message: `当前分组 test 下对于模型 test 无可用渠道 ${secret}` },
      /没有可用的模型通道/,
    ],
    [{ code: 'no_available_channel', message: secret }, /没有可用的模型通道/],
    [{ code: '', message: `No available channel for model test ${secret}` }, /没有可用的模型通道/],
    [{ code: 'model_not_found', message: secret }, /无法提供所选模型/],
    [{ code: 'insufficient_quota', message: secret }, /额度不足/],
    [{ type: 'overloaded_error', message: secret }, /当前繁忙/],
    [{ code: secret, message: secret }, /暂时无法处理请求/],
  ] as const) {
    const result = await qiqiServiceError(response({ error }), signal());
    assert.match(result.message, expected);
    assert.ok(!result.message.includes(secret));
    assert.match(result.message, /503/);
  }
});

test('the normal transport reports a channel failure once and never retries or switches models', async () => {
  let calls = 0;
  await assert.rejects(
    streamQiqiCompletion({
      config,
      messages: [{ role: 'user', content: 'synthetic question' }],
      signal: signal(),
      onText: () => assert.fail('Error body must not become an answer'),
      fetcher: async (_url, init) => {
        calls++;
        assert.equal(JSON.parse(String(init?.body)).model, config.model);
        return response({ error: { code: 'model_not_found', message: `无可用渠道 ${secret}` } });
      },
    }),
    /没有可用的模型通道/,
  );
  assert.equal(calls, 1);
});

test('untrusted HTML, malformed JSON and oversized error bodies keep a safe 503 fallback', async () => {
  for (const result of [
    new Response(`<html>${secret}</html>`, {
      status: 503,
      headers: { 'content-type': 'text/html' },
    }),
    new Response(secret, { status: 503, headers: { 'content-type': 'application/json' } }),
    response({ error: { message: secret + 'x'.repeat(20000) } }),
  ]) {
    const error = await qiqiServiceError(result, signal());
    assert.match(error.message, /暂时无法处理请求/);
    assert.ok(!error.message.includes(secret));
  }
});

test('a stalled 503 body has a short deadline and cancels instead of hiding the HTTP failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const result = qiqiServiceError(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    ),
    signal(),
  );
  t.mock.timers.tick(1501);
  assert.match((await result).message, /暂时无法处理请求/);
  assert.equal(cancelled, true);
});

test('stop aborts an error-body read immediately and preserves cancellation semantics', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const result = qiqiServiceError(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    ),
    abort.signal,
  );
  const rejected = assert.rejects(result, { name: 'AbortError' });
  abort.abort();
  await rejected;
  assert.equal(cancelled, true);
});
