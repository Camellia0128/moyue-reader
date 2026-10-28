import {get,putDict} from './storage.js';
import {parseIdx,parseSyn,inflateDict,StarDict,decodeEntry} from './dict.js';
let cached=null,chain=Promise.resolve();
// Only the compact index stays resident; individual definitions are sliced from the disk Blob.
class LazyDictionary extends StarDict{entryAt(i){return String(i);}}
async function open(record){
  if(cached?.id===record.id&&cached.record.idxBlob.size===record.idxBlob.size&&cached.record.dictBlob.size===record.dictBlob.size)return cached;
  cached=null;
  if(record.compressed){const raw=inflateDict(await record.dictBlob.arrayBuffer(),true);record={...record,dictBlob:new Blob([raw]),dictBytes:raw.length,compressed:false,wasCompressed:true};await putDict(record);}
  const idx=parseIdx(await record.idxBlob.arrayBuffer(),record.wordcount),syn=record.synBlob?parseSyn(await record.synBlob.arrayBuffer(),record.wordcount):null;
  const dictionary=new LazyDictionary(record,record.meta,idx,record.dictBlob,syn);cached=dictionary;return dictionary;
}
async function run(type,p){
  if(type==='import'){
    cached=null;const {meta,idxBuffer,dictBuffer,synBuffer,compressed}=p;
    const idx=parseIdx(idxBuffer,meta.wordcount);if(meta.idxfilesize!==idxBuffer.byteLength)throw Error('词典索引大小与声明不符');
    const data=inflateDict(dictBuffer,compressed),syn=synBuffer?parseSyn(synBuffer,meta.wordcount):null;
    const probe=new StarDict({id:'probe'},meta,idx,data,syn);if(!probe.entryAt(0))throw Error('词典第一条释义不可读');
    const record={id:crypto.randomUUID(),name:meta.bookname,meta,wordcount:idx.count,idxBytes:idxBuffer.byteLength,dictBytes:data.length,compressed:false,wasCompressed:compressed,added:Date.now(),idxBlob:new Blob([idxBuffer]),dictBlob:new Blob([data]),synBlob:synBuffer?new Blob([synBuffer]):undefined};
    await putDict(record);return{id:record.id};
  }
  if(type==='lookup'){
    const record=await get('dicts',p.id);if(!record)throw Error('词典记录不存在');const dict=await open(record),out=[];
    for(const hit of dict.lookup(p.word)){const i=Number(hit.definition),offset=dict.index.offsets[i],size=dict.index.sizes[i];if(size>2*1024*1024)throw Error('单条释义超过 2 MB');const bytes=new Uint8Array(await dict.dictBytes.slice(offset,offset+size).arrayBuffer());const definition=decodeEntry(bytes,record.meta.sametypesequence);if(definition)out.push({word:hit.word,definition:definition.slice(0,8000),dictId:p.id,dictName:dict.name});}
    return out;
  }
  if(type==='release'){cached=null;return true;}throw Error('未知词典任务');
}
self.onmessage=({data})=>{chain=chain.then(async()=>{try{self.postMessage({id:data.id,value:await run(data.type,data.payload)});}catch(error){self.postMessage({id:data.id,error:error.message});}});};
