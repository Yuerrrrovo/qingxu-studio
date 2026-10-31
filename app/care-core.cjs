(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.QingxuCareCore=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const RULE_VERSION='qingxu-self-report-1.0';
 const labels={continue:'继续训练',supplement:'补充资料',review:'专业复核',pause:'暂停活动'};
 const feeling={comfortable:'身体舒适',mild:'轻微不适',unwell:'明显不适',unknown:'不确定'};
 const fatigue={low:'精力尚好',medium:'有些疲惫',high:'很疲惫'};
 const sleep={good:'睡得不错',fair:'一般',poor:'睡眠不足 / 很差'};
 function day(value=new Date()){const d=new Date(value);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
 function week(value=new Date()){const d=new Date(value);d.setHours(12,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7));return day(d)}
 function validNumber(v,min,max){return typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max}
 function result(status,basis,missing=[]){return {status,label:labels[status],basis,missing,rule_version:RULE_VERSION,disclaimer:'按会员自报与档案进行提示，不是诊断、专业核验或训练许可。'}}
 function evaluate(input,profile,extras={}){
  input=input||{};profile=profile||{};const basis=[],missing=[],h=profile.health_information||{};
  if(input.symptoms==='urgent')return result('pause',['自报当前有胸痛、晕厥或明显呼吸困难等警示表现。','请停止活动，并及时寻求医疗帮助；症状严重或持续时立即求助。']);
  if(input.feeling==='unwell')return result('pause',['自报当前明显不适，先暂停活动，再确认原因或寻求专业帮助。']);
  if(feeling[input.feeling])basis.push('当次身体感受：'+feeling[input.feeling]);else missing.push('当次身体感受');
  if(fatigue[input.fatigue])basis.push('疲劳：'+fatigue[input.fatigue]);else missing.push('疲劳程度');
  if(sleep[input.sleepQuality])basis.push('昨晚睡眠感受：'+sleep[input.sleepQuality]);else missing.push('昨晚睡眠感受');
  if(validNumber(input.sleepHours,0,24))basis.push('昨晚睡眠：'+input.sleepHours+' 小时');else missing.push('昨晚睡眠时长');
  if(!['none','other','urgent'].includes(input.symptoms))missing.push('有无新增异常或伤痛');
  const restricted=h.status==='provided_details'||(h.activity_restrictions||[]).length>0||(h.professional_instructions||[]).length>0||['injury','chronic'].includes(extras.health_quick_choice);
  if(restricted||input.symptoms==='other'||input.feeling==='mild'){
   if(restricted)basis.push('档案含已有健康情况、专业意见或活动限制，需由专业人员确认适用安排。');
   if(input.symptoms==='other'||input.feeling==='mild')basis.push('自报新增伤痛或不适，需要先专业复核。');
   return result('review',basis,missing);
  }
  if(h.status!=='provided_none')missing.push('健康资料状态（可继续选择暂不提供，任务将保持待补充）');
  else basis.push('健康资料为本人自述无已知情况，未作专业核验。');
  if(input.fatigue==='high')missing.push('很疲惫：请先休息，并与现场指导人员补充确认本次安排');
  if(input.sleepQuality==='poor')missing.push('睡眠不足：请补充确认本次状态和安排');
  if(input.feeling==='unknown')missing.push('身体感受不确定，请先补充确认');
  return missing.length?result('supplement',basis,missing):result('continue',[...basis,'本次自报未触发预设暂停或复核条件；仅在原有专业安排内进行，途中不适随时停止。']);
 }
 function state(record,profile,extras={},now=new Date()){
  record=record||{};
  if(record.hold&&['pause','review'].includes(record.hold.status))return record.hold;
  const check=(record.checkins||[])[0];
  if(!check||day(check.created_at)!==day(now))return result('supplement',['今天还没有完成训练前状态填报。'],['填写身体感受、疲劳和昨晚睡眠']);
  if(check.profile_version!==profile.version)return result('supplement',['档案在本次核对后发生更新，需要按最新资料重新填报。'],['重新核对最新档案']);
  const post=(record.feedback||[]).find(f=>new Date(f.created_at)>=new Date(check.created_at));
  if(post&&post.result.status!=='continue')return post.result;
  return evaluate(check.input,profile,extras);
 }
 function hold(next,entry){const priority={review:1,pause:2};if(priority[entry.result.status]&&(priority[entry.result.status]>=(priority[next.hold?.status]||0)))next.hold={...entry.result,created_at:entry.created_at,record_id:entry.id}}
 function addCheckin(record,entry){const next=JSON.parse(JSON.stringify(record||{}));next.checkins=[entry,...(next.checkins||[])].slice(0,200);hold(next,entry);return next}
 function addFeedback(record,entry){const next=JSON.parse(JSON.stringify(record||{}));next.feedback=[entry,...(next.feedback||[]).filter(f=>f.checkin_id!==entry.checkin_id)].slice(0,200);hold(next,entry);return next}
 function goal(record,profile,plans=[],now=new Date()){
  const currentWeek=week(now);
  const ai=plans.find(p=>p.member_id===profile.member_id&&p.profile_version===profile.version&&week(p.created_at)===currentWeek&&p.plan?.status==='draft'&&p.plan.sessions?.length);
  if(ai)return {id:ai.id,source:'已保存 AI 草案',title:ai.plan.title,week:currentWeek,minutes:ai.plan.sessions.reduce((s,x)=>s+x.minutes,0),days:ai.plan.sessions.length,day_cap:Math.max(...ai.plan.sessions.map(x=>x.minutes)),profile_version:profile.version};
  const own=record?.goal;if(own&&own.week===currentWeek&&own.profile_version===profile.version)return own;
  return null;
 }
 function progress(record,target,risk,now=new Date()){
  if(!target)return {minutes:0,days:0,percent:0,points:0,locked:true,reason:'请先保存计划，或确认本周自定目标。'};
  const byDay=new Map();
  for(const f of record?.feedback||[]){
   if(f.goal_id!==target.id||week(f.created_at)!==week(now)||f.result.status!=='continue'||f.pre_status!=='continue'||!validNumber(f.minutes,0,600))continue;
   const key=day(f.created_at);byDay.set(key,Math.min(target.day_cap,(byDay.get(key)||0)+f.minutes));
  }
  const values=[...byDay.values()].filter(n=>n>0).sort((a,b)=>b-a).slice(0,target.days),minutes=Math.min(target.minutes,values.reduce((a,b)=>a+b,0));
  const percent=Math.min(100,Math.round(minutes/target.minutes*100)),locked=risk.status!=='continue';
  return {minutes,days:values.length,percent,points:percent,locked,reason:locked?'当前'+risk.label+'，任务进度冻结。':'依据关联目标的自报运动时长计算；超额运动不加分。'};
 }
 return {RULE_VERSION,labels,feeling,fatigue,sleep,day,week,evaluate,state,addCheckin,addFeedback,goal,progress,validNumber};
});
