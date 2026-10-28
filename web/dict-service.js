let worker,seq=0,idle;const jobs=new Map();
function stop(reason='词典处理已取消'){clearTimeout(idle);worker?.terminate();worker=null;for(const p of jobs.values()){clearTimeout(p.timer);p.reject(new DOMException(reason,'AbortError'));}jobs.clear();}
export const cancelDictionaryWork=()=>stop();
export function dictionaryJob(type,payload,transfer=[]){
  if(!worker){worker=new Worker(new URL('./dict-worker.js',location.href),{type:'module'});worker.onmessage=({data})=>{const p=jobs.get(data.id);if(!p)return;jobs.delete(data.id);clearTimeout(p.timer);data.error?p.reject(new Error(data.error)):p.resolve(data.value);if(!jobs.size){clearTimeout(idle);idle=setTimeout(()=>stop('词典缓存已释放'),120000);}};worker.onerror=()=>stop('词典后台进程未能完成，请重试');}
  clearTimeout(idle);return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>stop('词典处理超时，请检查文件后重试'),120000);jobs.set(id,{resolve,reject,timer});worker.postMessage({id,type,payload},transfer);});
}
