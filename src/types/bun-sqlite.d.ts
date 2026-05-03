declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string);
    run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number };
    query(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | null;
      all(...params: unknown[]): Array<Record<string, unknown>>;
    };
    close(): void;
  }
}
