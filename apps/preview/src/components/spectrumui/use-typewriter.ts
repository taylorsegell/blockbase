'use client';

import * as React from 'react';

export type TypewriterPhase =
  | 'idle'
  | 'typing'
  | 'holding'
  | 'deleting'
  | 'waiting';

export interface UseTypewriterOptions {
  /** ms per typed character. */
  typeMs?: number;
  /** ms per deleted character. */
  deleteMs?: number;
  /** ms the finished phrase stays on screen. */
  holdMs?: number;
  /** ms of empty pause between phrases. */
  gapMs?: number;
  /** ms before the first phrase starts. */
  startDelayMs?: number;
  /** Pause the animation (e.g. while offscreen). */
  enabled?: boolean;
  /** Humanize typing speed with a little randomness. */
  jitter?: boolean;
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Cycles through `phrases`, typing each in, holding it, then deleting it.
 * Respects prefers-reduced-motion (shows the first phrase statically).
 */
export function useTypewriter(
  phrases: string[],
  {
    typeMs = 70,
    deleteMs = 28,
    holdMs = 1800,
    gapMs = 450,
    startDelayMs = 400,
    enabled = true,
    jitter = true,
  }: UseTypewriterOptions = {},
) {
  const [text, setText] = React.useState('');
  const [phase, setPhase] = React.useState<TypewriterPhase>('idle');
  const reduced = usePrefersReducedMotion();
  const phrasesKey = phrases.join('\0');
  const phrasesRef = React.useRef(phrases);
  phrasesRef.current = phrases;

  React.useEffect(() => {
    const list = phrasesRef.current;
    if (!enabled || list.length === 0) return;
    if (reduced) {
      setText(list[0]);
      setPhase('idle');
      return;
    }

    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const tick = (base: number) =>
      jitter ? base * (0.6 + Math.random() * 0.8) : base;

    (async () => {
      await sleep(startDelayMs);
      let index = 0;
      while (!cancelled) {
        const phrase = list[index % list.length];
        setPhase('typing');
        for (let i = 1; i <= phrase.length; i++) {
          if (cancelled) return;
          setText(phrase.slice(0, i));
          await sleep(tick(typeMs));
        }
        setPhase('holding');
        await sleep(holdMs);
        if (cancelled) return;
        setPhase('deleting');
        for (let i = phrase.length - 1; i >= 0; i--) {
          if (cancelled) return;
          setText(phrase.slice(0, i));
          await sleep(deleteMs);
        }
        setPhase('waiting');
        await sleep(gapMs);
        index++;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    reduced,
    phrasesKey,
    typeMs,
    deleteMs,
    holdMs,
    gapMs,
    startDelayMs,
    jitter,
  ]);

  return { text, phase };
}
