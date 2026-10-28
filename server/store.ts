import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppState, Dataset } from '../shared/types.js';
import { defaultSettings, createDemoState } from '../shared/defaults.js';
import { stateSchema, stateReferenceErrors } from './validation.js';
import { migrateState } from '../shared/migrations.js';

export const MAX_BACKUP_BYTES=512*1024*1024;
export class CapacityError extends Error {}

/** State and original PDFs share one SQLite transaction and backup boundary. */
export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'circulos.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS states (dataset TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (dataset TEXT NOT NULL, id TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(dataset,id));`);
    if (!this.db.prepare('SELECT 1 FROM states WHERE dataset=?').get('real')) this.save('real', { students: [], settings: structuredClone(defaultSettings), pdfs: [] });
    if (!this.db.prepare('SELECT 1 FROM states WHERE dataset=?').get('demo')) this.save('demo', createDemoState());
  }
  read(dataset: Dataset): AppState {
    const row = this.db.prepare('SELECT payload FROM states WHERE dataset=?').get(dataset) as { payload: string };
    const state=migrateState(JSON.parse(row.payload) as AppState);
    if(JSON.stringify(state)!==row.payload)this.save(dataset,state);
    return state;
  }
  save(dataset: Dataset, state: AppState) {
    const checked=stateSchema.safeParse(state);
    if(!checked.success)throw checked.error;
    const errors=stateReferenceErrors(state);
    if(errors.length)throw new Error(errors.join(' '));
    const payload=JSON.stringify(state);
    const files=this.db.prepare('SELECT id,length(content) AS bytes FROM documents WHERE dataset=?').all(dataset) as {id:string;bytes:number}[];
    const fileIds=new Set(files.map(file=>file.id));
    if(state.pdfs.some(pdf=>!fileIds.has(pdf.id)))throw new Error('Falta el archivo original de un PDF del estado.');
    // Bound the exact JSON backup size, including base64 overhead, before committing writes.
    const envelope=JSON.stringify({format:'circulos-backup',version:1,dataset,createdAt:new Date().toISOString(),state:null,files:[]});
    const backupBytes=Buffer.byteLength(payload)+Buffer.byteLength(envelope)-4+files.reduce((sum,file)=>sum+Buffer.byteLength(JSON.stringify({id:file.id,content:''}))+4*Math.ceil(file.bytes/3),0)+Math.max(0,files.length-1);
    if(backupBytes>MAX_BACKUP_BYTES)throw new CapacityError('La operación supera el límite de respaldo de 512 MB por base de datos. Reduzca el tamaño de los PDF antes de volver a cargarlos. El registro actual no se guardó.');
    this.db.prepare('INSERT INTO states(dataset,payload) VALUES(?,?) ON CONFLICT(dataset) DO UPDATE SET payload=excluded.payload').run(dataset,payload);
  }
  file(dataset: Dataset, id: string): Buffer | null {
    const row = this.db.prepare('SELECT content FROM documents WHERE dataset=? AND id=?').get(dataset, id) as { content: Uint8Array } | undefined;
    return row ? Buffer.from(row.content) : null;
  }
  files(dataset: Dataset): { id: string; content: string }[] {
    return (this.db.prepare('SELECT id,content FROM documents WHERE dataset=?').all(dataset) as {id:string;content:Uint8Array}[]).map(row => ({ id: row.id, content: Buffer.from(row.content).toString('base64') }));
  }
  putFile(dataset: Dataset, id: string, content: Buffer) {
    this.db.prepare('INSERT INTO documents(dataset,id,content) VALUES(?,?,?)').run(dataset, id, content);
  }
  deleteFiles(dataset: Dataset, ids: string[]) {
    const remove=this.db.prepare('DELETE FROM documents WHERE dataset=? AND id=?');
    for(const id of ids)remove.run(dataset,id);
  }
  replace(dataset: Dataset, state: AppState, files: { id: string; content: Buffer }[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM documents WHERE dataset=?').run(dataset);
      for (const file of files) this.putFile(dataset, file.id, file.content);
      this.save(dataset, state);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transaction(callback: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { callback(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
