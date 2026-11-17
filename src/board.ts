// Board-level rules: column ordering and the optional .markanban.yml file.
import { parseDocument } from 'yaml';

export const CONFIG_FILE = '.markanban.yml';
const COMMON = ['backlog', 'todo', 'ready', 'doing', 'in progress', 'review', 'done'];

export interface Config { columns: string[]; noStatusColumn: string }

export function parseConfig(text: string): Config {
  const doc = parseDocument(text);
  const data = doc.errors.length ? null : (doc.toJS() as Record<string, unknown> | null);
  const cols = data?.columns;
  const noStatus = data?.noStatusColumn;
  return {
    columns: Array.isArray(cols) ? cols.map(String) : [],
    noStatusColumn: typeof noStatus === 'string' && noStatus.trim() ? noStatus : 'No status',
  };
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
