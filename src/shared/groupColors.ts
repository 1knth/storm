export const GROUP_COLORS = {
  blue: '#60a5fa',
  purple: '#c084fc',
  pink: '#f472b6',
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#4ade80',
} as const;

export type GroupColor = keyof typeof GROUP_COLORS;

export function groupColorForId(id: string): GroupColor {
  const colors = Object.keys(GROUP_COLORS) as GroupColor[];
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return colors[hash % colors.length];
}

export function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === 'string' && Object.hasOwn(GROUP_COLORS, value);
}
