import { useCallback, useRef } from 'react';

export function useAutoResizeTextarea({
  minHeight,
  maxHeight,
}: {
  minHeight: number;
  maxHeight?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(
    (reset?: boolean) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = `${minHeight}px`;
      if (reset) return;
      const next = textarea.scrollHeight;
      textarea.style.height = `${Math.min(next, maxHeight ?? next)}px`;
    },
    [minHeight, maxHeight],
  );

  return { textareaRef, adjustHeight };
}
