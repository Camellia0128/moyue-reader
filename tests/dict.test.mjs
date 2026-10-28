import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'fflate';
import {StarDict,decodeEntry,inflateDict,parseIdx,parseSyn,stardictCompare} from '../web/dict.js';
const enc=new TextEncoder();
function fixture(words){
 words.sort((a,b)=>Buffer.compare(Buffer.from(a.replace(/[A-Z]/g,c=>c.toLowerCase())),Buffer.from(b.replace(/[A-Z]/g,c=>c.toLowerCase())))||Buffer.compare(Buffer.from(a),Buffer.from(b)));
 const chunks=[];let at=0;const offsets=[],sizes=[];
 for(const word of words){const text=enc.encode('释义 '+word);offsets.push(at);sizes.push(text.length);chunks.push(text);at+=text.length;}
 return new StarDict({id:'test'},{bookname:'测试',sametypesequence:'m'},{words,count:words.length,offsets:Uint32Array.from(offsets),sizes:Uint32Array.from(sizes)},Buffer.concat(chunks));
}
test('StarDict matches its specified ASCII-folded UTF-8 order, including exact case and non-BMP',()=>{
 const words=['A','a','B','Z','中','国','阿','Ä','ä','é','É','z-1','z1','Z_a','_z','!z','2z','💡','𐀀','\uE000'];const dict=fixture(words);
 assert.deepEqual([...words].sort(stardictCompare),words);
 for(const word of words)assert.equal(dict.lookup(word)[0]?.word,word,word);
 assert.equal(dict.lookup('z-')[0]?.word,'z-1');
});
test('StarDict separates null-terminated phonetics from the final definition',()=>{
 assert.equal(decodeEntry(enc.encode('pronunciation\0meaning'),'tm'),'pronunciation\nmeaning');
});
test('StarDict skips length-prefixed binary fields and continues decoding text',()=>{
 assert.equal(decodeEntry(Uint8Array.from([80,0,0,0,3,0,1,2,109,111,107,0]),''),'ok');
 assert.equal(decodeEntry(Uint8Array.from([0,0,0,3,0,1,2,111,107]),'Pm'),'ok');
 assert.throws(()=>decodeEntry(Uint8Array.from([80,0,0,0,99]),''),/长度/);
});
test('StarDict rejects trailing truncated index data rather than silently accepting it',()=>{
 const valid=Buffer.concat([Buffer.from('a\0'),Buffer.alloc(8)]);assert.equal(parseIdx(valid,1).count,1);
 assert.throws(()=>parseIdx(Buffer.concat([valid,Buffer.from('garbage')]),1),/截断/);
});
test('StarDict validates every definition offset rather than only the first entry',()=>{
 assert.throws(()=>new StarDict({id:'bad'},{sametypesequence:'m'},{words:['a','b'],count:2,offsets:Uint32Array.from([0,40]),sizes:Uint32Array.from([1,4])},enc.encode('ok')),/缺失/);
});
test('StarDict rejects truncated and out-of-range synonym indexes',()=>{
 assert.throws(()=>parseSyn(Buffer.from('abc'),1),/截断/);
 const idx=Buffer.alloc(4);idx.writeUInt32BE(4);assert.throws(()=>parseSyn(Buffer.concat([Buffer.from('a\0'),idx]),2),/无效/);
});
test('Compressed StarDict round-trips without an unbounded output allocation',()=>{
 const original=enc.encode('真实释义。'.repeat(5000));assert.deepEqual(inflateDict(gzipSync(original),true),original);
 const lied=gzipSync(original);new DataView(lied.buffer,lied.byteOffset+lied.length-4,4).setUint32(0,1,true);assert.throws(()=>inflateDict(lied,true),/长度/);
 const huge=gzipSync(enc.encode('ok'));new DataView(huge.buffer,huge.byteOffset+huge.length-4,4).setUint32(0,161*1024*1024,true);assert.throws(()=>inflateDict(huge,true),/160 MB/);
 const corrupt=gzipSync(original);corrupt[corrupt.length-8]^=1;assert.throws(()=>inflateDict(corrupt,true),/校验/);
});
test('Uncompressed dictionaries obey the same 160 MB budget',()=>{
 assert.throws(()=>inflateDict(new Uint8Array(161*1024*1024),false),/160 MB/);
});
