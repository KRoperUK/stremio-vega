// Spatial (D-pad) focus navigation for a TV remote.
//
// A Fire TV / Vega remote sends arrow key events (ArrowUp/Down/Left/Right, and
// on some stacks the named keys "Up"/"Down"/"Left"/"Right"), plus Enter/Select
// to activate. A plain web app has no concept of "the button to the left", so
// we implement geometric nearest-neighbour focus movement:
//
//   - every <button>, <input>, <a>, and anything with [data-focusable] is a
//     candidate;
//   - on an arrow key we pick the visible candidate whose centre is nearest in
//     the pressed direction (primary axis distance dominates, with a small
//     penalty for cross-axis drift) and focus it;
//   - Enter on a focused non-input just clicks it (native button behaviour
//     already covers this, so we only synthesise a click for non-buttons).
//
// This runs at the document level and needs no per-component wiring beyond the
// native focusable elements the app already renders.
import {useEffect} from 'react';

type Dir = 'up' | 'down' | 'left' | 'right';

const KEY_TO_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
};

const FOCUSABLE =
  'button, input, a[href], [data-focusable], [tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function candidates(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && isVisible(el),
  );
}

function center(el: HTMLElement): {x: number; y: number} {
  const r = el.getBoundingClientRect();
  return {x: r.left + r.width / 2, y: r.top + r.height / 2};
}

// Nearest candidate strictly in the given direction from `from`.
function nearest(from: HTMLElement, dir: Dir): HTMLElement | null {
  const a = center(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates()) {
    if (el === from) continue;
    const b = center(el);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // Must be in the pressed direction (with a small dead-zone tolerance).
    const inDir =
      (dir === 'up' && dy < -1) ||
      (dir === 'down' && dy > 1) ||
      (dir === 'left' && dx < -1) ||
      (dir === 'right' && dx > 1);
    if (!inDir) continue;
    const primary = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
    const cross = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    // Primary-axis distance dominates; cross-axis drift is penalised so focus
    // stays roughly in line rather than jumping diagonally across the screen.
    const score = primary + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function useSpatialNav(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key];
      const active = document.activeElement as HTMLElement | null;
      const typingInText =
        active &&
        active.tagName === 'INPUT' &&
        (active as HTMLInputElement).type !== 'checkbox' &&
        (active as HTMLInputElement).type !== 'radio';

      if (dir) {
        // Let left/right move the text caret inside a text field.
        if (typingInText && (dir === 'left' || dir === 'right')) return;
        e.preventDefault();
        const current = active && active !== document.body ? active : candidates()[0];
        if (!current) return;
        const target = nearest(current, dir);
        if (target) target.focus();
        else if (!active || active === document.body) current.focus();
        return;
      }

      if ((e.key === 'Enter' || e.key === 'Select') && active) {
        // Native buttons/inputs already act on Enter; only synthesise a click
        // for a focusable that is not one of those.
        const tag = active.tagName;
        if (tag !== 'BUTTON' && tag !== 'INPUT' && tag !== 'A') {
          e.preventDefault();
          active.click();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
}

// Focus the first focusable element inside `root` (default: document). Used
// when a view mounts so the remote always has a starting point.
export function focusFirst(root: ParentNode = document): void {
  const el = root.querySelector<HTMLElement>(FOCUSABLE);
  if (el && !el.hasAttribute('disabled')) el.focus();
}
