import { useState, type FormEvent } from 'react';
import { validateQiqiConfig, type QiqiConfig } from './qiqiChat';
import { qiqiProvider, isQiqiProvider } from './qiqiProviders';
import { useUpdateGuard } from './useUpdateGuard';

export default function QiqiSettings({
  initial,
  save,
  back,
}: {
  initial: QiqiConfig;
  save: (config: QiqiConfig) => void;
  back: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    initial.baseUrl
      ? initial
      : {
          ...initial,
          baseUrl: qiqiProvider.baseUrl,
          model: qiqiProvider.models[0].id,
        },
  );
  useUpdateGuard(
    JSON.stringify(draft) !== JSON.stringify(initial) ? '请先保存或关闭七七设置' : undefined,
  );
  const preset = isQiqiProvider(draft.baseUrl);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      validateQiqiConfig(draft);
      save({
        ...draft,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置未能保存');
    }
  };
  return (
    <form className="qiqi-settings" onSubmit={submit}>
      <h3>API 设置</h3>
      <p>使用兼容 OpenAI Chat Completions 的接口。</p>
      <button
        type="button"
        className="button secondary"
        onClick={() =>
          setDraft({
            ...draft,
            baseUrl: qiqiProvider.baseUrl,
            model: qiqiProvider.models[0].id,
            // A key for another provider must never be sent to the preset by accident.
            apiKey: preset ? draft.apiKey : '',
            rememberKey: preset && draft.rememberKey,
          })
        }
      >
        使用七七预设
      </button>
      <label>
        API 地址
        <input
          aria-label="API 地址"
          type="url"
          required
          placeholder="https://your-provider.example/v1"
          value={draft.baseUrl}
          onChange={(event) => {
            const baseUrl = event.target.value;
            let sameOrigin = false;
            try {
              sameOrigin = new URL(baseUrl).origin === new URL(draft.baseUrl).origin;
            } catch {
              /* An incomplete address must not carry a key to another service. */
            }
            setDraft({
              ...draft,
              baseUrl,
              apiKey: sameOrigin ? draft.apiKey : '',
              rememberKey: sameOrigin && draft.rememberKey,
              model:
                isQiqiProvider(baseUrl) &&
                !qiqiProvider.models.some((model) => model.id === draft.model)
                  ? qiqiProvider.models[0].id
                  : draft.model,
            });
          }}
          autoComplete="off"
        />
      </label>
      <label>
        模型
        {preset ? (
          <select
            aria-label="模型"
            required
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          >
            {!qiqiProvider.models.some((model) => model.id === draft.model) && (
              <option value="">请选择模型</option>
            )}
            {qiqiProvider.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="模型"
            required
            placeholder="填写服务商的模型名称"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            maxLength={200}
          />
        )}
      </label>
      <label>
        API Key
        <input
          aria-label="API Key"
          type="password"
          placeholder="本机免密服务可留空"
          autoComplete="off"
          spellCheck={false}
          value={draft.apiKey}
          onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          maxLength={4096}
        />
      </label>
      <label className="qiqi-check">
        <input
          type="checkbox"
          checked={draft.rememberKey}
          onChange={(event) => setDraft({ ...draft, rememberKey: event.target.checked })}
        />
        在此设备记住密钥
      </label>
      <p>默认只在当前页面使用密钥。勾选后保存在此浏览器，退出账号时清除。</p>
      <p>
        浏览器直接连接该地址，接口需允许跨域访问（CORS）。发送的内容包括此对话和你添加的引用；不会自动读取其他文件。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="qiqi-actions">
        <button type="button" className="button secondary" onClick={back}>
          返回对话
        </button>
        <button className="button primary">保存 API 设置</button>
      </div>
    </form>
  );
}
