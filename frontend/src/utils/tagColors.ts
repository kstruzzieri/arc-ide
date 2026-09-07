import type { ProfileTag } from '../types/runProfile';

interface TagColor {
  background: string;
  text: string;
}

const TAG_COLORS: Record<string, TagColor> = {
  dev: { background: 'rgba(56,189,248,0.08)', text: 'rgba(56,189,248,1)' },
  test: { background: 'rgba(168,85,247,0.08)', text: 'rgba(192,132,252,1)' },
  build: { background: 'rgba(245,158,11,0.08)', text: 'rgba(245,158,11,1)' },
  lint: { background: 'rgba(6,182,212,0.08)', text: 'rgba(6,182,212,1)' },
  deploy: { background: 'rgba(239,68,68,0.08)', text: 'rgba(248,113,113,1)' },
};

const DEFAULT_COLOR: TagColor = {
  background: 'rgba(255,255,255,0.04)',
  text: '#94a3b8',
};

export function getTagColor(tag: ProfileTag | string): TagColor {
  return TAG_COLORS[tag] ?? DEFAULT_COLOR;
}
