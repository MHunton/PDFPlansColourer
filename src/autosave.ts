// Autosave to this browser's IndexedDB: the project (rooms, key, floors) as one record, each original PDF once.
// Per browser and device only; the exported PDF (with its embedded project) is the portable copy.
import type { ProjectState } from "./project";

type Meta = Omit<ProjectState, "sources"> & { savedAt: number; current: number; sources: { id: string; fileName: string }[] };

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= new Promise((resolve, reject) => {
  const req = indexedDB.open("plan-colour-coder", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("kv");
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
}));
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("kv", mode), req = fn(t.objectStore("kv"));
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = t.onabort = () => reject(t.error ?? new Error("storage refused"));
  });
}
const get = <T>(key: string) => run<T>("readonly", (s) => s.get(key));

const stored = new Set<string>(); // source ids already written this session

export async function saveSession(state: ProjectState, current: number): Promise<void> {
  for (const s of state.sources) {
    if (stored.has(s.id)) continue;
    await run("readwrite", (st) => { st.put(s.bytes, `src:${s.id}`); });
    stored.add(s.id);
  }
  const meta: Meta = { ...state, savedAt: Date.now(), current, sources: state.sources.map(({ id, fileName }) => ({ id, fileName })) };
  const keep = new Set(state.sources.map((s) => `src:${s.id}`));
  await run("readwrite", (st) => {
    st.put(meta, "session");
    const keys = st.getAllKeys();
    keys.onsuccess = () => { for (const k of keys.result) if (String(k).startsWith("src:") && !keep.has(String(k))) st.delete(k); };
  });
}

/** Summary of the saved session, if any (cheap: doesn't read the PDFs). */
export const peekSession = () => get<Meta | undefined>("session").catch(() => undefined);

export async function loadSession(): Promise<{ state: ProjectState; current: number } | null> {
  const meta = await get<Meta | undefined>("session");
  if (!meta) return null;
  const sources = await Promise.all(meta.sources.map(async (s) => {
    const bytes = await get<Uint8Array | undefined>(`src:${s.id}`);
    if (!bytes) throw new Error(`the saved copy of ${s.fileName} is missing`);
    stored.add(s.id);
    return { ...s, bytes };
  }));
  const { savedAt: _, current, ...rest } = meta;
  return { state: { ...rest, sources }, current };
}

export const clearSession = () => run("readwrite", (s) => { s.clear(); }).then(() => stored.clear());
