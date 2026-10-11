// Extracts the beta ZIP's verified entries into `target` (test and asset
// tooling only). Every entry must be a safe, relative, regular file that
// resolves inside `target`.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { isRegularFileEntry, isSafeEntryName, readZip } from '../../scripts/beta/zip.ts';

export async function extractBetaZip(zip: Uint8Array, target: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of readZip(zip)) {
    if (!isSafeEntryName(entry.name) || !isRegularFileEntry(entry)) throw new Error(`unsafe archive entry: ${JSON.stringify(entry.name)}`);
    const path = resolve(target, ...entry.name.split('/'));
    if (!path.startsWith(target + sep)) throw new Error(`archive entry escapes the target: ${entry.name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.data);
    names.push(entry.name);
  }
  return names;
}
