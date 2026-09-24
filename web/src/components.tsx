import { useState } from 'react';
import type { Order } from './api';
import { STATUS_LABEL } from './format';

export function StatusPill({ status }: { status: Order['status'] }) {
  return <span className={`status ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function CodeBox({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时用户仍可手动选中 */ }
  };
  return (
    <span className="code mono">
      <span title={code}>{code}</span>
      <button type="button" onClick={copy}>{copied ? '已复制' : '复制'}</button>
    </span>
  );
}
