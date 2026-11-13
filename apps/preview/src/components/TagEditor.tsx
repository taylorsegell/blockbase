import { useState, type KeyboardEvent } from 'react';

function normalizeTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const tag = item.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}


const chipClass =
  'rounded-md bg-muted px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground';

export type TagEditorProps = {
  tags: string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
  onFilterTag: (tag: string) => void;
};

export function TagEditor({ tags, disabled, onChange, onFilterTag }: TagEditorProps) {
  const [draft, setDraft] = useState('');

  if (disabled) {
    if (tags.length === 0) return null;
    return (
      <div className="mt-4 flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => onFilterTag(tag)}
            className={`${chipClass} transition-colors hover:text-foreground`}
          >
            {tag}
          </button>
        ))}
      </div>
    );
  }

  const commitDraft = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    onChange(normalizeTags([...tags, value]));
    setDraft('');
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitDraft(event.currentTarget.value);
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span key={tag} className={`${chipClass} inline-flex items-center gap-1`}>
          <button
            type="button"
            onClick={() => onFilterTag(tag)}
            className="hover:text-foreground"
          >
            {tag}
          </button>
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((item) => item !== tag))}
            className="text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onInputKeyDown}
        aria-label="Add tag"
        className="h-7 w-28 rounded-md border bg-background px-2 text-[0.6875rem] outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}
