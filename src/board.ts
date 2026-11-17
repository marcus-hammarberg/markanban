// Board-level rules: column ordering, type colors and the optional .markanban.yml file.
//
// Config problems never break the board: the broken part is skipped, the default is used,
// and a warning (with valid values) is returned for the UI to show.
import { parseDocument } from 'yaml';

export const CONFIG_FILE = '.markanban.yml';
const COMMON = ['backlog', 'todo', 'ready', 'doing', 'in progress', 'review', 'done'];

// Color names, not hex: each theme defines its own shade (--type-<name>) so colors fit light/dark/etc.
export const PALETTE = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'grey'] as const;
export type Color = (typeof PALETTE)[number];

const BUILT_IN: Record<string, Color> = {
  bug: 'red', defect: 'red', incident: 'red',
  epic: 'orange',
  spike: 'yellow', research: 'yellow',
  feature: 'green', story: 'green',
  improvement: 'blue', enhancement: 'blue',
  docs: 'teal', documentation: 'teal',
  design: 'purple',
  task: 'grey', chore: 'grey',
};

export interface Config {
  columns: string[];
  noStatusColumn: string;
  types: Record<string, Color>;
  warnings: string[];
}

const normType = (t: string) => t.trim().toLowerCase();
const isColor = (c: string): c is Color => (PALETTE as readonly string[]).includes(c);

export function parseConfig(text: string): Config {
  const config: Config = { columns: [], noStatusColumn: 'No status', types: {}, warnings: [] };
  const warn = (msg: string) => config.warnings.push(`${CONFIG_FILE}: ${msg}`);

  const doc = parseDocument(text);
  if (doc.errors.length) {
    warn(`not valid YAML, using defaults (${doc.errors[0].message.split('\n')[0]})`);
    return config;
  }
  const raw = doc.toJS();
  if (raw == null) return config;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('should be a map of settings, using defaults');
    return config;
  }
  const data = raw as Record<string, unknown>;

  if (data.columns !== undefined) {
    if (Array.isArray(data.columns)) config.columns = data.columns.map(String);
    else warn('columns must be a list, e.g. columns: [todo, doing, done]');
  }

  if (data.noStatusColumn !== undefined) {
    const v = data.noStatusColumn;
    if (typeof v === 'string' && v.trim()) config.noStatusColumn = v;
    else warn('noStatusColumn must be text, e.g. noStatusColumn: Inbox');
  }

  if (data.types !== undefined) {
    const types = data.types;
    if (types === null || typeof types !== 'object' || Array.isArray(types)) {
      warn('types must be a map of type to color, e.g. types: { bug: red }');
    } else {
      for (const [type, value] of Object.entries(types)) {
        const color = String(value).trim().toLowerCase();
        if (isColor(color)) config.types[normType(type)] = color;
        else warn(`unknown color "${value}" for type "${type}". Use one of: ${PALETTE.join(', ')}`);
      }
    }
  }
  return config;
}

/** Configured color first, then the built-in list; unknown or missing type gets no color. */
export function typeColor(type: string | null, configured: Record<string, Color>): Color | null {
  if (!type) return null;
  const t = normType(type);
  return configured[t] ?? BUILT_IN[t] ?? null;
}

export function setConfigColumns(text: string, columns: string[]): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`${CONFIG_FILE} is not valid YAML`);
  const node = doc.createNode(columns);
  node.flow = true;
  doc.set('columns', node);
  return String(doc);
}

/** Configured columns first (even if empty), then known statuses in the common order, then alphabetical. */
export function orderColumns(statuses: string[], configured: string[]): string[] {
  const rank = (s: string) => {
    const i = COMMON.indexOf(s.toLowerCase());
    return i < 0 ? COMMON.length : i;
  };
  const rest = [...new Set(statuses)].filter((s) => !configured.includes(s))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...new Set(configured), ...rest];
}

// ---- Card order within a column (priority: top = most important) ----

const STEP = 1000;
const MIN_GAP = 0.001;

export interface Rankable { name: string; rank: number | null; created: string }

/** Ranked cards by number, then unranked cards oldest first. */
export function rankOrder(a: Rankable, b: Rankable): number {
  if (a.rank !== null && b.rank !== null) return a.rank - b.rank || a.name.localeCompare(b.name);
  if (a.rank !== null) return -1;
  if (b.rank !== null) return 1;
  return a.created.localeCompare(b.created) || a.name.localeCompare(b.name);
}

const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Where a card lands when placed above `before` (or at the bottom when null) in `column`
 * (sorted with rankOrder, without the card being moved). Returns the moved card's new rank,
 * plus rank updates for other cards: unranked cards above the drop point, or the whole column
 * when the gap has run out.
 */
export function placeCard(column: Rankable[], before: string | null): { rank: number; updates: { name: string; rank: number }[] } {
  const at = before === null ? column.length : column.findIndex((c) => c.name === before);
  if (at < 0) throw new Error(`No card "${before}" in that column`);
  const updates = new Map<string, number>();

  // Cards above the drop point need a rank so the moved card can sort after them.
  let above: number | null = null;
  for (const c of column.slice(0, at)) {
    const rank: number = c.rank ?? (above ?? 0) + STEP;
    if (c.rank === null) updates.set(c.name, rank);
    above = rank;
  }
  const below = column[at]?.rank ?? null; // an unranked card below is no upper bound

  let rank: number;
  if (below === null) rank = (above ?? 0) + STEP;
  else if (above === null) rank = below - STEP;
  else if (below - above >= MIN_GAP * 2) rank = tidy((above + below) / 2);
  else {
    // Gap used up: renumber this column (ranked cards and the moved one) in clean steps.
    const order: (Rankable | null)[] = [...column.slice(0, at), null, ...column.slice(at).filter((c) => c.rank !== null)];
    rank = 0;
    order.forEach((c, i) => {
      const r = (i + 1) * STEP;
      if (c === null) rank = r; // the moved card
      else if (c.rank !== r) updates.set(c.name, r);
      else updates.delete(c.name);
    });
  }
  return { rank, updates: [...updates].map(([name, r]) => ({ name, rank: r })) };
}
