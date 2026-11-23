export const SETTINGS_SECTIONS = {
  general: { title: '常规', commandLabel: '使用偏好', keywords: '编辑器 检查方式', anchorLabel: '使用偏好' },
  display: { title: '外观', commandLabel: '显示设置', keywords: '主题 强调色 密度 动效 字号 缩放 外观', anchorLabel: '显示' },
  maintenance: { title: '维护', commandLabel: '维护设置', keywords: '暂停 自动维护 时间窗口', anchorLabel: '自动维护' },
  scenes: { title: '场景', commandLabel: '场景设置', keywords: '激活 场景 任务' },
  storage: { title: '保存位置', commandLabel: '保存位置', keywords: '路径 目录 数据 缓存 导出' },
  network: { title: '网络', commandLabel: '网络设置', keywords: '代理 诊断 连接' },
  github: { title: 'GitHub', commandLabel: 'GitHub 设置', keywords: '仓库 来源 凭据' },
  configuration: { title: '配置导入导出', commandLabel: '配置导入导出', keywords: '管理配置 导入 导出 冲突' },
  diagnostics: { title: '诊断', commandLabel: '诊断摘要', keywords: '故障 摘要 脱敏' },
} as const;

export type SettingsSectionKey = keyof typeof SETTINGS_SECTIONS;
export const SETTINGS_SECTION_KEYS = Object.keys(SETTINGS_SECTIONS) as SettingsSectionKey[];

export const SETTINGS_GROUPS = [
  { title: '应用', sections: ['general', 'display'] },
  { title: '运行与连接', sections: ['maintenance', 'scenes', 'network', 'github'] },
  { title: '数据与排查', sections: ['storage', 'configuration', 'diagnostics'] },
] as const satisfies readonly { title: string; sections: readonly SettingsSectionKey[] }[];

export function isSettingsSection(value: unknown): value is SettingsSectionKey {
  return typeof value === 'string' && Object.hasOwn(SETTINGS_SECTIONS, value);
}
