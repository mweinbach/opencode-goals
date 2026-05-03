import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const DB_PATH = `${homedir()}/.config/opencode/goals.db`;

let dbInstance: Database | null = null;

export function getDb(): Database {
  if (dbInstance) return dbInstance;

  // Ensure directory exists
  const dir = dirname(DB_PATH);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  dbInstance = new Database(DB_PATH);
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
