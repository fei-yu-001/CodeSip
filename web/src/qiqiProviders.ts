// Public provider metadata only; credentials are supplied in the user's settings.
export const qiqiProvider = {
  name: '七七预设',
  baseUrl: 'https://ai.ximupowers.tech/v1',
  models: [
    { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', label: 'DeepSeek V4.1 Flash' },
    { id: 'GLM-5.3', label: 'GLM 5.3' },
    { id: 'zai-org/GLM-5.3-Flash', label: 'GLM 5.3 Flash' },
  ],
} as const;
export function isQiqiProvider(baseUrl: string) {
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.origin === new URL(qiqiProvider.baseUrl).origin &&
      ['', '/', '/v1', '/v1/', '/v1/chat/completions', '/v1/chat/completions/'].includes(
        url.pathname,
      ) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
