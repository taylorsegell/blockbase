export function Dynamic({ tone, styles }: { tone: string; styles: Record<string, string> }) {
  return <div className={`bg-${tone}`} style={styles}>Dynamic</div>;
}
