import { useEffect, useState } from 'react';
import { Check, ClipboardCopy, Copy, X } from 'lucide-react';
import { handoffText, type HandoffTarget } from '@blockbase/contracts';
import { sendHandoffToHost } from '../lib/hostHandoff';

export type BlockHandoffTarget = HandoffTarget;

type BlockHandoffProps = {
  block: BlockHandoffTarget;
  compact?: boolean;
};

/** Plain http pages are not secure contexts, so fall back to execCommand, which must run inside the click. */
function copyWithTextarea(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  previous?.focus();
  return ok;
}

function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyWithTextarea(text),
    );
  }
  return Promise.resolve(copyWithTextarea(text));
}

function CopyButton({
  label,
  copiedLabel,
  text,
  compact,
  icon,
  hostComponentId,
}: {
  label: string;
  copiedLabel: string;
  text: string;
  compact?: boolean;
  icon: 'id' | 'prompt';
  /** When set, ask the hosting editor to copy the handoff first; fall back to the clipboard. */
  hostComponentId?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copied = status === 'copied';
  const failed = status === 'failed';

  useEffect(() => {
    if (status === 'idle') return;
    const timer = window.setTimeout(() => setStatus('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [status]);

  const shownLabel = failed ? 'Copy failed' : copied ? copiedLabel : label;

  return (
    <button
      type="button"
      onClick={() => {
        if (hostComponentId && sendHandoffToHost(hostComponentId)) {
          setStatus('copied');
          return;
        }
        void writeClipboard(text).then((ok) => setStatus(ok ? 'copied' : 'failed'));
      }}
      aria-label={shownLabel}
      title={shownLabel}
      className={
        compact
          ? 'inline-flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
          : 'inline-flex h-8 items-center gap-1.5 rounded-md border px-2 font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
      }
    >
      {failed ? <X className="size-3.5" /> : copied ? <Check className="size-3.5" /> : icon === 'id' ? <Copy className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
      {compact ? null : <span>{shownLabel}</span>}
    </button>
  );
}

export function BlockHandoff({ block, compact = false }: BlockHandoffProps) {
  const id = block.componentId;
  const prompt = handoffText(block);

  return (
    <div
      className={`flex items-center gap-1.5 ${compact ? 'block-handoff-compact' : 'min-w-0'}`}
    >
      {compact ? null : (
        <span className="hidden max-w-[14rem] truncate font-mono text-[0.6875rem] text-muted-foreground sm:inline">
          {id}
        </span>
      )}
      <CopyButton
        compact={compact}
        icon="id"
        label="Copy ID"
        copiedLabel="Copied ID"
        text={id}
      />
      <CopyButton
        compact={compact}
        icon="prompt"
        label="Copy commands"
        copiedLabel="Copied commands"
        text={prompt}
        hostComponentId={id}
      />
    </div>
  );
}
