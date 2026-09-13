import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

/** Write a UTF-8 file through a same-directory temporary file and rename. */
export async function writeTextAtomic(
  path: string,
  content: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Persist JSON with stable formatting and atomic replacement. */
export async function writeJsonAtomic(
  path: string,
  value: unknown
): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Publish a complete file exactly once. The temporary file is written in the
 * destination directory, then hard-linked into place; link() is atomic and
 * fails with EEXIST without replacing an existing immutable artifact.
 */
export async function writeTextImmutable(
  path: string,
  content: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Persist an immutable JSON artifact without clobbering an existing file. */
export async function writeJsonImmutable(
  path: string,
  value: unknown
): Promise<void> {
  await writeTextImmutable(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
