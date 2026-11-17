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
