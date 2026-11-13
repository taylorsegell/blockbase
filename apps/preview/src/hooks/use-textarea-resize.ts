import { useLayoutEffect, useRef } from 'react';

export function useTextareaResize(value: string, rows = 1) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.rows = rows;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, rows]);

  return ref;
}
