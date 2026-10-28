/**
 * Minimal, dependency-free StarDict reader.
 *
 * A dictionary is a bundle of files that share one base name:
 *   .ifo   plain-text metadata
 *   .idx   sorted word list: word\0 offset(u32be) size(u32be)
 *   .dict  raw entries, or .dict.dz (dictzip, a gzip member we can inflate whole)
 *   .syn   optional synonyms: word\0 index(u32be)
 *
 * Only the pieces the reader actually needs are implemented. Unsupported variants
 * (64-bit offsets, compressed .idx.gz) are rejected with an explicit message rather
 * than producing wrong definitions.
 */
import { Gunzip } from 'fflate';

const MAGIC = "StarDict's dict ifo file";
const MAX_ENTRIES = 900000;
const MAX_DICT_BYTES = 160 * 1024 * 1024;
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let k=0;k<8;k++)i=(i>>>1)^((i&1)?0xedb88320:0);return i>>>0;});
const utf8 = new TextDecoder('utf-8', {fatal:true});
const asciiFold = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
// StarDict orders UTF-8 bytes after folding ASCII only, with original bytes as tie-breaker.
function byteOrder(a,b){
  let i=0,j=0;
  while(i<a.length&&j<b.length){const x=a.codePointAt(i),y=b.codePointAt(j);if(x!==y)return x-y;i+=x>65535?2:1;j+=y>65535?2:1;}
  return (i<a.length?1:0)-(j<b.length?1:0);
}
export function stardictCompare(a,b){return byteOrder(asciiFold(a),asciiFold(b))||byteOrder(a,b);}

export function baseName(name) {
  return String(name || '').replace(/\.(ifo|idx|idx\.gz|dict|dict\.dz|syn)$/i, '');
}
export function fileKind(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.ifo')) return 'ifo';
  if (lower.endsWith('.idx')) return 'idx';
  if (lower.endsWith('.idx.gz')) return 'idxgz';
  if (lower.endsWith('.dict.dz')) return 'dictdz';
  if (lower.endsWith('.dict')) return 'dict';
  if (lower.endsWith('.syn')) return 'syn';
  return '';
}

/** Group a multi-file selection into dictionary bundles keyed by their shared base name. */
export function groupBundles(names) {
  const groups = new Map();
  for (const name of names) {
    const kind = fileKind(name);
    if (!kind) continue;
    const base = baseName(name);
    if (!groups.has(base)) groups.set(base, { base, files: {} });
    groups.get(base).files[kind] = name;
  }
  return [...groups.values()];
}

export function parseIfo(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== MAGIC) throw new Error('不是 StarDict 词典（缺少 ifo 标识）');
  const info = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf('=');
    if (at > 0) info[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const version = info.version || '';
  if (!['2.4.2','3.0.0'].includes(version)) throw new Error('只支持 StarDict 2.4.2 / 3.0.0 词典');
  if (info.idxoffsetbits && info.idxoffsetbits !== '32') throw new Error('暂不支持非 32 位偏移的 idx 文件');
  const wordcount = Number(info.wordcount);
  if (!Number.isSafeInteger(wordcount) || wordcount <= 0 || wordcount > MAX_ENTRIES) throw new Error('词典词条数量异常');
  const same = (info.sametypesequence || '').trim();
  return {
    version,
    wordcount,
    idxfilesize: Number(info.idxfilesize) || 0,
    bookname: info.bookname || '未命名词典',
    author: info.author || '',
    description: info.description || '',
    sametypesequence: same,
  };
}

