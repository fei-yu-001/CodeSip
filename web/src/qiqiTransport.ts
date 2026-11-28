import type { JsonObject } from '@earendil-works/pi-ai';
import { qiqiFetch, QiqiNativeError } from './qiqiNative';
import { qiqiEndpoint, validateQiqiConfig, QIQI_REPLY_LIMIT, type QiqiConfig } from './qiqiChat';

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}
export interface WireTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

// OpenAI-compatible Chat Completions over SSE. No cookies or CodeSip credentials
// leave this origin; only the API key and explicitly composed messages are sent.
export async function streamQiqiCompletion({
  config,
  messages,
  tools = [],
  signal,
  onText,
  fetcher = qiqiFetch,
}: {
  config: QiqiConfig;
  messages: WireMessage[];
  tools?: WireTool[];
  signal: AbortSignal;
  onText: (text: string) => void;
  fetcher?: typeof fetch;
}) {
  validateQiqiConfig(config);
  const endpoint = qiqiEndpoint(config.baseUrl);
  if (JSON.stringify(messages).length > 300000) throw new Error('这段对话已较长，请新建对话后继续');
  signal.throwIfAborted();
  const payload = JSON.stringify({
    model: config.model.trim(),
    messages,
    ...(tools.length ? { tools } : {}),
    stream: true,
  });
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
      },
      body: payload,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof QiqiNativeError) throw error;
    // Do not display arbitrary upstream error bodies: some gateways echo secrets.
    throw new Error(
      typeof navigator !== 'undefined' && /HarmonyOS|OpenHarmony/i.test(navigator.userAgent)
        ? '手机连接模型失败，请先更新 CodeSip 鸿蒙安装包，再检查 API 地址与手机网络'
        : '连接失败。请检查 API 地址、网络，以及服务是否允许浏览器跨域访问（CORS）',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'API 拒绝访问，请检查密钥和模型权限'
        : response.status === 429
          ? 'API 请求过多或额度不足，请稍后重试'
          : response.status === 404
            ? 'API 地址或模型不存在，请检查设置'
            : `API 暂时无法回答（${response.status}）`,
    );
  }
  if (!response.body) throw new Error('API 没有返回回答');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    text = '',
    finished = false,
    bytes = 0;
  const isJSON = (response.headers.get('content-type') || '').includes('application/json');
  const append = (value: unknown) => {
    if (typeof value !== 'string') return;
    if (text.length + value.length > QIQI_REPLY_LIMIT)
      throw new Error('回答过长，已停止接收，请缩小问题范围');
    text += value;
    onText(text);
  };
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const appendCalls = (values: unknown) => {
    if (values === undefined || values === null) return;
    if (!tools.length || !Array.isArray(values)) throw new Error('API 返回了未启用的工具调用');
    for (const [position, value] of values.entries()) {
      const index = value?.index ?? position;
      if (!Number.isInteger(index) || index < 0 || index >= 4)
        throw new Error('工具调用过多，已停止');
      const call = calls.get(index) || { id: '', name: '', arguments: '' };
      for (const [key, part] of [
        ['id', value?.id],
        ['name', value?.function?.name],
        ['arguments', value?.function?.arguments],
      ] as const) {
        if (part !== undefined && typeof part !== 'string') throw new Error('工具调用格式不正确');
        if (typeof part === 'string') call[key] += part;
      }
      if (call.id.length > 200 || call.name.length > 100 || call.arguments.length > 16000)
        throw new Error('工具调用过长，已停止');
      calls.set(index, call);
    }
  };
  const event = (data: string) => {
    if (!data.trim()) return;
    if (data.trim() === '[DONE]') {
      finished = true;
      return;
    }
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('API 返回了无法识别的数据，请检查接口兼容性');
    }
    if (value.error) throw new Error('API 生成失败，请检查模型设置或稍后重试');
    const choice = value.choices?.[0];
    append(choice?.delta?.content);
    appendCalls(choice?.delta?.tool_calls);
    if (choice?.finish_reason === 'length') throw new Error('回答达到模型长度限制，可继续追问');
    if (choice?.finish_reason === 'content_filter')
      throw new Error('API 未能完成此回答，请调整问题');
    if (choice?.finish_reason) finished = true;
  };
  let data: string[] = [];
  let eventSize = 0;
  const consume = (eof: boolean) => {
    for (;;) {
      const at = buffer.search(/[\r\n]/);
      if (at < 0) break;
      // A CR at the chunk boundary might be the first half of a CRLF.
      if (!eof && buffer[at] === '\r' && at === buffer.length - 1) break;
      const line = buffer.slice(0, at);
      const length = buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(at + length);
      if (!line) {
        event(data.join('\n'));
        data = [];
        eventSize = 0;
        if (finished) break;
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
        eventSize += line.length;
        if (eventSize > 1024 * 1024) throw new Error('API 返回的数据格式不正确');
      }
    }
  };
  const aborted = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    while (!finished) {
      const chunk = await reader.read();
      if (signal.aborted) throw signal.reason;
      bytes += chunk.value?.byteLength || 0;
      if (bytes > 4 * 1024 * 1024) throw new Error('API 返回的数据过大，请缩小问题范围');
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('API 返回的数据格式不正确');
      if (!isJSON) consume(chunk.done);
      if (chunk.done) break;
    }
    if (isJSON) {
      let value;
      try {
        value = JSON.parse(buffer);
      } catch {
        throw new Error('API 返回了无法识别的数据，请检查接口兼容性');
      }
      if (value.error) throw new Error('API 生成失败，请检查模型设置或稍后重试');
      append(value.choices?.[0]?.message?.content);
      appendCalls(value.choices?.[0]?.message?.tool_calls);
      if (value.choices?.[0]?.finish_reason === 'length')
        throw new Error('回答达到模型长度限制，可继续追问');
      if (value.choices?.[0]?.finish_reason === 'content_filter')
        throw new Error('API 未能完成此回答，请调整问题');
      finished = true;
    }
    if (!finished) throw new Error('连接中断，回答尚未完成，请重试');
    if (!text.trim() && !calls.size) throw new Error('API 没有返回文字，请检查模型是否支持聊天');
    const ids = new Set<string>();
    const toolCalls = [...calls.values()].map((call) => {
      if (!call.id || !call.name || ids.has(call.id)) throw new Error('工具调用格式不正确');
      ids.add(call.id);
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        throw new Error('工具调用参数不完整');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('工具调用参数不正确');
      return {
        type: 'toolCall' as const,
        id: call.id,
        name: call.name,
        arguments: args as JsonObject,
      };
    });
    return { text, toolCalls };
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
