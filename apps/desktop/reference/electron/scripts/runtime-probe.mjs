import {app} from 'electron';
import {DatabaseSync, backup} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'momoki-electron-probe-'));
app.setPath('userData', join(root, 'profile'));
try {
  await app.whenReady();
  if (process.versions.electron !== '44.7.0') throw new Error('Incorrect Electron pin');
  const db = new DatabaseSync(join(root, 'probe.sqlite'));
  db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'native main process\')');
  await backup(db, join(root, 'backup.sqlite'));
  const snapshot = new DatabaseSync(join(root, 'backup.sqlite'), {readOnly: true});
  if (snapshot.prepare('SELECT value FROM proof').get().value !== 'native main process') throw new Error('SQLite backup roundtrip failed');
  console.log(JSON.stringify({runtime: 'actual-electron-main', versions: process.versions, sqlite: db.prepare('SELECT sqlite_version() AS version').get(), backup: 'passed'}));
  snapshot.close(); db.close();
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await rm(root, {recursive: true, force: true}); app.exit(process.exitCode ?? 0); }
