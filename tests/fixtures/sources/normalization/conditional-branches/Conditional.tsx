export function Conditional({ active }: { active: boolean }) {
  return <button className={active ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}>Toggle</button>;
}
