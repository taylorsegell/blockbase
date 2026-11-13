import { clsx } from 'clsx';
export function Card({ active = false }: { active?: boolean }) {
  return <article className={clsx('rounded-md', active && 'bg-surface')} />;
}
