import { useEffect, useRef, useState } from 'react';
import { FolderOpen, LoaderCircle } from 'lucide-react';
import './skill-relocation.css';

export type LocalRelocationPreview = {
  id: string; kind: 'localRelocation'; skillId: string; oldPath: string; path: string;
  name: string; displayName?: string; version?: string | null; duplicateId?: string | null;
  canApply: boolean; warnings: string[]; retained: string[];
};
type Action = <T>(label: string, command: string, args: Record<string, unknown>) => Promise<T>;
export type SkillRelocationDraft = { path: string; preview: LocalRelocationPreview | null };
type Props = {
  skillId: string; oldPath: string; readOnly: boolean; action: Action;
  chooseDirectory: () => Promise<string | null>; onApplied: (result: unknown) => void; onClose: () => void;
  initialDraft?: SkillRelocationDraft; onDraft: (draft: SkillRelocationDraft) => void;
};

export function SkillRelocation({ skillId, oldPath, readOnly, action, chooseDirectory, onApplied, onClose, initialDraft, onDraft }: Props) {
  const [path, setPath] = useState(initialDraft?.path || ''), [preview, setPreview] = useState<LocalRelocationPreview | null>(() => !readOnly && initialDraft?.preview?.skillId === skillId ? initialDraft.preview : null);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const alive = useRef(true), pending = useRef(false), generation = useRef(0), allowed = useRef(!readOnly);
  const source = useRef({ skillId, oldPath, readOnly });
  allowed.current = !readOnly;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (source.current.skillId !== skillId || source.current.oldPath !== oldPath || source.current.readOnly !== readOnly) {
      source.current = { skillId, oldPath, readOnly }; generation.current++; setPreview(null); setError('');
    }
  }, [skillId, oldPath, readOnly]);
  useEffect(() => { onDraft({ path, preview }); }, [path, preview, onDraft]);
  function changePath(value: string) { generation.current++; setPath(value); setPreview(null); setError(''); }
  async function run(stage: string, work: (current: () => boolean) => Promise<void>) {
    if (pending.current || !allowed.current) return;
    pending.current = true; setBusy(stage); setError(''); const token = ++generation.current;
    const current = () => alive.current && allowed.current && token === generation.current;
    try { await work(current); }
    catch (cause) { if (current()) { setError(cause instanceof Error ? cause.message : String(cause)); setPreview(null); } }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  }
  function choose() {
    return run('choose', async current => { const selected = await chooseDirectory(); if (current() && selected) changePath(selected); });
  }
  function inspect() {
    if (!path.trim()) return;
    setPreview(null);
    return run('preview', async current => {
      const result = await action<LocalRelocationPreview>('预览 Skill 本地目录重新定位', 'preview_relocate_local', { skillId, path: path.trim() });
      if (current()) setPreview(result);
    });
  }
  function apply() {
    if (!preview?.canApply) return;
    const chosen = preview;
    return run('apply', async current => {
      const result = await action('重新定位 Skill 本地目录', 'relocate_local', { previewId: chosen.id });
      if (current()) { setPreview(null); onApplied(result); }
    });
  }
  const locked = readOnly || busy === 'apply' || busy === 'choose';
  return <section className="skill-relocation" aria-label="重新定位本地目录">
    <p>选择这份 Skill 现在所在的目录，先核对对应关系，再更新管理记录。不会移动原文件或改变客户端实际入口。</p>
    <div className="skill-relocation-original"><span>原目录</span><code>{oldPath}</code></div>
    <form onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <label className="field-label">现在的 Skill 目录<input aria-label="现在的 Skill 目录" value={path} placeholder="选择或填写包含 SKILL.md 的现有目录" disabled={locked} onChange={event => changePath(event.target.value)} /></label>
      <div className="skill-relocation-actions"><button type="button" className="button secondary" disabled={readOnly || !!busy} onClick={() => void choose()}><FolderOpen size={15} />选择目录</button><button type="submit" className="button secondary" disabled={readOnly || !!busy || !path.trim()}>预览对应关系</button></div>
    </form>
    {busy && <p role="status" className="skill-relocation-status"><LoaderCircle size={15} className="spin" />{busy === 'preview' ? '正在核对目录与现有记录…' : busy === 'apply' ? '正在保存目录位置…' : '正在选择目录…'}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {preview && <section aria-label="本地目录重新定位预览" className="skill-relocation-preview">
      <dl className="info-grid compact"><dt>原目录</dt><dd><code>{preview.oldPath}</code></dd><dt>新目录</dt><dd><code>{preview.path}</code></dd><dt>Skill</dt><dd><strong>{preview.displayName || preview.name}</strong>{preview.displayName && preview.displayName !== preview.name && <span className="muted"> · {preview.name}</span>}{preview.version && <span> · {preview.version}</span>}</dd></dl>
      {preview.duplicateId && <p>将合并新目录已自动发现的重复记录，保留原 Skill 的管理信息。</p>}
      <p>保留：{preview.retained.join('、')}。</p>
      {preview.warnings.map((warning, index) => <p key={index} className="inline-warning">{warning}</p>)}
    </section>}
    <div className="skill-relocation-actions skill-relocation-footer"><button type="button" className="button secondary" disabled={!!busy} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={readOnly || !!busy || !preview?.canApply} onClick={() => void apply()}>确认重新定位</button></div>
  </section>;
}
