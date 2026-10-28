// Keep publisher typography without allowing book CSS to affect the application.
// Apply only whitelisted declarations to matching book elements, then sanitize HTML.
const properties=new Set(('font-style font-weight font-size font-family line-height text-align text-indent text-decoration text-transform letter-spacing word-spacing white-space vertical-align margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right border border-top border-bottom border-left border-right border-collapse border-spacing width height max-width max-height min-width display position left right top bottom float clear list-style-type page-break-before page-break-after break-before break-after break-inside column-span object-fit').split(' '));
export function safeStyle(value){
  const probe=document.createElement('span').style;probe.cssText=value;const result=[];
  for(const key of probe){const val=probe.getPropertyValue(key);if((properties.has(key)||key==='min-height')&&!/[\\@]|url\s*\(|expression|var\s*\(|env\s*\(/i.test(val)&&!(key==='position'&&/fixed|sticky/.test(val)))result.push(key+':'+val);}
  return result.join(';');
}
export function applyBookStyles(doc,sheets){
  const originals=[...doc.querySelectorAll('[style]')].map(n=>[n,n.getAttribute('style')]);
  for(const text of sheets){const sheet=new CSSStyleSheet();try{sheet.replaceSync(text);}catch{continue;}
    const walk=rules=>{for(const rule of rules){if(rule.selectorText&&rule.style){const selector=rule.selectorText;if(selector.length>1000||/:|\[\s*(?:on|src|href)/i.test(selector))continue;let nodes;try{nodes=doc.querySelectorAll(selector);}catch{continue;}const style=safeStyle(rule.style.cssText);for(const node of nodes)node.style.cssText+=';'+style;}else if(rule.cssRules&&rule.constructor.name!=='CSSFontFaceRule')walk(rule.cssRules);}};walk(sheet.cssRules);
  }
  for(const [node,style] of originals)node.style.cssText+=';'+safeStyle(style);
  for(const node of doc.querySelectorAll('[style]'))node.setAttribute('style',safeStyle(node.getAttribute('style')));
}
