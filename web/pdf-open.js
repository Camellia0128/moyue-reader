import {nativePdfAvailable,openNativePdf} from './native-pdf.js';
export async function openPdfDocument(bytes,{preferNative=false,signal,bytesLoader}={}){
  if(preferNative&&nativePdfAvailable())return openNativePdf(bytes,{signal,bytesLoader});
  try{const {openPdf}=await import('./pdf.js');return await openPdf(bytes.slice(),undefined,{signal});}
  catch(error){if(signal?.aborted)throw error;if(nativePdfAvailable())return openNativePdf(bytes,{signal,bytesLoader});throw error;}
}
