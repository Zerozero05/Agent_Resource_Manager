export type StartupStatus = { basicMode: boolean; readOnly?: boolean; dataDir?: string; resourceCatalogAvailable?: boolean; warnings?: string[] };

// Resolve the backend's session mode before any workspace effect or animation runs.
export async function prepareStartup(root: HTMLElement, read: () => Promise<StartupStatus>): Promise<StartupStatus> {
  const status = await read();
  if (!status || typeof status.basicMode !== 'boolean') throw new Error('无法确定启动模式；工作台尚未初始化。');
  root.dataset.basicMode = String(status.basicMode);
  if (status.basicMode) root.dataset.motion = 'none';
  return status;
}
