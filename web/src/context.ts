import { createContext, useContext } from 'react';
import type { Summary, User } from './api';

export interface AppContext {
  user: User;
  summary: Summary;
  refresh: () => Promise<void>;
  toast: (msg: string, bad?: boolean) => void;
}

export const Ctx = createContext<AppContext | null>(null);
export const useApp = () => useContext(Ctx)!;
