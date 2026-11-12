import { useEffect, useRef, useState } from 'react';

export type SkillSourceMapping = { sourceId?: string | null; repo?: string | null; branch?: string | null; remotePath?: string | null; commit?: string | null };
type Action = <T>(label: string, action: string, args: Record<string, unknown>) => Promise<T>;
type Health = { skillId: string; source: SkillSourceMapping; health: { status: string; message: string; checkedAt: string } };
const mappingKey = (source: SkillSourceMapping) => JSON.stringify([source.sourceId ?? null, source.repo ?? null, source.branch ?? null, source.remotePath || '', source.commit ?? null]);

export function SourceMapping({ title, source }: { title: string; source?: SkillSourceMapping | null }) {
  return <section className="source-mapping" aria-label={title}><h4>{title}</h4><dl className="info-grid compact">
    <dt>仓库</dt><dd className="break-text">{source?.repo || '未记录'}</dd>
    <dt>目录</dt><dd className="monospace">{source?.repo ? source.remotePath || '仓库根目录' : '未知'}</dd>
    <dt>分支／提交</dt><dd className="monospace">{source?.branch || '未知'} · {source?.commit || '未知'}</dd>
  </dl></section>;
}

export function SkillSourceHealth({ skillId, source, installed, action, readOnly = false, visible = true }: {
  skillId: string; source: SkillSourceMapping; installed?: SkillSourceMapping | null; action: Action; readOnly?: boolean; visible?: boolean;
}) {
  const identity = JSON.stringify([skillId, mappingKey(source)]);
  const current = useRef({ identity, visible, readOnly }); current.current = { identity, visible, readOnly };
  const pending = useRef(false), generation = useRef(0);
  const [busy, setBusy] = useState(false), [result, setResult] = useState<{ identity: string; value: Health } | null>(null), [error, setError] = useState('');
  useEffect(() => {
    generation.current++; pending.current = false; setBusy(false); setResult(null); setError('');
    return () => { generation.current++; };
  }, [identity, visible, readOnly]);
  async function check() {
    if (pending.current || readOnly || !visible || !source.repo) return;
    pending.current = true; setBusy(true); setError(''); setResult(null);
    const ticket = ++generation.current;
    const active = () => generation.current === ticket && current.current.identity === identity && current.current.visible && !current.current.readOnly;
    try {
      const value = await action<Health>('检查 Skill 来源', 'skill_source_health', { skillId });
      if (!active()) return;
      if (value.skillId !== skillId || mappingKey(value.source) !== mappingKey(source)) throw new Error('返回的来源已变化，请重新检查。');
      setResult({ identity, value });
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  const labels: Record<string, string> = { reachable: '可访问', changed: '来源映射已变化', available: '可访问', healthy: '可访问', ok: '可访问', authentication: '需要认证', permission: '权限不足', rateLimited: '请求限流', network: '网络异常', unavailable: '暂不可访问', error: '检查失败', unbound: '未关联', unconfigured: '未关联' };
  const shown = result?.identity === identity ? result.value : null;
  return <section aria-label="来源健康与安装记录">
    <SourceMapping title="原安装来源" source={installed} />
    <div className="section-actions"><button type="button" className="button" disabled={busy || readOnly || !visible || !source.repo} onClick={() => void check()}>{busy ? '正在检查来源…' : '检查来源健康'}</button></div>
    {readOnly && <p className="muted small-text">基本模式保留来源记录，联网检查已暂停。</p>}
    {shown && <p role="status"><strong>{labels[shown.health.status] || '检查结果'}</strong> · {shown.health.message}<small className="muted"> <time dateTime={shown.health.checkedAt}>{shown.health.checkedAt}</time></small></p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
