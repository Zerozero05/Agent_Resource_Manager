import { Check } from 'lucide-react';
import { ACCENTS, type Appearance, type UiDensity, type UiMotion } from './appearance';
import { useId, type CSSProperties } from 'react';

export function AppearanceControls({ value, onChange }: { value: Appearance; onChange: (patch: Partial<Appearance>) => void }) {
  const accentId = useId(), accentHelpId = useId();
  return <div className="display-controls appearance-controls setting-rows">
    <div className="setting-row setting-row-wide appearance-accent-row">
      <span className="setting-copy"><strong id={accentId}>强调色</strong><small id={accentHelpId}>强调色用于选中项和常用动作；成功、警告及错误保留各自含义。</small></span>
      <div className="accent-options" role="group" aria-labelledby={accentId} aria-describedby={accentHelpId}>
        {ACCENTS.map(accent => <button type="button" key={accent.id} className={`accent-option ${value.uiAccent === accent.id ? 'selected' : ''}`} aria-pressed={value.uiAccent === accent.id} onClick={() => onChange({ uiAccent: accent.id })}>
          <span className="accent-dot" style={{ '--swatch': accent.swatch } as CSSProperties} aria-hidden="true" /><span>{accent.label}</span>{value.uiAccent === accent.id && <Check size={16} aria-hidden="true" />}
        </button>)}
      </div>
    </div>
    <label className="setting-row"><span className="setting-copy"><strong>界面密度</strong><small>调整列表、卡片与控件的留白，保留当前字号和缩放。</small></span><select value={value.uiDensity} onChange={event => onChange({ uiDensity: event.target.value as UiDensity })} aria-label="界面密度"><option value="compact">紧凑（默认）</option><option value="comfortable">舒适</option></select></label>
    <label className="setting-row"><span className="setting-copy"><strong>动效</strong><small>仅使用短时反馈；后台窗口和基本模式停止动效，不影响任务进度。</small></span><select value={value.uiMotion} onChange={event => onChange({ uiMotion: event.target.value as UiMotion })} aria-label="动效"><option value="system">跟随系统（默认）</option><option value="light">轻动效</option><option value="none">关闭动效</option></select></label>
  </div>;
}
