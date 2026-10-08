import { assertInvestigation, freezeInvestigation, investigationBytes } from "./investigation.js";

export const INVESTIGATION_DATABASE = "chquery-investigations";
export const INVESTIGATION_DATABASE_VERSION = 1;
export const INVESTIGATION_STORAGE_BYTES = 100 * 1024 * 1024;
const records = "investigations";
const credentialKey = /^(?:delete[_-]?token|deletion[_-]?receipt|capabilities|capability[_-]?(?:url|link)|share[_-]?(?:url|link|key)|encryption[_-]?key|secret|credentials|password|access[_-]?token)$/i;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function storageFailure(error) {
  if (error?.code && typeof error.code === "string") return error;
  if (error?.name === "QuotaExceededError") return failure("quota", "Device storage is full. Your in-memory work is unchanged; export it or delete saved investigations.");
  if (error?.name === "VersionError") return failure("version", "This browser has a newer investigation database. Use a compatible CH Query version; no saved records were changed.");
  return failure("storage", "Device storage is unavailable. Your in-memory work is unchanged; export it or retry saving.");
}

// Reject recognizable capabilities instead of silently altering an original save.
// This is not a general secret scanner: arbitrary SQL/free text can be sensitive.
export function assertLocallySaveable(investigation) {
  assertInvestigation(investigation);
  const stack = [investigation];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string" && /#s=[a-f0-9]{32}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|#[bj]=[A-Za-z0-9_-]{16,}/.test(value)) {
      throw failure("capability", "Remove embedded share links before saving on this device. Keep links and deletion receipts separately.");
    }
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (credentialKey.test(key)) throw failure("capability", "Remove credential or share-capability fields before saving on this device. Keep deletion receipts separately.");
      stack.push(child);
    }
  }
  return investigation;
}

function checkRecord(record) {
  if (!record || typeof record.id !== "string" || !record.id || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) {
    throw failure("corrupt", "A saved investigation has invalid local metadata. No records were changed.");
  }
  try { assertLocallySaveable(record.investigation); }
  catch { throw failure("corrupt", "A saved investigation cannot be read by this version. No records were changed."); }
  return record;
}

/** Construction/subscription has no persistence side effects. Only an explicit
 * save() or list() activates IndexedDB. get/delete/clear require activation.
 * Callers own consent, dirty state, confirmation and current in-memory evidence.
 */
