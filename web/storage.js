/**
 * Library storage. Book metadata, parsed content, originals and reading progress are separate
 * stores so that a page turn only writes a few small fields instead of re-serialising the whole
 * record (which carries a base64 cover).
 */
const VERSION = 4;
const STORES = ['books', 'documents', 'originals', 'progress', 'dicts', 'vocab', 'searchUnits', 'searchMeta'];
let connection;
export async function database() {
  if (connection) return connection;
  connection = await new Promise((resolve, reject) => {
    const request = indexedDB.open('moyue-reader', VERSION);
    request.onupgradeneeded = () => {
      // v1 created the first three stores; v2 adds progress. Both paths stay idempotent so an
      // interrupted upgrade can simply run again.
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}
export async function get(store, id) {
  const db = await database();
  return new Promise((resolve, reject) => {const r=db.transaction(store).objectStore(store).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
function readAll(tx, store) {
  return new Promise((resolve, reject) => {const r=tx.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});
}
export async function allBooks() {
  const db = await database();
  const tx=db.transaction(['books','progress']);
  const [books, progress] = await Promise.all([readAll(tx, 'books'), readAll(tx, 'progress')]);
  const latest = new Map(progress.map(record => [record.id, record]));
  return books.map(book => {
    const saved = latest.get(book.id);
    if (!saved) return book;
    // Progress is authoritative only for the fields it owns; everything else stays in the book.
    return {
      ...book,
      locator: saved.locator || book.locator,
      progress: Number.isFinite(saved.progress) ? saved.progress : book.progress,
      finished: typeof saved.finished === 'boolean' ? saved.finished : book.finished,
      lastOpened: Number.isFinite(saved.lastOpened) ? saved.lastOpened : book.lastOpened,
    };
  });
}

async function write(stores,fill){
  try{const db=await database();return await new Promise((resolve,reject)=>{const tx=db.transaction(stores,'readwrite');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('本次保存未完成，原数据未改变'));try{fill(tx);}catch(error){tx.abort();reject(error);}});}
  catch(cause){const error=new Error(cause?.message||'无法写入本地书库',{cause});error.name='LibraryWriteError';throw error;}
}
/** Reading position only: small, frequent, and never touches the cover or notes. */
export function progressRecord(book){return {id:book.id,locator:book.locator,progress:book.progress,finished:book.finished,lastOpened:book.lastOpened};}
export function putProgress(book){return write(['progress'],tx=>tx.objectStore('progress').put(progressRecord(book)));}
export function putBook(book){return write(['books','progress'],tx=>{tx.objectStore('books').put(book);tx.objectStore('progress').put(progressRecord(book));});}
export function insertBook(book,document,original){return write(['books','documents','originals','progress','searchUnits','searchMeta'],tx=>{tx.objectStore('books').put(book);tx.objectStore('documents').put({id:book.id,...document});tx.objectStore('originals').put({id:book.id,blob:original});tx.objectStore('progress').put(progressRecord(book));clearBookIndex(tx,book.id);});}
export function deleteBook(id){return write(['books','documents','originals','progress','searchUnits','searchMeta'],tx=>{for(const store of ['books','documents','originals','progress'])tx.objectStore(store).delete(id);clearBookIndex(tx,id);});}
/** Commit validated backup records atomically; unrelated books remain. */
export function restoreBooks(records,vocab=[]){return write(['books','documents','originals','progress','vocab','searchUnits','searchMeta'],tx=>{for(const {book,doc,original} of records){tx.objectStore('books').put(book);tx.objectStore('documents').put({id:book.id,...doc});tx.objectStore('originals').put({id:book.id,blob:original});tx.objectStore('progress').put(progressRecord(book));clearBookIndex(tx,book.id);}for(const record of vocab)tx.objectStore('vocab').put(record);});}
export function putDocument(doc){return write(['documents'],tx=>tx.objectStore('documents').put(doc));}
function clearBookIndex(tx,id){tx.objectStore('searchMeta').delete(id);tx.objectStore('searchUnits').delete(IDBKeyRange.bound(id+':',id+':\uffff'));}
export function dropSearchIndex(id){return write(['searchUnits','searchMeta'],tx=>{if(id)clearBookIndex(tx,id);else{tx.objectStore('searchUnits').clear();tx.objectStore('searchMeta').clear();}});}
export function putSearchUnit(unit,meta){return write(['searchUnits','searchMeta'],tx=>{tx.objectStore('searchUnits').put(unit);tx.objectStore('searchMeta').put(meta);});}
export function putSearchMetadata(meta){return write(['searchMeta'],tx=>tx.objectStore('searchMeta').put(meta));}
export async function indexMetadata(){const db=await database();return readAll(db.transaction('searchMeta'),'searchMeta');}
export function putVocabBatch(records){return write(['vocab'],tx=>{for(const r of records)tx.objectStore('vocab').put(r);});}

/* ---------- offline dictionaries ---------- */
export async function allDicts(){const db=await database();return readAll(db.transaction('dicts'),'dicts');}
export function putDict(record){return write(['dicts'],tx=>tx.objectStore('dicts').put(record));}
export function deleteDictRecord(id){return write(['dicts'],tx=>tx.objectStore('dicts').delete(id));}

/* ---------- vocabulary ---------- */
export async function allVocab(){const db=await database();return readAll(db.transaction('vocab'),'vocab');}
export function putVocabRecord(record){return write(['vocab'],tx=>tx.objectStore('vocab').put(record));}
export function deleteVocabRecord(id){return write(['vocab'],tx=>tx.objectStore('vocab').delete(id));}
export function restoreVocab(records){return write(['vocab'],tx=>{for(const record of records)tx.objectStore('vocab').put(record);});}
