import { useEffect, useState } from 'react';

export type SkillBackupPlan = {
  id: string; required: boolean; sourceRoot: string; recoveryRoot: string; destination: string;
  method: 'copy-existing-files'; fileCount: number; totalBytes: number; summary: string;
  files: { relativePath: string; sourcePath: string; destinationPath: string; sha256: string; bytes: number }[];
};
type Preview = { id?: string; backupPlan?: SkillBackupPlan };

/** Consent is local to this exact preview object and is never part of a pane's saved draft. */
export function useBackupConsent(preview: Preview | undefined, owned: boolean) {
  const [approval, setApproval] = useState<{ preview: Preview; planId: string } | null>(null);
  const plan = preview?.backupPlan;
  const required = plan?.required === true;
  const checked = required && owned && approval !== null && approval.preview === preview && approval.planId === plan.id;
  useEffect(() => { setApproval(null); }, [preview, owned]);
  return {
    required, checked, allowed: !required || checked,
    request: checked ? { backupPlanId: plan.id } : {},
    change: (value: boolean) => setApproval(value && required && owned && preview ? { preview, planId: plan.id } : null),
    reset: () => setApproval(null),
  };
}

export function BackupPlanConsent({ plan, checked, disabled, onChange }: {
  plan?: SkillBackupPlan; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  if (!plan?.required) return null;
  return <section className="cleanup-preview" aria-label="本次更新备份计划">
    <h3>本次更新前备份</h3><p>{plan.summary}</p>
    <dl className="info-grid compact"><dt>原文件目录</dt><dd className="monospace break-text">{plan.sourceRoot}</dd><dt>本次副本位置</dt><dd className="monospace break-text">{plan.destination}</dd><dt>保存方式</dt><dd>将下列现有文件逐项复制到本次副本位置，保留相对路径；不复制整个 Skill 目录。</dd><dt>备份范围</dt><dd>{plan.fileCount} 个文件 · {plan.totalBytes.toLocaleString()} 字节</dd></dl>
    <details open><summary>备份文件与完整目标位置</summary><ul>{plan.files.map(file => <li key={file.relativePath}>
      <strong>{file.relativePath}</strong><div>原文件：<code className="break-text">{file.sourcePath}</code></div><div>备份至：<code className="break-text">{file.destinationPath}</code></div><small>{file.bytes.toLocaleString()} 字节</small><details><summary>文件校验值</summary><code className="break-text">{file.sha256}</code></details>
    </li>)}</ul></details>
    <label><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /> 允许本次备份</label>
    <p className="muted">许可只用于当前预览列明的文件、位置和复制方式。更换预览或移动窗口后需要重新选择。</p>
  </section>;
}
