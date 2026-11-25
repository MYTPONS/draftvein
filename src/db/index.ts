import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');

export type Row = Record<string, any>;

export class Store {
  db: DatabaseSync;
  file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(fs.readFileSync(schemaPath, 'utf8'));
    this.migrate();
  }

  private migrate() {
    // 老库补列：SQLite 的 CREATE TABLE IF NOT EXISTS 不会加列
    const cols = (t: string) => this.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    const add = (t: string, col: string, def: string) => {
      if (cols(t).includes(col)) return;
      if (col === 'volume_id') {
        this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} INTEGER`);
        return;
      }
      this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${def}'`);
    };
    add('chapter_plans', 'cast', '[]');
    add('chapter_plans', 'highlights', '[]');
    add('chapter_plans', 'synopsis', '');
    add('chapter_plans', 'musts', '[]');
    add('chapter_plans', 'volume_id', '');
    add('chapters', 'volume_id', '');
    add('characters', 'category', '主要角色');
    add('highlights', 'pays_code', '');
    add('timeline', 'scene', '');
    add('facts', 'visibility', 'reader');
    add('bible', 'category', '背景设定');

    // 旧版抽取提示词用 0 表示“未知窗口”，但 0 会被逾期算法当成第 0 章到期。
    // 统一迁成 NULL：保留“未知”，绝不制造假的逾期告警。
    this.db.exec(`
      UPDATE threads SET due_from=NULL WHERE due_from IS NOT NULL AND due_from<=0;
      UPDATE threads SET due_to=NULL WHERE due_to IS NOT NULL AND due_to<=0;
      UPDATE expectations SET due_from=NULL WHERE due_from IS NOT NULL AND due_from<=0;
      UPDATE expectations SET due_to=NULL WHERE due_to IS NOT NULL AND due_to<=0;
    `);
  }

  private norm(params: any[]): any[] {
    // node:sqlite 不接受 undefined；统一转 null，避免"cannot be bound"整章白写
    return params.map((p) => (p === undefined ? null : p));
  }

  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...this.norm(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...this.norm(params)) as T[];
  }

  run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...this.norm(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}
