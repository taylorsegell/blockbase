import { useEffect, useState, type RefObject } from 'react';

export const ControlType = {
  String: 'string',
  Color: 'color',
  Boolean: 'boolean',
  Number: 'number',
  Enum: 'enum',
  File: 'file',
} as const;

export function addPropertyControls(
  _component: unknown,
  _controls: unknown,
): void {}

export function useIsStaticRenderer() {
  return false;
}

function nearestScrollRoot(node: Element): Element | null {
  let parent = node.parentElement;
  while (parent) {
    const { overflow, overflowY } = getComputedStyle(parent);
    if (/(auto|scroll|overlay)/.test(`${overflow}${overflowY}`)) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

export function useInView(
  ref: RefObject<Element | null>,
  options?: { amount?: number; once?: boolean },
) {
  const [inView, setInView] = useState(false);
  const amount = options?.amount ?? 0;
  const once = options?.once ?? false;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { root: nearestScrollRoot(node), threshold: amount },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, amount, once]);

  return inView;
}
