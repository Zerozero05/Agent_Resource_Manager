import { useEffect, useRef, useState } from 'react';
import { Globe2, CheckCircle2, CircleAlert } from 'lucide-react';
import { networkDiagnosticView, type NetworkDiagnostic } from './network-diagnostics';

type Configuration = { mode: 'auto' | 'direct' | 'manual'; proxyUrl?: string; hasProxyCredentials?: boolean };
type Diagnostic = NetworkDiagnostic;
type NetworkResult = { api: Diagnostic; raw: Diagnostic };
export type NetworkSettingsDraft = { config?: Configuration };
const comparable = (config: Configuration) => JSON.stringify([config.mode, config.proxyUrl || '']);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function NetworkSettings({ request, notify, initialDraft, onDraftChange, onContextChange }: {
  request: <T>(action: string, args?: Record<string, unknown>) => Promise<T>;
  notify: (tone: 'success' | 'error' | 'info', message: string) => void;
  initialDraft?: NetworkSettingsDraft; onDraftChange?: (draft: NetworkSettingsDraft) => void;
  onContextChange?: (value?: unknown) => Promise<void>;
}) {
  const [config, setConfig] = useState<Configuration>(initialDraft?.config || { mode: 'auto' });
  const [saved, setSaved] = useState<Configuration>();
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(''); const [message, setMessage] = useState('');
  const [error, setError] = useState(''); const [result, setResult] = useState<NetworkResult>();
  const [readAttempt, setReadAttempt] = useState(0), [reading, setReading] = useState(true);
  const [errorHeading, setErrorHeading] = useState('');
  const [saveNeedsReadback, setSaveNeedsReadback] = useState(false);
  const [confirmCredentialRemoval, setConfirmCredentialRemoval] = useState(false);
  const appliedDraft = useRef<Configuration | undefined>(undefined), saveLock = useRef(false);
  const initial = useRef(initialDraft); const onDraft = useRef(onDraftChange); onDraft.current = onDraftChange;
  useEffect(() => {
    let alive = true;
    setReading(true);
    request<Configuration>('get_network_settings').then(value => {
      if (!alive) return;
      setSaved(value); setConfig(initial.current?.config ? { ...initial.current.config, hasProxyCredentials: value.hasProxyCredentials } : value);
      setError('');
    }).catch(cause => { if (alive) { setErrorHeading('网络设置读取失败'); setError(errorText(cause)); } })
      .finally(() => { if (alive) setReading(false); });
    return () => { alive = false; };
  }, [request, readAttempt]);
  useEffect(() => { if (saved) onDraft.current?.({ config }); }, [config, saved]);
  const baseline = saveNeedsReadback && appliedDraft.current ? appliedDraft.current : saved;
  const dirty = !!baseline && comparable(config) !== comparable(baseline) || !!username || !!password;
  useEffect(() => { setConfirmCredentialRemoval(false); }, [saved, config.mode, config.proxyUrl, config.hasProxyCredentials, username, password, saveNeedsReadback]);
  async function save(clearProxyCredentials = false) {
    if (saveLock.current || busy || reading || !saved || saveNeedsReadback || clearProxyCredentials && (!confirmCredentialRemoval || dirty)) return;
    saveLock.current = true; setConfirmCredentialRemoval(false);
    setBusy('save'); setMessage('正在保存网络设置…'); setError(''); setResult(undefined);
    let applied = false;
    try {
      const reply = await request('set_network_settings', { settings: { mode: config.mode, proxyUrl: config.proxyUrl || '' }, ...(username || password ? { proxyUsername: username, proxyPassword: password } : {}), clearProxyCredentials });
      applied = true; appliedDraft.current = { ...config }; setUsername(''); setPassword('');
      await onContextChange?.(reply);
      const value = await request<Configuration>('get_network_settings');
      setConfig(value); setSaved(value); setUsername(''); setPassword('');
      appliedDraft.current = undefined; setSaveNeedsReadback(false);
      setMessage('网络设置已保存。'); notify('success', '网络设置已保存。');
    } catch (cause) { setSaveNeedsReadback(applied); setErrorHeading(applied ? '网络设置已保存，后续状态刷新未完成' : '网络设置保存未完成'); setError(errorText(cause)); setMessage(''); try { await onContextChange?.(); } catch { /* Keep the original operation failure visible. */ } }
    finally { saveLock.current = false; setBusy(''); }
  }
  async function readSavedResult() {
    if (!saveNeedsReadback || reading || busy) return;
    setReading(true); setError(''); setMessage('');
    const submitted = appliedDraft.current;
    try {
      const value = await request<Configuration>('get_network_settings');
      setSaved(value);
      setConfig(draft => submitted && comparable(draft) === comparable(submitted) ? value : { ...draft, hasProxyCredentials: value.hasProxyCredentials });
      appliedDraft.current = undefined; setSaveNeedsReadback(false);
      setMessage('已重新读取保存结果。');
    } catch (cause) { setErrorHeading('保存结果读取未完成'); setError(errorText(cause)); setMessage(''); }
    finally { setReading(false); }
  }
  async function test() {
    setBusy('test'); setMessage('正在测试已保存设置的 GitHub API 与文件入口…'); setError(''); setResult(undefined);
    try { setResult(await request<NetworkResult>('test_network')); setMessage('测试完成 · 使用已保存的网络设置'); }
    catch (cause) { setErrorHeading('网络连接测试未完成'); setError(errorText(cause)); setMessage(''); }
    finally { setBusy(''); }
  }
  return <section className="panel network-panel" aria-label="网络连接" aria-busy={reading || !!busy}>
    <div className="panel-heading"><div><h2 title="配置管理器的连接方式；API 与文件入口分别检查。">网络连接</h2></div><Globe2 size={20} aria-hidden="true" /></div>
    <div className="panel-body network-form">
      <label className="field-label network-mode setting-row"><span className="setting-copy"><strong>连接方式</strong></span><select disabled={!!busy || reading || !saved} value={config.mode} onChange={event => setConfig(previous => ({ ...previous, mode: event.target.value as Configuration['mode'] }))}>
        <option value="auto">跟随系统与环境代理</option><option value="direct">直接连接</option><option value="manual">手动代理</option>
      </select></label>
      {config.mode === 'manual' && <>
        <label className="field-label">代理地址<input disabled={!!busy || reading || !saved} placeholder="http://127.0.0.1:端口 或 socks5://127.0.0.1:端口" value={config.proxyUrl || ''} onChange={event => setConfig(previous => ({ ...previous, proxyUrl: event.target.value }))} spellCheck={false} /></label>
        <div className="network-credentials">
          <label className="field-label">用户名（可选）<input disabled={!!busy || reading || !saved} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></label>
          <label className="field-label">密码（可选）<input disabled={!!busy || reading || !saved} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
        </div>
        <p className="network-dirty">凭据保存在系统凭据管理器。留空保持已有值；保存后清空输入。</p>
      </>}
      <div className="network-actions">
        <button className="button primary" disabled={!!busy || reading || !saved || !dirty || saveNeedsReadback} onClick={() => void save()}>{busy === 'save' ? '正在保存…' : '保存网络设置'}</button>
        <button className="button secondary" disabled={!!busy || reading || !saved} onClick={() => void test()}>{busy === 'test' ? '正在测试…' : '测试已保存设置'}</button>
      </div>
      {config.hasProxyCredentials && <section className="network-credential-removal" aria-label="代理凭据管理"><div className="network-credential-heading"><strong>代理凭据</strong><button className="button danger" aria-expanded={confirmCredentialRemoval} disabled={!!busy || reading || !saved || dirty || saveNeedsReadback} onClick={() => setConfirmCredentialRemoval(value => !value)}>移除代理凭据</button></div><p className="network-dirty">移除后，需要认证时须重新输入用户名和密码。</p>{dirty && <p className="network-dirty">请先保存修改，或将输入恢复为已保存内容。</p>}{confirmCredentialRemoval && <div className="network-actions"><button className="button danger" disabled={!!busy || reading || dirty || saveNeedsReadback} onClick={() => void save(true)}>确认移除代理凭据</button><button className="button" disabled={!!busy || reading} onClick={() => setConfirmCredentialRemoval(false)}>取消</button></div>}</section>}
      {reading && <p className="network-feedback" role="status">{saveNeedsReadback ? '正在重新读取保存结果…' : '正在读取网络设置…'}</p>}
      {dirty && <p className="network-dirty" role="status">当前有未保存的修改。测试使用上次保存的设置。</p>}
      {message && <p className="network-feedback" role="status">{message}</p>}
      {error && <div className="network-feedback network-error" role="alert"><strong>{errorHeading}</strong><p>{error}</p>{!saved && <button className="button" disabled={!!busy || reading} onClick={() => { setError(''); setReadAttempt(value => value + 1); }}>重新读取网络设置</button>}</div>}
      {saveNeedsReadback && <div className="network-actions"><button className="button" disabled={!!busy || reading} onClick={() => void readSavedResult()}>重新读取保存结果</button></div>}
      {result && <div className="network-results" aria-label="网络测试结果">{([['GitHub API', result.api], ['文件入口', result.raw]] as const).map(([name, item]) => { const view = networkDiagnosticView(item); return <div className="network-result-row" key={name} data-diagnostic-ok={view.success}>
        <strong>{name}</strong><span className={view.success ? '' : 'error-text'}>{view.success ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />} {view.text}</span><time>{Math.round(item.durationMs)} ms</time>
      </div>; })}</div>}
    </div>
  </section>;
}
