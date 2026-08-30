import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function replaceFileWithBackup(
  path: string,
  temporaryPath: string,
  backupPath: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(temporaryPath, "w");
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rm(backupPath, { force: true });
  const hadPrimary = await rename(path, backupPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    if (hadPrimary) await rename(backupPath, path).catch(() => undefined);
    throw error;
  }
}
