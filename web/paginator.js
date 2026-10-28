/** Text location is a chapter character offset, independent of font and viewport. */
import {cleanHtml} from './formats.js';
export class Paginator {
  constructor(viewport,flow){this.viewport=viewport;this.flow=flow;this.page=0;this.pages=1;this.nodes=[];this.length=0;this.stride=1;}
  index(){this.nodes=[];let start=0;const walker=document.createTreeWalker(this.flow,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(node.textContent.length){this.nodes.push({node,start,end:start+node.length});start+=node.length;}}this.length=start;}
  async layout(html,offset=0,fixed=null,{clean=true}={}){
    const revision=this.layoutRevision=(this.layoutRevision||0)+1;
    if(html!==undefined)this.fixed=fixed;
    this.flow.classList.toggle('fixed-flow',!!this.fixed);this.viewport.classList.toggle('fixed-viewport',!!this.fixed);
    if(this.fixed){const {width=800,height=1100}=this.fixed;this.flow.style.width=width+'px';this.flow.style.height=height+'px';this.fixedScale=Math.min(this.viewport.clientWidth/width,this.viewport.clientHeight/height);}
    else{this.flow.style.width='';this.flow.style.height='';}
    // Chapters are already sanitised once by the parser; re-sanitising every reflow was pure
    // duplicate work on the page-turn path.
    if(html!==undefined){this.flow.innerHTML=clean?cleanHtml(html):html;this.index();}
    await document.fonts.ready;
    if(revision!==this.layoutRevision)return false;
    await Promise.all([...this.flow.querySelectorAll('img')].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=img.onerror=resolve;setTimeout(resolve,1200);})));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    if(revision!==this.layoutRevision||!this.viewport.isConnected)return false;
    this.flow.style.transform='none';this.page=0;
    const width=this.viewport.clientWidth,gap=parseFloat(getComputedStyle(this.flow).columnGap)||0;
    this.stride=width+gap;
    this.pages=this.fixed?1:Math.max(1,Math.ceil((this.flow.scrollWidth+gap-2)/this.stride));
    this.go(this.pageAt(offset));return this;
  }
  rectAt(offset){
    if(!this.nodes.length)return null;
    offset=Math.max(0,Math.min(this.length-1,offset));
    let low=0,high=this.nodes.length-1;while(low<high){const mid=(low+high)>>1;if(this.nodes[mid].end<=offset)low=mid+1;else high=mid;}
    const item=this.nodes[low],index=Math.min(item.node.length-1,Math.max(0,offset-item.start));const range=document.createRange();range.setStart(item.node,index);range.setEnd(item.node,index+1);return range.getBoundingClientRect();
  }
  pageAt(offset){if(this.fixed)return 0;const rect=this.rectAt(offset);if(!rect)return 0;return Math.max(0,Math.min(this.pages-1,Math.floor((rect.left-this.viewport.getBoundingClientRect().left+this.page*this.stride+1)/this.stride)));}
  go(page){this.page=Math.max(0,Math.min(this.pages-1,page));this.flow.style.transform=this.fixed?`scale(${this.fixedScale})`:`translateX(${-this.page*this.stride}px)`;return this.page;}
  anchor(){
    let low=0,high=Math.max(0,this.length-1);while(low<high){const mid=(low+high)>>1;if(this.pageAt(mid)<this.page)low=mid+1;else high=mid;}return low;
  }
  jumpId(id){const element=this.flow.querySelector(`[id="${CSS.escape(id)}"]`)||this.flow.querySelector(`[id="${CSS.escape('moyue-content-'+id)}"]`);if(!element)return false;const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);const n=walker.nextNode();const entry=this.nodes.find(x=>x.node===n);if(entry){this.go(this.pageAt(entry.start));return true;}return false;}
  selection(){
    const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
    const range=selection.getRangeAt(0);if(!this.flow.contains(range.startContainer)||!this.flow.contains(range.endContainer))return null;
    const pre=document.createRange();pre.selectNodeContents(this.flow);pre.setEnd(range.startContainer,range.startOffset);const start=pre.toString().length;
    return{start,end:start+range.toString().length,text:range.toString()};
  }
  highlight(start,end,id){
    const selected=this.nodes.filter(n=>n.end>start&&n.start<end).reverse();
    for(const item of selected){const a=Math.max(0,start-item.start),b=Math.min(item.node.length,end-item.start);if(a>=b||!item.node.parentNode)continue;const range=document.createRange();range.setStart(item.node,a);range.setEnd(item.node,b);const mark=document.createElement('mark');mark.dataset.note=id;range.surroundContents(mark);}
    this.index();
  }
  /** Temporary selection preview used while a highlight is being resized or extended. */
  preview(start,end){
    this.clearPreview();
    const selected=this.nodes.filter(n=>n.end>start&&n.start<end).reverse();
    for(const item of selected){const a=Math.max(0,start-item.start),b=Math.min(item.node.length,end-item.start);if(a>=b||!item.node.parentNode)continue;const range=document.createRange();range.setStart(item.node,a);range.setEnd(item.node,b);const mark=document.createElement('mark');mark.className='mark-preview';range.surroundContents(mark);}
    this.index();
  }
  clearPreview(){
    for(const mark of [...this.flow.querySelectorAll('mark.mark-preview')]){
      const parent=mark.parentNode;if(!parent)continue;
      while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);
      parent.removeChild(mark);parent.normalize?.();
    }
    this.index();
  }
}
