import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './themes.css';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { prepareStartup, type StartupStatus } from './startup';
import './visual.css';
import './contrast.css';
import './layout-v024.css';
import './layout-v026.css';
import './appearance.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
async function start() {
  try {
    // Prepare code and session mode together; no workspace effects run before both are ready.
    const [startup, { default: WorkspaceApp }] = await Promise.all([
      prepareStartup(document.documentElement, () => isTauri()
        ? invoke<StartupStatus>('manager_request', { request: { action: 'get_startup_status' } })
        : Promise.resolve({ basicMode: false })),
      import('./WorkspaceApp'),
    ]);
    root.render(<React.StrictMode><WorkspaceApp startup={startup} /></React.StrictMode>);
  } catch (error) {
    root.render(<main style={{ padding: '2rem' }} role="alert"><h1>工作台未能启动</h1><p>{error instanceof Error ? error.message : String(error)}</p><p>未启动自动维护或工具。请核对数据位置后重新打开。</p></main>);
  }
}
void start();
