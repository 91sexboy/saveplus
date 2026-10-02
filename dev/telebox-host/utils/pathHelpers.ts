// Test double for TeleBox `@utils/pathHelpers` (same exported signatures).
import fs from "fs";
import path from "path";

function baseDir(): string {
  return process.env.SAVEPLUS_HOST_ROOT || process.cwd();
}

function createIn(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createDirectoryInAssets(name: string, _legacyNames: string[] = []): string {
  return createIn(path.join(baseDir(), "assets"), name);
}

export function createDirectoryInTemp(name: string, _legacyNames: string[] = []): string {
  return createIn(path.join(baseDir(), "temp"), name);
}
