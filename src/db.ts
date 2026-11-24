import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      sku TEXT NOT NULL REFERENCES products(sku),
      qty INTEGER NOT NULL CHECK (qty > 0),
      unit_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      wa_id TEXT PRIMARY KEY,
      human_handoff INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      wa_message_id TEXT PRIMARY KEY,
      wa_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

/** Catalogo de ejemplo (datos ficticios de una tienda de bebidas). */
export function seed(db: Db): void {
  const ins = db.prepare('INSERT OR IGNORE INTO products (sku, name, price_cents, stock) VALUES (?, ?, ?, ?)');
  ins.run('TE-CHAI', 'Te chai', 850, 40);
  ins.run('CAFE-LATTE', 'Cafe latte', 1000, 40);
  ins.run('BROWNIE', 'Brownie', 700, 25);
  ins.run('JUGO-NARANJA', 'Jugo de naranja', 900, 30);
}

export const money = (cents: number): string => `S/ ${(cents / 100).toFixed(2)}`;

/** Registra un mensaje; devuelve false si ya existia (Meta reintenta webhooks). */
export function recordMessage(db: Db, id: string, waId: string, direction: 'in' | 'out', body: string): boolean {
  try {
    db.prepare('INSERT INTO messages (wa_message_id, wa_id, direction, body) VALUES (?, ?, ?, ?)').run(id, waId, direction, body);
    return true;
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) return false;
    throw e;
  }
}

export function recentMessages(db: Db, waId: string, limit = 6): { direction: string; body: string }[] {
  const rows = db
    .prepare('SELECT direction, body FROM messages WHERE wa_id = ? ORDER BY rowid DESC LIMIT ?')
    .all(waId, limit) as { direction: string; body: string }[];
  return rows.reverse();
}

export function isHandedOff(db: Db, waId: string): boolean {
  const r = db.prepare('SELECT human_handoff AS h FROM conversations WHERE wa_id = ?').get(waId) as { h: number } | undefined;
  return !!r && r.h === 1;
}

export function setHandoff(db: Db, waId: string): void {
  db.prepare(
    `INSERT INTO conversations (wa_id, human_handoff) VALUES (?, 1)
     ON CONFLICT(wa_id) DO UPDATE SET human_handoff = 1, updated_at = CURRENT_TIMESTAMP`,
  ).run(waId);
}