/** Parse the sorted index into parallel arrays; binary search runs over `words`. */
export function parseIdx(buffer, expectedCount) {
  const bytes = new Uint8Array(buffer);
  if(bytes.length>64*1024*1024)throw new Error('词典索引超过 64 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [];
  const offsets = new Uint32Array(expectedCount || 1024);
  const sizes = new Uint32Array(expectedCount || 1024);
  let at = 0;
  let count = 0;
  while (at < bytes.length) {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end >= bytes.length) throw new Error('词典索引被截断');
    if(end===at||end-at>4096)throw new Error('词典索引词语长度无效');
    const word = utf8.decode(bytes.subarray(at, end));
    if (end + 9 > bytes.length) throw new Error('词典索引被截断');
    if (count >= offsets.length) throw new Error('词典索引条目超过声明数量');
    offsets[count] = view.getUint32(end + 1, false);
    sizes[count] = view.getUint32(end + 5, false);
    words.push(word);
    count++;
    at = end + 9;
  }
  if (!count) throw new Error('词典索引为空');
  if (expectedCount && count !== expectedCount) throw new Error(`词典索引条目数不符（声明 ${expectedCount}，实际 ${count}）`);
  return { words, offsets: offsets.subarray(0, count), sizes: sizes.subarray(0, count), count };
}

export function parseSyn(buffer, expectedCount) {
  const bytes = new Uint8Array(buffer);
  if(bytes.length>32*1024*1024)throw new Error('同义词索引超过 32 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [];
  const indexes = [];
  let at = 0;
  while (at < bytes.length) {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end===at||end-at>4096||end + 5 > bytes.length) throw new Error('同义词索引被截断');
    words.push(utf8.decode(bytes.subarray(at, end)));
    const index=view.getUint32(end + 1, false);
    if(expectedCount&&index>=expectedCount)throw new Error('同义词指向无效词条');
    indexes.push(index);
    at = end + 5;
  }
  if (expectedCount && !words.length) throw new Error('同义词索引为空');
  return { words, indexes };
}

