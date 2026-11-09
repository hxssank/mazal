import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function masterWorkbookPath(homeDirectory = homedir(), override = process.env.MAZAL_MASTER_WORKBOOK): string {
  if (override) return resolve(override);
  const current = join(homeDirectory, 'Desktop', 'Mazal', 'Finance', 'Workbook', 'Mazal master.xlsx');
  const previous = join(homeDirectory, 'Documents', 'Mazal', 'Mazal master.xlsx');
  return existsSync(current) || !existsSync(previous) ? current : previous;
}
