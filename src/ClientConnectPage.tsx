import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { CLIENT_OPTIONS, clientConnectChoices, clientConnectDraft, clientConnectionResultStatus, clientConnectionResultText, clientSelectionRange, clientSelectionShortcut, clientSkillName, completedClientBatchDraft, selectFilteredClientItems, type ClientBatchCompletion, type ClientConnection, type ClientConnectDraft, type ClientSkill, type ConnectionResult } from './client-selection';
import './clients.css';

export type ClientConnectPageProps = {
  skills: ClientSkill[]; connections: ClientConnection[]; client: string;
  availabilityReady: boolean;
  initialDraft?: ClientConnectDraft; onDraftChange: (draft: ClientConnectDraft) => void;
  onConnect: (client: string, skillIds: string[]) => Promise<ConnectionResult[]>;
  resumedBatch?: ClientBatchCompletion;
  pendingBatch?: boolean;
  onClose?: () => void;
};
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || target.matches('input:not([type="checkbox"]),textarea,select'));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A normal operation page: the enclosing PaneFrame owns scrolling and transfer. */
export function ClientConnectPage({ skills, connections, client, availabilityReady, initialDraft, onDraftChange, onConnect, resumedBatch, pendingBatch = false, onClose }: ClientConnectPageProps) {
  const [draft, setDraft] = useState(() => {
    const restored = clientConnectDraft(initialDraft);
    return !restored.resultSelectionApplied && restored.batchClient && restored.results
      ? completedClientBatchDraft(restored, client, { client: restored.batchClient, results: restored.results }) || restored
      : restored;
  });
  const [connecting, setConnecting] = useState(false), [error, setError] = useState('');
  const pointerShift = useRef(false), alive = useRef(true), batchId = useRef(0), draftRef = useRef(draft); draftRef.current = draft;
  const latestDraftChange = useRef(onDraftChange); latestDraftChange.current = onDraftChange;
  const firstClient = useRef(client);
  useEffect(() => {
    alive.current = true;
    if (draftRef.current.resultSelectionApplied && !initialDraft?.resultSelectionApplied) latestDraftChange.current(draftRef.current);
    return () => { alive.current = false; batchId.current += 1; };
  }, []);
  useEffect(() => { if (firstClient.current !== client) { firstClient.current = client; batchId.current += 1; setConnecting(false); setError(''); const clean = clientConnectDraft(undefined); draftRef.current = clean; setDraft(clean); latestDraftChange.current(clean); } }, [client]);
  useEffect(() => {
    if (!resumedBatch) return;
    const next = completedClientBatchDraft(draftRef.current, client, resumedBatch); if (!next) return;
    batchId.current += 1; setConnecting(false); setError('');
    draftRef.current = next; setDraft(next); latestDraftChange.current(next);
  }, [resumedBatch?.taskId, client]);
  const available = useMemo(() => clientConnectChoices(skills, connections, client), [skills, connections, client]);
  const choices = useMemo(() => clientConnectChoices(skills, connections, client, draft.query), [skills, connections, client, draft.query]);
  const availableById = new Map(available.map(skill => [skill.id, skill]));
  const filteredIds = choices.map(skill => skill.id), selectedIds = draft.selectedIds.filter(id => availableById.has(id));
  const availability = [...availableById.keys()].join('\u0000');
  useEffect(() => {
    if (!availabilityReady) return;
    const next = draftRef.current.selectedIds.filter(id => availableById.has(id));
    if (next.length !== draftRef.current.selectedIds.length) { const value = { ...draftRef.current, selectedIds: next }; draftRef.current = value; setDraft(value); latestDraftChange.current(value); }
  }, [availability, availabilityReady]);
  const hidden = selectedIds.filter(id => !filteredIds.includes(id)).length, clientName = CLIENT_OPTIONS.find(item => item.id === client)?.name || client;
  const alreadyConnected = skills.filter(skill => skill.localPath && !skill.readOnly).length - available.length;
  const busy = connecting || pendingBatch;
  const results = draft.batchClient === client ? draft.results || [] : [];
  const retryIds = results.filter(item => clientConnectionResultStatus(item) === 'failed' && availableById.has(item.id)).map(item => item.id);
  const sharedError = results.length > 1 && results[0].error && results.every(item => item.error === results[0].error) ? results[0].error : undefined;
  const displayedError = error || sharedError;
  const update = (next: ClientConnectDraft) => { draftRef.current = next; setDraft(next); latestDraftChange.current(next); };
  const choose = (id: string, checked: boolean, shift = false) => update({ ...draftRef.current, selectedIds: clientSelectionRange(draftRef.current.selectedIds, filteredIds, draftRef.current.anchorId, id, checked, shift), anchorId: id });
  const selectAll = () => update({ ...draftRef.current, selectedIds: selectFilteredClientItems(draftRef.current.selectedIds, filteredIds) });
  const listKeys = (event: KeyboardEvent) => { if (!busy && clientSelectionShortcut(event, editable(event.target)) === 'all') { event.preventDefault(); selectAll(); } };
  const connect = async (requested: string[]) => {
    if (busy) return; const ids = [...new Set(requested)].filter(id => availableById.has(id)); if (!ids.length) return;
    const generation = ++batchId.current, targetClient = client;
    const submitted = ids.map(id => ({ id, label: clientSkillName(availableById.get(id)) }));
    setConnecting(true); setError('');
    update({ ...draftRef.current, results: submitted, batchClient: targetClient, resultSelectionApplied: undefined });
    const recordResults = (results: ConnectionResult[]) => {
      const returned = new Map(results.map(result => [result.id, result]));
      const outcomes = submitted.map(item => returned.get(item.id) || item);
      const next = completedClientBatchDraft(draftRef.current, client, { client: targetClient, results: outcomes });
      if (next) update(next);
    };
    try {
      const next = await onConnect(targetClient, ids);
      if (!alive.current || generation !== batchId.current) return;
      recordResults(next);
    } catch (cause) {
      if (alive.current && generation === batchId.current) {
        setError(errorText(cause));
        recordResults([]);
      }
    }
    finally { if (alive.current && generation === batchId.current) setConnecting(false); }
  };
  return <section className="client-connect-page" aria-label="连接 Skill">
    <header><h2>连接到 {clientName}</h2><p>选择本地 Skill，使用原目录建立轻量入口。{alreadyConnected > 0 && `已排除 ${alreadyConnected} 项有效同源连接。`}</p></header>
    <label className="client-connect-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索可连接 Skill" placeholder="名称或原目录" value={draft.query} onChange={event => update({ ...draftRef.current, query: event.target.value })} /></label>
    <div className="client-selection-tools"><button type="button" className="text-button" disabled={busy || !choices.length} onClick={selectAll}>选择当前筛选全部（{choices.length}）</button><button type="button" className="text-button" disabled={busy || !draft.selectedIds.length} onClick={() => update({ ...draftRef.current, selectedIds: [], anchorId: undefined })}>清空选择</button><span role="status">已选 {selectedIds.length} 项{hidden > 0 && ` · 筛选外 ${hidden} 项`}</span></div>
    <div className="client-choices client-selectable-list" role="group" aria-label="可连接 Skill 列表" tabIndex={0} onKeyDown={listKeys}>{choices.map(skill => {
      const selected = selectedIds.includes(skill.id);
      return <label key={skill.id} className={selected ? 'is-selected' : ''} tabIndex={0} onKeyDown={event => { if (!busy && event.target === event.currentTarget && event.key === ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); choose(skill.id, !selected, event.shiftKey); } }}><input type="checkbox" aria-label={`选择 ${clientSkillName(skill)}`} checked={selected} disabled={busy} onClick={event => { pointerShift.current = event.shiftKey; }} onChange={event => { choose(skill.id, event.target.checked, pointerShift.current); pointerShift.current = false; }} /><span><strong>{clientSkillName(skill)}</strong><code title={skill.localPath || undefined}>{skill.localPath}</code></span></label>;
    })}{!choices.length && <p className="client-connect-empty">{!availabilityReady ? '正在读取可连接的 Skill…' : available.length ? '没有匹配的可连接 Skill；已选项目仍保留。' : '当前可用 Skill 已连接，或尚无可连接的本地 Skill。'}</p>}</div>
    {displayedError && <p className="inline-error" role="alert">{displayedError}</p>}
    {!busy && results.length > 0 && <section className="client-batch-results" role="status">
      <h3>本批结果 · 成功 {results.filter(item => clientConnectionResultStatus(item) === 'succeeded').length}／共 {results.length} 项</h3>
      {results.map(result => <p key={result.id} className={clientConnectionResultStatus(result) === 'failed' ? 'error-text' : undefined}>{result.label}：{result.error && result.error === displayedError ? '未连接' : clientConnectionResultText(result, 'connect')}</p>)}
      {retryIds.length > 0 && <button type="button" className="button" onClick={() => void connect(retryIds)}>仅重试失败项</button>}
    </section>}
    <footer className="client-connect-footer"><p>{busy ? '正在逐项连接；切换标签后任务会继续，结果保留在操作记录。' : 'Shift 可连续选择；列表获得焦点后可用 Ctrl＋A 全选当前筛选、空格切换当前项。'}</p><div>{onClose && <button type="button" className="button" onClick={onClose}>关闭页面</button>}<button type="button" className="button primary" disabled={busy || !selectedIds.length} onClick={() => void connect(selectedIds)}>{busy ? '正在逐项连接…' : `连接所选（${selectedIds.length}）`}</button></div></footer>
  </section>;
}
