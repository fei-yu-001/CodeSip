import test from 'node:test';
import assert from 'node:assert/strict';
import { qiqiProvider, isQiqiProvider } from '../web/src/qiqiProviders';
import { qiqiEndpoint, streamQiqi } from '../web/src/qiqiChat';
test('preset has the three exact gateway model IDs and a canonical chat endpoint', () => {
  assert.deepEqual(
    qiqiProvider.models.map((model) => model.id),
    ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'GLM-5.3', 'zai-org/GLM-5.3-Flash'],
  );
  assert.equal(
    qiqiEndpoint(qiqiProvider.baseUrl),
    'https://ai.ximupowers.tech/v1/chat/completions',
  );
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1/chat/completions'])
    assert.equal(isQiqiProvider(`https://ai.ximupowers.tech${suffix}`), true);
  for (const url of [
    'https://ai.ximupowers.tech.evil.example/v1',
    'http://ai.ximupowers.tech/v1',
    'https://ai.ximupowers.tech/custom',
    'https://key@ai.ximupowers.tech/v1',
    'https://ai.ximupowers.tech/v1?key=secret',
  ])
    assert.equal(isQiqiProvider(url), false);
});
test('each selected preset model is forwarded unchanged and keys never enter the payload', async () => {
  for (const model of qiqiProvider.models) {
    await streamQiqi({
      config: {
        baseUrl: qiqiProvider.baseUrl,
        model: model.id,
        apiKey: 'synthetic-key',
        rememberKey: false,
      },
      messages: [{ id: 'question', role: 'user', content: '合成测试问题' }],
      signal: new AbortController().signal,
      onText: () => {},
      fetcher: async (url, init) => {
        assert.equal(url, qiqiEndpoint(qiqiProvider.baseUrl));
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, model.id);
        assert.equal(String(init?.body).includes('synthetic-key'), false);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key');
        return Response.json({ choices: [{ message: { content: '合成回答' } }] });
      },
    });
  }
});
