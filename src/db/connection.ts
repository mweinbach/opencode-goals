import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_PATH = `${homedir()}/.config/opencode/goals.db`;

let dbInstance: Database | null = null;
let dbPath = DEFAULT_DB_PATH;

export function getDb(): Database {
  if (dbInstance) return dbInstance;

  const dir = dirname(dbPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  dbInstance = new Database(dbPath);
  dbInstance.run('PRAGMA journal_mode = WAL;');
  dbInstance.run('PRAGMA foreign_keys = ON;');

  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function setDbPathForTests(path: string | null): void {
  closeDb();
  dbPath = path ?? DEFAULT_DB_PATH;
}
