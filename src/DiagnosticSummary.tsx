import { useRef, useState } from 'react';
import type { ManagerTask } from './tasks';
import { diagnosticSummary } from './operation-problems';
import './diagnostics.css';

export function DiagnosticSummary({ version, basicMode, tasks, skillCount, sourceErrors, visible = true }: { version: string; basicMode: boolean; tasks: readonly ManagerTask[]; skillCount: number; sourceErrors: number; visible?: boolean }) {
  const [preview, setPreview] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false);
  async function copy() {
    if (!visible || !preview || pending.current) return;
    pending.current = true; setNotice('');
    try { await navigator.clipboard.writeText(preview); setNotice('已复制当前预览，未上传。'); }
    catch { setNotice('无法访问剪贴板，请在下面选择并复制摘要。'); }
    finally { pending.current = false; }
  }
  return <section className="diagnostic-summary" aria-label="诊断摘要">
    <div className="section-actions"><button type="button" disabled={!visible} onClick={() => { setPreview(diagnosticSummary({ version, basicMode, tasks, skillCount, sourceErrors, generatedAt: new Date().toISOString() })); setNotice(''); }}>生成诊断预览</button>{preview && <button type="button" disabled={!visible} onClick={() => void copy()}>复制当前摘要</button>}</div>
    <p className="muted small-text">按需汇总当前版本、任务阶段、问题类别和已有任务耗时。先预览再复制，不包含凭据、文件内容和原始错误，也不上传。</p>
    {preview && <textarea aria-label="可复制的诊断摘要" readOnly value={preview} rows={12} spellCheck={false} />}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
