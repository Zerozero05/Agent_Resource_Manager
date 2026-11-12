const MEBIBYTE = 1024 * 1024;
type Rate = { bytesPerSecond: number; error: null } | { bytesPerSecond: null; error: string };

/** The UI uses MiB/s; the existing native API keeps exact integer B/s. */
export function downloadRate(value: string): Rate {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    return { bytesPerSecond: null, error: '请输入有效的非负数；0 表示不限速。' };
  }
  const amount = Number(text), bytes = Math.round(amount * MEBIBYTE);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(bytes)) {
    return { bytesPerSecond: null, error: '限速数值过大，请调小。' };
  }
  // Decimal underflow can turn a positive input into numeric zero, too.
  if (bytes === 0 && /[1-9]/.test(text.split(/[eE]/)[0])) {
    return { bytesPerSecond: null, error: '限速过小；请提高数值，或明确填写 0 表示不限速。' };
  }
  return { bytesPerSecond: bytes, error: null };
}

export function downloadRateInput(bytes: number): string {
  // Dividing by a power of two and retaining the full number string preserves
  // every existing safe integer rate when it is submitted again.
  return Number.isSafeInteger(bytes) && bytes >= 0 ? String(bytes / MEBIBYTE) : '';
}

export function downloadRateLabel(bytes: number): string {
  const value = downloadRateInput(bytes);
  return value === '' ? '限速未核实' : bytes === 0 ? '不限速' : `${value} MiB/s`;
}
