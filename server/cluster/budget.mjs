import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { clusterError } from './state.mjs'

// Reservations include partial uploads and interrupted captures. They are
// deliberately conservative until an explicit idle cache reset; a crash cannot
// create uncharged space. All writers, including snapshot helpers, share this
// SQLite counter. The owning controller/worker lease precedes initialization.
export class ObjectBudget {
  constructor(filename, { maxBytes, maxFiles }) {
    this.filename = filename
    this.maxBytes = maxBytes
    this.maxFiles = maxFiles
    try {
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.nlink !== 1)
        throw clusterError('Invalid object budget database.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.db = new DatabaseSync(filename)
    fs.chmodSync(filename, 0o600)
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reservations (hash TEXT PRIMARY KEY, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quota (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, files INTEGER NOT NULL);
      INSERT OR IGNORE INTO quota VALUES(1,0,0);
      CREATE TRIGGER IF NOT EXISTS reserve_insert AFTER INSERT ON reservations BEGIN UPDATE quota SET bytes=bytes+NEW.size,files=files+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS reserve_delete AFTER DELETE ON reservations BEGIN UPDATE quota SET bytes=bytes-OLD.size,files=files-1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS reserve_resize AFTER UPDATE OF size ON reservations BEGIN UPDATE quota SET bytes=bytes+NEW.size-OLD.size WHERE id=1; END;`)
  }

  usage() {
    return {
      ...this.db.prepare('SELECT bytes,files FROM quota WHERE id=1').get(),
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
    }
  }

  reserve(hash, size, seed = false) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db
        .prepare('SELECT size FROM reservations WHERE hash=?')
        .get(hash)
      if (previous) {
        if (!seed && size !== previous.size)
          throw clusterError(
            'Object size differs from its reservation.',
            'digest_mismatch',
            409,
          )
        if (size > previous.size)
          this.db
            .prepare('UPDATE reservations SET size=? WHERE hash=?')
            .run(size, hash)
      } else {
        const used = this.usage()
        if (
          !seed &&
          (used.bytes + size > this.maxBytes || used.files + 1 > this.maxFiles)
        )
          throw clusterError(
            'The worker object-store budget is full.',
            'storage_full',
            507,
          )
        this.db.prepare('INSERT INTO reservations VALUES(?,?)').run(hash, size)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  reset() {
    this.db.exec('DELETE FROM reservations; PRAGMA wal_checkpoint(TRUNCATE);')
  }
  close() {
    this.db.close()
  }
}

export const pythonBudget = String.raw`
import sqlite3
_budget=sqlite3.connect(budget_filename,timeout=5)
_budget.execute('PRAGMA synchronous=FULL')
def reserve_blob(hash,size):
 _budget.execute('BEGIN IMMEDIATE')
 try:
  prior=_budget.execute('SELECT size FROM reservations WHERE hash=?',(hash,)).fetchone()
  if prior:
   if size>prior[0]:raise ValueError('Object size differs from its reservation')
  else:
   used,count=_budget.execute('SELECT bytes,files FROM quota WHERE id=1').fetchone()
   if used+size>max_bytes or count+1>max_files:raise OSError('Worker object-store budget reached')
   _budget.execute('INSERT INTO reservations VALUES(?,?)',(hash,size))
  _budget.commit()
 except BaseException:
  _budget.rollback();raise
`
