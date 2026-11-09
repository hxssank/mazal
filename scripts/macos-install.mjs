import { rename } from 'node:fs/promises';

export async function replaceMacAppArchive(prepared, archive, verify) {
  await verify(prepared);
  await rename(prepared, archive);
}

export async function installPreparedMacApp(prepared, installed, previous, verify) {
  let movedPrevious = false;
  let movedPrepared = false;
  try {
    if (previous) { await rename(installed, previous); movedPrevious = true; }
    await rename(prepared, installed);
    movedPrepared = true;
    await verify(installed);
  } catch (error) {
    if (movedPrepared) await rename(installed, prepared);
    if (movedPrevious) await rename(previous, installed);
    throw error;
  }
}
