import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri, invoke } from '@tauri-apps/api/core';

export type TaskOrigin = { view?: string; skillId?: string; tab?: string; clientId?: string; sourceId?: string; resourceId?: string; paneId?: string; windowLabel?: string };
export type ManagerTask = { id: string; action: string; label: string; status: string; stage: string; createdAt: string; startedAt?: string; finishedAt?: string; origin: TaskOrigin; progress?: { completed: number; total: number }; cancellable: boolean; cancelRequested?: boolean; error?: string; resultAvailable?: boolean; resultExpired?: boolean; resultFiles?: { id: string; label: string; path: string }[]; resources?: string[]; hidden?: boolean; result?: unknown };
export const terminalTask = (task: ManagerTask) => !['queued', 'running'].includes(task.status);
export const taskStatus: Record<string, string> = { queued: '排队中', running: '进行中', succeeded: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断 · 需核实' };
const api = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>('manager_request', { request: { action, ...args } });
function taskForList(task: ManagerTask): ManagerTask {
  // Scheduling keys remain available in the original API response and backend.
  const { resources: _resources, ...metadata } = task;
  // Checks return the complete application snapshot to their caller. History
  // keeps the readable task identity, rather than up to 100 old snapshots.
  // Explicit inspection and run still return the unmodified API response.
  if (metadata.action !== 'check_now' || metadata.result === undefined) return metadata;
  const { result: _result, ...listed } = metadata;
  return { ...listed, resultAvailable: metadata.resultAvailable ?? !metadata.resultExpired };
}

export function useTasks() {
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const mounted = useRef(true);
  const waiters = useRef(new Set<(task: ManagerTask) => void>());
  const clearedIds = useRef(new Set<string>());
  const accept = useCallback((task: ManagerTask) => { for (const waiter of waiters.current) waiter(task); if (mounted.current) setTasks(previous => {
    if (task.hidden || clearedIds.current.has(task.id)) return previous.filter(item => item.id !== task.id);
    const existing = previous.find(item => item.id === task.id);
    if (existing && terminalTask(existing) && !terminalTask(task)) return previous;
    const listed = taskForList(task);
    const current = listed.action !== 'check_now' && listed.result === undefined && !listed.resultExpired && listed.resultAvailable !== false && existing?.result !== undefined ? { ...listed, result: existing.result } : listed;
    // Events and polling can report the same state. Keep consumer identities stable
    // without serializing potentially large results or hiding actual progress changes.
    if (existing && existing.result === current.result && JSON.stringify({ ...existing, result: undefined }) === JSON.stringify({ ...current, result: undefined })) return previous;
    return [current, ...previous.filter(item => item.id !== task.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((item, index, all) => !terminalTask(item) || all.slice(0, index).filter(terminalTask).length < 100);
  }); }, []);
  const acceptClear = useCallback((value: { tasks?: ManagerTask[]; clearedTaskIds: string[] }) => {
    for (const id of value.clearedTaskIds) clearedIds.current.add(id);
    while (clearedIds.current.size > 2000) clearedIds.current.delete(clearedIds.current.values().next().value!);
    const current = (value.tasks || []).map(taskForList);
    if (mounted.current) setTasks(previous => [...current, ...previous.filter(task => !clearedIds.current.has(task.id) && !current.some(item => item.id === task.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let stopClear: (() => void) | undefined;
    void api<{ tasks: ManagerTask[] }>('list_tasks').then(value => { if (!disposed) setTasks(previous => [...previous, ...value.tasks.filter(task => !task.hidden && !clearedIds.current.has(task.id) && !previous.some(item => item.id === task.id)).map(taskForList)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }).catch(() => undefined);
    void listen<{ task: ManagerTask }>('task-updated', event => { if (!disposed) accept(event.payload.task); }).then(unlisten => { if (!disposed) stop = unlisten; else unlisten(); }).catch(() => undefined);
    void listen<{ tasks: ManagerTask[]; clearedTaskIds: string[] }>('task-history-cleared', event => { if (!disposed) acceptClear(event.payload); }).then(unlisten => { if (!disposed) stopClear = unlisten; else unlisten(); }).catch(() => undefined);
    return () => { disposed = true; mounted.current = false; stop?.(); stopClear?.(); };
  }, [accept, acceptClear]);
  const run = useCallback(async <T,>(label: string, action: string, args: Record<string, unknown>, origin: TaskOrigin, foreground = true, onStarted?: (task: ManagerTask) => void): Promise<T> => {
    let task: ManagerTask | undefined;
    // Events can precede the start acknowledgement. Keep only the latest record
    // per ID until that acknowledgement identifies this run, then release them.
    const early = new Map<string, ManagerTask>();
    let version = 0, wake: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const merge = (previous: ManagerTask, next: ManagerTask): ManagerTask => {
      const merged = terminalTask(previous) && !terminalTask(next) || previous.status === 'running' && next.status === 'queued'
        ? { ...next, ...previous } : { ...previous, ...next };
      if (merged.resultExpired || merged.resultAvailable === false) delete merged.result;
      return merged;
    };
    const receive = (next: ManagerTask) => {
      if (!task) { const previous = early.get(next.id); early.set(next.id, previous ? merge(previous, next) : next); return; }
      if (next.id !== task.id) return;
      task = merge(task, next); version++; wake?.();
    };
    waiters.current.add(receive);
    try {
      const started = await api<{ task: ManagerTask }>('start_task', { request: { action, ...args }, label, origin, foreground });
      task = started.task;
      const pending = early.get(task.id); early.clear();
      if (pending) task = merge(task, pending);
      accept(task); onStarted?.(started.task);
      const read = async () => {
        const before = version;
        const next = (await api<{ task: ManagerTask }>('get_task', { taskId: task!.id })).task;
        // A later event wins over a read that began earlier; a terminal response
        // still wins over an older non-terminal event. Full response fields stay.
        task = before === version ? merge(task!, next) : merge(next, task!);
        accept(task);
      };
      if (!terminalTask(task)) await read();
      while (!terminalTask(task!)) {
        const notified = await new Promise<boolean>(resolve => {
          const finish = (event: boolean) => { if (timer !== undefined) clearTimeout(timer); timer = undefined; wake = undefined; resolve(event); };
          wake = () => finish(true); timer = setTimeout(() => finish(false), 700);
        });
        if (!notified) await read();
      }
      if (!['cancelled', 'failed', 'interrupted'].includes(task!.status) && task!.result === undefined) await read();
      if (task!.status === 'cancelled') throw new Error('任务已取消');
      if (task!.status === 'failed' || task!.status === 'interrupted') throw new Error(task!.error || task!.stage || '任务未完成');
      return task!.result as T;
    } finally {
      waiters.current.delete(receive); early.clear();
      if (timer !== undefined) clearTimeout(timer);
      wake = undefined;
    }
  }, [accept]);
  const inspect = useCallback(async (id: string) => { const task = (await api<{ task: ManagerTask }>('get_task', { taskId: id })).task; accept(task); return task; }, [accept]);
  const cancel = useCallback(async (id: string) => { accept((await api<{ task: ManagerTask }>('cancel_task', { taskId: id })).task); }, [accept]);
  const clear = useCallback(async () => {
    const value = await api<{ tasks: ManagerTask[]; clearedTaskIds: string[] }>('clear_task_history');
    acceptClear(value);
  }, [acceptClear]);
  return { tasks, run, inspect, cancel, clear };
}
