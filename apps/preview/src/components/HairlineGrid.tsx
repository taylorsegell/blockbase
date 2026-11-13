import type { PointerEvent, ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// Adapted from cmp_local_interactive-values-grid: hairline cells, crosshair
// joints, and a spotlight that follows the pointer. Every cell draws all four
// corner marks; shared corners land on the same pixel, so any column count works.

export type HairlineTile = {
  key: string;
  meta: string;
  title: string;
  description: string;
  label: string;
  onOpen: () => void;
  /** Secondary actions, shown in the cell's corner on hover or focus. */
  tools?: ReactNode;
};

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

function Crosshair({ corner }: { corner: (typeof CORNERS)[number] }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 13 13" className="hairline-cross" data-corner={corner}>
      <path d="M6.5 1.5v10M1.5 6.5h10" />
    </svg>
  );
}

function trackPointer(event: PointerEvent<HTMLButtonElement>) {
  const target = event.currentTarget;
  const { left, top } = target.getBoundingClientRect();
  target.style.setProperty('--mx', `${event.clientX - left}px`);
  target.style.setProperty('--my', `${event.clientY - top}px`);
}

export function HairlineGrid({ tiles, className = '' }: { tiles: HairlineTile[]; className?: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <ul className={`hairline-grid ${className}`}>
      {tiles.map((tile, index) => (
        <motion.li
          key={tile.key}
          className="hairline-cell"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{
            duration: 0.5,
            delay: reduceMotion ? 0 : Math.min(index, 11) * 0.04,
            ease: [0.16, 1, 0.3, 1],
          }}
        >
          <button
            type="button"
            className="hairline-tile"
            aria-label={tile.label}
            onClick={tile.onOpen}
            onPointerMove={trackPointer}
          >
            <span className="hairline-meta tabular-nums">{tile.meta}</span>
            <span className="hairline-title">{tile.title}</span>
            <span className="hairline-description">{tile.description}</span>
          </button>
          {tile.tools ? <div className="hairline-tools">{tile.tools}</div> : null}
          {CORNERS.map((corner) => (
            <Crosshair key={corner} corner={corner} />
          ))}
        </motion.li>
      ))}
    </ul>
  );
}
