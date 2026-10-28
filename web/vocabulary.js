export const DAY=86400000;
export function reviewSchedule(item,result,now=Date.now()){
  const success=result==='known',streak=success?Math.min(12,(item.streak||0)+1):0;
  const interval=success?[1,3,7,14,30,60,120][Math.min(streak-1,6)]*DAY:10*60000;
  return {...item,state:success?'known':'review',streak,due:now+interval,lastReview:now,reviews:[...(item.reviews||[]),{at:now,result}].slice(-50)};
}
export function resetLearning(item){return {...item,state:'new',streak:0,due:0,lastReview:0,reviews:[]};}
export function isDue(item,now=Date.now()){return item.state!=='known'&&!item.due||Number.isFinite(item.due)&&item.due<=now;}
