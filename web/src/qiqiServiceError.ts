// Only fixed messages are returned. Provider errors can echo credentials or prompts,
// so neither raw error text nor arbitrary error codes ever reach the UI/history.
function classify(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return;
  const fields = error as { code?: unknown; type?: unknown; message?: unknown };
  const code = typeof fields.code === 'string' ? fields.code.toLowerCase() : '';
  const message = typeof fields.message === 'string' ? fields.message.toLowerCase() : '';
  if (
    ['no_available_channel', 'channel_not_found'].includes(code) ||
    /无可用渠道|无可用通道|no available channels?|no channels? available/.test(message)
  )
    return '服务商当前没有可用的模型通道（503）。请手动切换模型或稍后重试；持续失败时，请联系服务商检查密钥分组。';
  if (['model_not_found', 'model_not_available', 'model_not_supported'].includes(code))
    return '服务商当前无法提供所选模型（503）。请检查模型名称和密钥权限，或手动切换模型。';
  if (['insufficient_quota', 'quota_exceeded'].includes(code))
    return '服务商报告 API 额度不足（503），请在服务商处检查额度。';
  if (
    ['rate_limit_exceeded', 'server_overloaded', 'overloaded_error'].includes(code) ||
    fields.type === 'overloaded_error'
  )
    return '模型服务当前繁忙（503），请稍后重试或手动切换模型。';
}

export async function qiqiServiceError(response: Response, signal: AbortSignal): Promise<Error> {
  const fallback = 'API 服务暂时无法处理请求（503）。请稍后重试，或在 API 设置中手动切换模型。';
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!response.body || !/\bapplication\/(?:[a-z0-9.-]+\+)?json\b/.test(contentType)) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    return new Error(fallback);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0,
    timedOut = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 1500);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (timedOut) return new Error(fallback);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) return new Error(fallback);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return new Error(classify(JSON.parse(text)) || fallback);
  } catch {
    signal.throwIfAborted();
    return new Error(fallback);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
