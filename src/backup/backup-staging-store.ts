import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import Database from 'better-sqlite3';
import { MandatoryBackupTableName, TABLE_METADATA_MAP } from './backup-table-registry';
import { BadRequestException } from '@nestjs/common';

interface PendingPromise {
  resolve: () => void;
  reject: (reason?: any) => void;
}

export class BackupStagingStore {
  public readonly dirPath: string;
  private readonly db: Database.Database;
  private readonly fileStreams = new Map<string, fs.WriteStream>();
  private readonly insertIdStmt: Database.Statement;
  private readonly hasIdStmt: Database.Statement;
  private readonly insertCompositeStmt: Database.Statement;
  private readonly hasCompositeStmt: Database.Statement;
  private readonly pendingPromises = new Set<PendingPromise>();
  private isCleanedUp = false;

  constructor() {
    this.dirPath = path.join(
      os.tmpdir(),
      `sztufa-backup-staging-${Date.now()}-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(this.dirPath, { recursive: true });

    const dbPath = path.join(this.dirPath, 'staging_index.db');
    this.db = new Database(dbPath);
    this.db.pragma('synchronous = OFF');
    this.db.pragma('journal_mode = OFF');
    this.db.pragma('temp_store = FILE');
    this.db.pragma('cache_size = -2000');

    this.db.exec(`
      CREATE TABLE id_index (
        table_name TEXT NOT NULL,
        id_val TEXT NOT NULL,
        PRIMARY KEY (table_name, id_val)
      );
      CREATE TABLE composite_key_index (
        table_name TEXT NOT NULL,
        key_val TEXT NOT NULL,
        PRIMARY KEY (table_name, key_val)
      );
    `);

    this.insertIdStmt = this.db.prepare('INSERT INTO id_index (table_name, id_val) VALUES (?, ?)');
    this.hasIdStmt = this.db.prepare(
      'SELECT 1 FROM id_index WHERE table_name = ? AND id_val = ? LIMIT 1',
    );
    this.insertCompositeStmt = this.db.prepare(
      'INSERT INTO composite_key_index (table_name, key_val) VALUES (?, ?)',
    );
    this.hasCompositeStmt = this.db.prepare(
      'SELECT 1 FROM composite_key_index WHERE table_name = ? AND key_val = ? LIMIT 1',
    );
  }

  private getWriteStream(tableName: string): fs.WriteStream {
    let ws = this.fileStreams.get(tableName);
    if (!ws) {
      const filePath = path.join(this.dirPath, `${tableName}.ndjson`);
      ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
      this.fileStreams.set(tableName, ws);
    }
    return ws;
  }

  public async writeRow(tableName: MandatoryBackupTableName, row: any): Promise<void> {
    if (this.isCleanedUp) return;

    const ws = this.getWriteStream(tableName);
    const canContinue = ws.write(JSON.stringify(row) + '\n');

    if (row && typeof row === 'object' && row.id !== undefined && row.id !== null) {
      try {
        this.insertIdStmt.run(tableName, String(row.id));
      } catch (err: any) {
        if (
          err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
          err?.code === 'SQLITE_CONSTRAINT' ||
          String(err?.message || '').includes('UNIQUE constraint failed')
        ) {
          throw new BadRequestException(`数据格式错误: 表 ${tableName} 包含重复主键/ID: ${row.id}`);
        }
        throw err;
      }
    }

    const meta = TABLE_METADATA_MAP[tableName];
    if (meta?.compositeUniqueKeys) {
      for (const fields of meta.compositeUniqueKeys) {
        const compositeKeyStr = fields.map((f) => String(row[f])).join('::');
        try {
          this.insertCompositeStmt.run(tableName, compositeKeyStr);
        } catch (err: any) {
          if (
            err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
            err?.code === 'SQLITE_CONSTRAINT' ||
            String(err?.message || '').includes('UNIQUE constraint failed')
          ) {
            throw new BadRequestException(
              `表 ${tableName} 包含重复的复合唯一键 [${fields.join(', ')}]: ${compositeKeyStr}`,
            );
          }
          throw err;
        }
      }
    }

    if (!canContinue) {
      await new Promise<void>((resolve, reject) => {
        const pending: PendingPromise = { resolve, reject };
        this.pendingPromises.add(pending);

        const cleanupListeners = () => {
          this.pendingPromises.delete(pending);
          ws.off('drain', onDrain);
          ws.off('error', onError);
          ws.off('close', onClose);
        };

        const onDrain = () => {
          cleanupListeners();
          resolve();
        };
        const onError = (err: Error) => {
          cleanupListeners();
          reject(err);
        };
        const onClose = () => {
          cleanupListeners();
          reject(new Error(`WriteStream closed prematurely for ${tableName}`));
        };

        ws.once('drain', onDrain);
        ws.once('error', onError);
        ws.once('close', onClose);
      });
    }
  }

  public hasId(tableName: string, idVal: string): boolean {
    if (this.isCleanedUp) return false;
    const row = this.hasIdStmt.get(tableName, String(idVal));
    return !!row;
  }

  public async finishWriting(): Promise<void> {
    for (const stream of this.fileStreams.values()) {
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  public async *iterateTable(
    tableName: MandatoryBackupTableName,
    batchSize = 500,
  ): AsyncGenerator<any[], void, unknown> {
    const filePath = path.join(this.dirPath, `${tableName}.ndjson`);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let currentBatch: any[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        currentBatch.push(record);
        if (currentBatch.length >= batchSize) {
          yield currentBatch;
          currentBatch = [];
        }
      } catch (err: any) {
        throw new BadRequestException(
          `读取临时 NDJSON 行记录解析失败 (${tableName}): ${err.message}`,
        );
      }
    }

    if (currentBatch.length > 0) {
      yield currentBatch;
    }
  }

  public cleanup(): void {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;

    for (const pending of this.pendingPromises) {
      try {
        pending.reject(new Error('StagingStore cleanup initiated'));
      } catch {}
    }
    this.pendingPromises.clear();

    for (const stream of this.fileStreams.values()) {
      try {
        stream.destroy();
      } catch {}
    }
    this.fileStreams.clear();

    try {
      if (this.db.open) {
        this.db.close();
      }
    } catch {}

    try {
      if (fs.existsSync(this.dirPath)) {
        fs.rmSync(this.dirPath, { recursive: true, force: true });
      }
    } catch {}
  }
}
