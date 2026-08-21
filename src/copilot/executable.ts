import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolves a command name to a concrete file path.
 *
 * Node's `spawn` without `shell: true` does not reliably apply Windows PATHEXT
 * resolution, so `spawn('copilot')` can fail with ENOENT even though `copilot`
 * runs fine in a terminal. Resolving here keeps `shell: false`, which matters:
 * with a shell we would be interpolating project-supplied strings into a command
 * line, and this process spawns things that can modify repositories.
 *
 * Returns the original command untouched if nothing matches, so the caller gets
 * a normal ENOENT naming what it looked for.
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
    : [];

  const candidates = (base: string): string[] => {
    if (!isWindows) return [base];
    // An explicit extension wins; otherwise probe each PATHEXT entry.
    if (path.extname(base).length > 0) return [base, ...extensions.map((ext) => base + ext)];
    return [...extensions.map((ext) => base + ext), base];
  };

  const isFile = (candidate: string): boolean => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  // A command containing a separator is a path, not a PATH lookup.
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
    for (const candidate of candidates(path.resolve(command))) {
      if (isFile(candidate)) return candidate;
    }
    return command;
  }

  const searchPath = env.PATH ?? env.Path ?? '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    // PATH entries are sometimes quoted on Windows.
    const cleaned = dir.replace(/^"(.*)"$/, '$1');
    for (const candidate of candidates(path.join(cleaned, command))) {
      if (isFile(candidate)) return candidate;
    }
  }

  return command;
}
