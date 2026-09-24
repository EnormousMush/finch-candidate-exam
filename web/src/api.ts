export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? `请求失败（${res.status}）`);
  }
  return data as T;
}

export interface User { id: string; username: string }
export interface Summary { balance: number; earnedToday: number; totalEarned: number; totalSpent: number; processing: number }
export interface Task { id: string; title: string; description: string; reward: number; kind: 'once' | 'daily'; completed: boolean }
export interface Product { id: string; name: string; description: string; price: number; fulfillment: 'external' | 'internal' }
export interface Order {
  id: string; productId: string; productName: string; fulfillment: 'external' | 'internal'; price: number;
  status: 'processing' | 'delivered' | 'failed'; code: string | null; failureReason: string | null;
  attempts: number; lastError: string | null; nextAttemptAt: string | null; createdAt: string; completedAt: string | null;
}
export interface LedgerEntry {
  id: string; delta: number; balanceAfter: number; kind: string; description: string; orderId: string | null; createdAt: string;
}

export const api = {
  me: () => request<{ user: User; summary: Summary }>('GET', '/api/me'),
  login: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  register: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/register', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  tasks: () => request<{ tasks: Task[] }>('GET', '/api/tasks'),
  completeTask: (id: string) => request<{ reward: number; balance: number }>('POST', `/api/tasks/${encodeURIComponent(id)}/complete`),
  products: () => request<{ products: Product[] }>('GET', '/api/products'),
  orders: () => request<{ orders: Order[] }>('GET', '/api/orders'),
  redeem: (productId: string, idempotencyKey: string) =>
    request<{ order: Order; balance: number }>('POST', '/api/orders', { productId, idempotencyKey }),
  ledger: () => request<{ entries: LedgerEntry[] }>('GET', '/api/ledger'),
};

export function newIdempotencyKey(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
