import { useEffect, useRef, useState } from 'react';
import './task-results.css';

type ResultFile = { id: string; label: string; path: string; status: string; reason: string; canOpen: boolean; canOpenFolder: boolean };
type Results = { taskId: string; files: ResultFile[] };
type Request = <T>(action: string, args: Record<string, unknown>) => Promise<T>;
export function TaskResults({ taskId, request, basicMode = false, visible = true }: { taskId: string; request: Request; basicMode?: boolean; visible?: boolean }) {
  const [data, setData] = useState<Results | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false), generation = useRef(0), alive = useRef(true);
  const current = useRef({ taskId, visible }); current.current = { taskId, visible };
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  async function load() {
    if (pending.current || !current.current.visible) return;
    const id = taskId, ticket = ++generation.current; pending.current = true; setBusy(true); setError('');
    try {
      const result = await requestRef.current<Results>('task_result_files', { taskId: id });
      if (!alive.current || ticket !== generation.current || current.current.taskId !== id) return;
      if (result.taskId !== id) throw new Error('结果记录不匹配，请重新读取。');
      setData(result);
    } catch (cause) { if (alive.current && ticket === generation.current) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (alive.current && ticket === generation.current) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => { generation.current++; pending.current = false; setData(null); setError(''); setBusy(false); if (visible) void load(); }, [taskId, visible]);
  async function open(file: ResultFile, folder: boolean) {
    if (pending.current || !visible || (!folder && basicMode) || data?.taskId !== taskId) return;
    const ticket = ++generation.current; pending.current = true; setBusy(true); setError('');
    try { await requestRef.current('task_open_result', { taskId, resultId: file.id, folder }); }
    catch (cause) { if (alive.current && ticket === generation.current) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (alive.current && ticket === generation.current) { pending.current = false; setBusy(false); } }
  }
  return <section className="task-results" aria-label="结果文件">
    <div className="section-actions"><strong>结果文件</strong><button type="button" disabled={busy || !visible} onClick={() => void load()}>重新核对位置</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {busy && <p className="muted" role="status">正在处理…</p>}
    {data?.files.map(file => <div className="task-result-file" key={file.id}>
      <strong>{file.label}</strong><code>{file.path}</code>
      {file.reason && <p role={file.status === 'unavailable' ? 'alert' : undefined}>{file.reason}</p>}
      <div className="section-actions"><button type="button" disabled={busy || !visible || basicMode || !file.canOpen} title={basicMode ? '基本模式只查看位置和打开目录' : !file.canOpen ? '此类型或状态仅提供目录入口' : undefined} onClick={() => void open(file, false)}>打开结果</button><button type="button" disabled={busy || !visible || !file.canOpenFolder} onClick={() => void open(file, true)}>打开所在目录</button></div>
    </div>)}
    {data && !data.files.length && <p className="muted">此任务没有已登记的结果文件。</p>}
    <p className="muted small-text">保留文件位置，不重新执行任务。文件内容仍保存在原位置。</p>
  </section>;
}
