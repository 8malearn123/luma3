'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { cx } from './cx';

type Toast = { id: number; tone: 'ok' | 'danger' | 'info'; text: string; action?: { label: string; onClick: () => void } };
const Ctx = createContext<{ push: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.action ? 8000 : 4500);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex max-w-md items-center gap-2 rounded-lg px-4 py-3 text-sm text-white shadow-lg', t.tone === 'danger' ? 'bg-danger' : t.tone === 'ok' ? 'bg-luma-800' : 'bg-ink')}>
            {t.tone === 'danger' ? <XCircle className="size-4" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
            <span className="flex-1">{t.text}</span>
            {t.action ? <button className="font-semibold underline" onClick={t.action.onClick}>{t.action.label}</button> : null}
            <button aria-label="close" onClick={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside provider');
  return c.push;
}
