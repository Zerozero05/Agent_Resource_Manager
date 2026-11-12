import './removal-history.css';

type FileResult = { deleted?: string[]; retained?: string[]; failures?: [string, string][] };
type EntryResult = { id: string; path?: string; status: string; reason?: string };
export type RemovalHistoryRecord = {
  status: string; error?: string | null;
  result?: FileResult; fileResult?: FileResult;
  entries?: { path: string; remove?: boolean }[];
  fileEntries?: { path: string; remove?: boolean }[];
  systemEntryIds?: string[];
  systemResults?: EntryResult[]; metadataResults?: EntryResult[];
  connectionResults?: { id: string; success: boolean; error?: string | null }[];
};

const labels: Record<string, string> = { removed: '已移除', restored: '已恢复原值', alreadyAbsent: '已不存在', deleted: '已删除', retained: '已保留', failed: '未完成', notAttempted: '未处理' };

export function RemovalHistory({ record }: { record?: RemovalHistoryRecord | null }) {
  if (!record) return null;
  const files = record.fileResult || record.result || {};
  const results = [
    ...(files.deleted || []).map(path => ({ path, status: '已删除', reason: '' })),
    ...(files.retained || []).map(path => ({ path, status: '未删除', reason: '' })),
    ...(files.failures || []).map(([path, reason]) => ({ path, status: '未完成', reason })),
    ...[...(record.systemResults || []), ...(record.metadataResults || [])].map(entry => ({ path: entry.path || entry.id, status: labels[entry.status] || entry.status, reason: entry.reason || '' })),
    ...(record.connectionResults || []).map(entry => ({ path: entry.id, status: entry.success ? '连接已解除' : '连接未解除', reason: entry.error || '' })),
  ];
  if (record.status === 'processing') {
    const recorded = new Set(results.map(entry => entry.path));
    const pending = [...(record.fileEntries || record.entries || []).filter(entry => entry.remove).map(entry => entry.path), ...(record.systemEntryIds || [])];
    for (const path of new Set(pending)) {
      if (!recorded.has(path)) results.push({ path, status: '结果待核对', reason: '' });
    }
  }
  const title = record.status === 'processing' ? '上次卸载记录未完成' : record.status === 'partial' ? '上次卸载部分完成' : '上次卸载记录';
  return <details className="removal-history" aria-label="已保存的卸载记录">
    <summary>{title}</summary>
    <p>已保存的处理结果如下。再次处理请重新选择程度，并预览当前剩余内容。</p>
    {record.error && <p className="inline-error">{record.error}</p>}
    {results.length > 0 ? <ul>{results.map((entry, index) => <li key={`${entry.path}-${index}`}><strong>{entry.status}</strong><span>{entry.path}</span>{entry.reason && <small>{entry.reason}</small>}</li>)}</ul> : <p>尚无完整的逐项结果，请重新预览核对。</p>}
  </details>;
}