function stripMarkup(text) {
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

/**
 * StarDict stores either a type character per field, or one implicit sequence for the whole
 * dictionary. We decode the text-bearing types and drop media types instead of printing noise.
 */
export function decodeEntry(slice, sametypesequence) {
  const typeOf = code => ({ m: 'text', l: 'text', g: 'text', t: 'text', x: 'markup', h: 'markup', y: 'markup', k: 'markup', w: 'markup' }[code] || 'raw');
  let at = 0;
  const parts = [];
  const take = (code, last=false) => {
    const binary=/^[A-Z]$/.test(code);
    let end,next;
    if(last){end=slice.length;next=end;}
    else if(binary){
      if(at+4>slice.length)throw new Error('词条二进制字段被截断');
      const length=new DataView(slice.buffer,slice.byteOffset+at,4).getUint32(0,false);at+=4;end=at+length;next=end;
      if(end>slice.length)throw new Error('词条二进制字段长度无效');
    }else{
      end=slice.indexOf(0,at);if(end<0)throw new Error('词条文字字段被截断');next=end+1;
    }
    const body = slice.subarray(at, end);
    const kind = typeOf(code);
    if (kind === 'text') parts.push(utf8.decode(body).trim());
    else if (kind === 'markup') parts.push(stripMarkup(utf8.decode(body)).trim());
    // Binary payloads (images, sound, binary glossaries) are intentionally skipped.
    at = next;
  };
  if (sametypesequence) {
    for (let i = 0; i < sametypesequence.length; i++) {
      const code = sametypesequence[i];
      take(code, i === sametypesequence.length - 1);
    }
  } else {
    while (at < slice.length) {
      const code = String.fromCharCode(slice[at]);
      at++;
      if(!/^[a-zA-Z]$/.test(code))throw new Error('词条字段类型无效');
      take(code);
    }
  }
  return parts.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function inflateDict(buffer, compressed) {
  const raw = new Uint8Array(buffer);
  if (!compressed){if(raw.length>MAX_DICT_BYTES)throw new Error('词典超过 160 MB');return raw;}
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) throw new Error('词典数据不是有效的 dictzip 文件');
  // dictzip is a gzip member with an extra field; a full inflate is correct, just not random-access.
  let out;
  try {
    if(raw.length<18)throw new Error('压缩数据被截断');
    const declared=new DataView(raw.buffer,raw.byteOffset+raw.length-4,4).getUint32(0,true);
    if(declared>MAX_DICT_BYTES)throw new Error('词典解压后超过 160 MB');
    out=new Uint8Array(declared);let at=0,crc=0xffffffff;
    const stream=new Gunzip(chunk=>{
      if(at+chunk.length>out.length)throw new Error('词典解压长度超过声明或安全上限');
      out.set(chunk,at);at+=chunk.length;
      for(const byte of chunk)crc=(crc>>>8)^crcTable[(crc^byte)&255];
    });
    // Bound each inflate step so a dishonest gzip footer cannot allocate its full payload first.
    for(let i=0;i<raw.length;i+=1024)stream.push(raw.subarray(i,i+1024),i+1024>=raw.length);
    if(at!==declared)throw new Error('词典解压长度不符');
    if(((crc^0xffffffff)>>>0)!==new DataView(raw.buffer,raw.byteOffset+raw.length-8,4).getUint32(0,true))throw new Error('词典压缩数据校验失败');
  } catch (error) {
    throw new Error('词典数据解压失败：' + (error?.message || '文件损坏'));
  }
  if (out.length > MAX_DICT_BYTES) throw new Error('词典解压后超过 160 MB，无法在设备上安全使用');
  return out;
}

export class StarDict {
  constructor(record, meta, index, dictBytes, syn) {
    this.record = record;
    this.meta = meta;
    this.index = index;
    this.dictBytes = dictBytes;
    this.syn = syn;
    for(let i=0;i<index.count;i++){
      if(index.offsets[i]+index.sizes[i]>(dictBytes.length??dictBytes.size))throw new Error('词典索引指向了缺失的释义');
    }
    // A separate search order also keeps dictionaries imported by older releases readable.
    this.lower = index.words.map(asciiFold);
    this.order=Uint32Array.from(index.words.map((_,i)=>i)).sort((a,b)=>stardictCompare(index.words[a],index.words[b]));
    this.synMap = new Map();
    if (syn) syn.words.forEach((word, i) => {if(syn.indexes[i]>=index.count)throw new Error('同义词指向无效词条');this.synMap.set(asciiFold(word), syn.indexes[i]);});
  }
  get id() { return this.record.id; }
  get name() { return this.meta.bookname; }

  entryAt(i) {
    if (i < 0 || i >= this.index.count) return null;
    const start = this.index.offsets[i];
    const size = this.index.sizes[i];
    if (start + size > this.dictBytes.length) return null;
    return decodeEntry(this.dictBytes.subarray(start, start + size), this.meta.sametypesequence);
  }
  /** Exact match, then case-insensitive, then the synonym table. */
  lookup(word, limit = 6) {
    const needle = String(word || '').trim();
    if (!needle) return [];
    const results = [];
    const push = i => { if (i === undefined || i === null || i < 0) return; const text = this.entryAt(i); if (text) results.push({ word: this.index.words[i], definition: text }); };
    let low = 0, high = this.index.count - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const cmp = stardictCompare(this.index.words[this.order[mid]],needle);
      if (cmp === 0) { found = this.order[mid]; break; }
      if (cmp < 0) low = mid + 1; else high = mid - 1;
    }
    if (found < 0) {
      const key = asciiFold(needle);
      low = 0; high = this.index.count - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const cmp = byteOrder(this.lower[this.order[mid]],key);
        if (cmp === 0) { found = this.order[mid]; break; }
        if (cmp < 0) low = mid + 1; else high = mid - 1;
      }
    }
    if (found >= 0) push(found);
    const synIndex = this.synMap.get(asciiFold(needle));
    if (synIndex !== undefined && synIndex!==found) push(synIndex);
    if (results.length) return results.slice(0, limit);
    // Fall back to prefix matches so "read" still finds "reading".
    const key = asciiFold(needle);
    low = 0; high = this.index.count - 1;
    let start = this.index.count;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (byteOrder(this.lower[this.order[mid]],key)<0) low = mid + 1; else { start = mid; high = mid - 1; }
    }
    for (let i = start; i < this.index.count && results.length < limit; i++) {
      if (!this.lower[this.order[i]].startsWith(key)) break;
      push(this.order[i]);
    }
    return results;
  }
}
