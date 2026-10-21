'use client';

import { useState } from 'react';

/**
 * Cursor stack for keyset/offset pagination. Changing `filterKey` (any filter
 * or search) starts again from the first page without an effect.
 */
export function useCursorStack(filterKey: string) {
  const [s, setS] = useState<{ key: string; stack: string[] }>({ key: filterKey, stack: [] });
  const stack = s.key === filterKey ? s.stack : [];
  return {
    cursor: stack.at(-1),
    hasPrev: stack.length > 0,
    next: (c: string) => setS({ key: filterKey, stack: [...stack, c] }),
    prev: () => setS({ key: filterKey, stack: stack.slice(0, -1) }),
  };
}
