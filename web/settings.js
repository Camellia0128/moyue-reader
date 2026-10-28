export const defaults={size:23,line:1.75,margin:9,weight:400,font:'serif',align:'justify',theme:'paper',animation:'paper',brightness:-1,publisher:true,progress:0,clock:false,keepAwake:false,volume:true,dwell:125,refreshEvery:10,stroke:false,pdfContrast:1,systemScale:true,einkMode:false,pdfColor:false};
/** Keys a single book may override without touching the global profile. */
export const bookKeys=['size','line','margin','weight','font','align','publisher','stroke'];
export function normalizeSettings(raw){
  const result={...defaults};if(!raw||typeof raw!=='object')return result;
  const ranges={size:[14,42],line:[1.2,2.5],margin:[3,18],progress:[0,4],dwell:[60,200],refreshEvery:[0,40],pdfContrast:[1,1.6]};
  for(const [key,[min,max]] of Object.entries(ranges))if(Number.isFinite(raw[key]))result[key]=Math.max(min,Math.min(max,raw[key]));
  result.size=Math.round(result.size);result.progress=Math.round(result.progress);
  result.dwell=Math.round(result.dwell);result.refreshEvery=Math.round(result.refreshEvery);
  if(Number.isFinite(raw.brightness))result.brightness=raw.brightness<0?-1:Math.max(.02,Math.min(1,raw.brightness));
  const enums={weight:[400,600],font:['serif','sans'],align:['justify','left'],theme:['paper','warm','night'],animation:['paper','none']};
  for(const [key,values] of Object.entries(enums))if(values.includes(raw[key]))result[key]=raw[key];
  for(const key of ['publisher','clock','keepAwake','volume','stroke','systemScale','einkMode','pdfColor'])if(typeof raw[key]==='boolean')result[key]=raw[key];
  return result;
}
/** Merge a book profile over the global one; unknown keys are ignored. */
export function withBookProfile(global,profile){
  if(!profile||typeof profile!=='object')return global;
  const merged={...global};
  for(const key of bookKeys)if(profile[key]!==undefined)merged[key]=profile[key];
  if(typeof profile.customFont==='string')merged.customFont=profile.customFont;
  return merged;
}
export function pickBookProfile(settings){
  const profile={};for(const key of bookKeys)profile[key]=settings[key];
  if(settings.customFont)profile.customFont=settings.customFont;
  return profile;
}