export function createInvestigationStore({
  indexedDB = globalThis.indexedDB, BroadcastChannel = globalThis.BroadcastChannel,
  databaseName = INVESTIGATION_DATABASE
} = {}) {
  let database = null;
  let opening = null;
  let channel = null;
  let closed = false;
  const listeners = new Set();

  function notify(event, broadcast = true) {
    if (broadcast) {
      try { channel?.postMessage(event); } catch { /* Transactions remain authoritative. */ }
    }
    for (const listener of listeners) {
      try { listener(Object.freeze({ ...event })); } catch { /* One view must not break deletion or another view. */ }
    }
  }

  function activate() {
    if (closed) return Promise.reject(failure("closed", "This storage session is closed. Open the saved list in a new session."));
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request;
      let abandoned = false;
      try { request = indexedDB.open(databaseName, INVESTIGATION_DATABASE_VERSION); }
      catch (error) { reject(storageFailure(error)); return; }
      request.onupgradeneeded = event => {
        // v1 has no historical format to migrate. Future versions must add an
        // explicit transactional migration rather than dropping existing data.
        if (abandoned || closed || event.oldVersion !== 0) { request.transaction.abort(); return; }
        request.result.createObjectStore(records, { keyPath: "id" });
      };
      request.onblocked = () => {
        abandoned = true;
        reject(failure("blocked", "Another tab blocks the database upgrade. Close older CH Query tabs and retry; saved data is unchanged."));
      };
      request.onerror = () => reject(storageFailure(request.error));
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned || closed) { db.close(); reject(failure("closed", "Storage opening was cancelled.")); return; }
        const shape = db.objectStoreNames.contains(records) ? db.transaction(records).objectStore(records) : null;
        if (!shape || shape.keyPath !== "id" || shape.autoIncrement) {
          db.close();
          reject(failure("schema", "The investigation database has an unsupported schema. No data was changed."));
          return;
        }
        database = db;
        db.onversionchange = () => {
          db.close();
          database = null;
          closed = true;
          notify({ type: "unavailable" });
        };
        try {
          channel = new BroadcastChannel(`${databaseName}:changes`);
          channel.onmessage = ({ data }) => {
            if (!data || !["saved", "deleted", "cleared", "unavailable"].includes(data.type)) return;
            if (["saved", "deleted"].includes(data.type) && typeof data.id !== "string") return;
            // Never forward caller-controlled evidence/content through the bus.
            notify({ type: data.type, ...(data.id ? { id: data.id } : {}),
              ...(Number.isSafeInteger(data.revision) ? { revision: data.revision } : {}) }, false);
          };
        } catch { channel = null; }
        resolve(db);
      };
    }).finally(() => { opening = null; });
    return opening;
  }

  function active() {
    if (!database || closed) throw failure("inactive", "Choose Save on this device or open the saved list first.");
    return database;
  }

  function transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let customError;
      try { tx = active().transaction(records, mode); }
      catch (error) { reject(storageFailure(error)); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(customError || storageFailure(tx.error));
      // Do not prevent default request errors: IndexedDB must roll back writes.
      const abort = error => { customError = storageFailure(error); tx.abort(); };
      try { operation(tx.objectStore(records), value => { result = value; }, abort); }
      catch (error) { abort(error); }
    });
  }

  return {
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Expected a change listener.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async list() {
      await activate();
      return transaction("readonly", (store, done, abort) => {
        store.getAll().onsuccess = ({ target }) => {
          try {
            done(target.result.map(checkRecord).map(record => ({ id: record.id, revision: record.revision,
              title: record.investigation.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
              bytes: investigationBytes(record.investigation) })).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)));
          } catch (error) { abort(error); }
        };
      });
    },

    async get(id) {
      if (typeof id !== "string" || !id) throw new TypeError("Expected a saved investigation ID.");
      return transaction("readonly", (store, done, abort) => {
        store.get(id).onsuccess = ({ target }) => {
          try { done(target.result ? freezeInvestigation(checkRecord(target.result)) : null); }
          catch (error) { abort(error); }
        };
      });
    },

    async save(investigation, { id, expectedRevision } = {}) {
      // Capture before the first await: later caller edits cannot change a save.
      assertLocallySaveable(investigation);
      const snapshot = JSON.parse(JSON.stringify(investigation));
      if ((id === undefined) !== (expectedRevision === undefined) ||
          (id !== undefined && (typeof id !== "string" || !id || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1))) {
        throw new TypeError("Updating a save requires its ID and expected revision. Omit both to save a new copy.");
      }
      await activate();
      const result = await transaction("readwrite", (store, done, abort) => {
        store.getAll().onsuccess = ({ target }) => {
          try {
            const saved = target.result.map(checkRecord);
            const prior = saved.find(record => record.id === id);
            if (id !== undefined && (!prior || prior.revision !== expectedRevision || prior.revision === Number.MAX_SAFE_INTEGER)) {
              throw failure("conflict", "This save changed or was deleted in another tab. Reload it or explicitly save a new copy; your in-memory work is unchanged.");
            }
            const size = investigationBytes(snapshot);
            const total = saved.reduce((sum, record) => sum + (record.id === id ? 0 : investigationBytes(record.investigation)), size);
            if (total > INVESTIGATION_STORAGE_BYTES) throw failure("capacity", "Saved investigations exceed the 100 MiB device budget. Export or delete old work; nothing was evicted.");
            const now = Math.max(Date.now(), prior?.updatedAt || 0);
            const record = { id: prior?.id || crypto.randomUUID(), revision: (prior?.revision || 0) + 1,
              createdAt: prior?.createdAt ?? now, updatedAt: now, investigation: snapshot };
            if (prior) store.put(record);
            else store.add(record);
            done(freezeInvestigation(record));
          } catch (error) { abort(error); }
        };
      });
      notify({ type: "saved", id: result.id, revision: result.revision });
      return result;
    },

    async delete(id, expectedRevision) {
      if (typeof id !== "string" || !id || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new TypeError("Deletion requires the saved ID and expected revision.");
      }
      await transaction("readwrite", (store, done, abort) => {
        store.get(id).onsuccess = ({ target }) => {
          if (target.result && target.result.revision !== expectedRevision) {
            abort(failure("conflict", "This save changed in another tab. Review it before deleting."));
            return;
          }
          store.delete(id);
          done();
        };
      });
      notify({ type: "deleted", id });
    },

    async clear() {
      await transaction("readwrite", (store, done) => { store.clear(); done(); });
      notify({ type: "cleared" });
    },

    close() {
      closed = true;
      database?.close();
      database = null;
      channel?.close();
      channel = null;
      listeners.clear();
    }
  };
}
