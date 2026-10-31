(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./care-core.cjs'));else root.QingxuTrainingCore=factory(root.QingxuCareCore)})(typeof globalThis!=='undefined'?globalThis:this,function(Care){
 'use strict';
 const exercises=['general','footwork','straps','pelvic','shortbox','chest'];
 const exerciseLabels={footwork:'足部推蹬系列',straps:'双腿套绳系列',pelvic:'骨盆卷动与桥式',shortbox:'短盒系列',chest:'胸部扩展'};
 const copy=v=>JSON.parse(JSON.stringify(v));
 function context(record,profile,extras={},plans=[],now=new Date()){
  record=record||{};const risk=Care.state(record,profile,extras,now),target=Care.goal(record,profile,plans,now),progress=Care.progress(record,target,risk,now),check=record.checkins?.[0];
  let daily=0;for(const f of record.feedback||[])if(target&&f.goal_id===target.id&&Care.day(f.created_at)===Care.day(now)&&f.pre_status==='continue'&&f.result.status==='continue'&&Care.validNumber(f.minutes,0,600))daily+=f.minutes;
  const remaining=target?Math.max(0,Math.min(target.day_cap-Math.min(target.day_cap,daily),target.minutes-progress.minutes)):0;
  let reason='';if(risk.status!=='continue')reason='当前为“'+risk.label+'”，请先处理今日状态。';else if(!target)reason='先确认本周目标，再开始今天的记录。';else if(remaining<=0)reason=progress.percent>=100?'本周目标已完成，给恢复也留一点空间。':'今天的目标已记录，不必为了积分继续加量。';else if((record.feedback||[]).some(f=>f.checkin_id===check?.id))reason='本次状态已有离店记录。需要新开一次训练时，请先更新训练前状态。';
  return {risk,target,progress,check,remaining,eligible:!reason,reason};
 }
 function arrangement(ctx,plans=[],index=0){
  const saved=plans.find(p=>p.id===ctx.target?.id),session=saved?.plan.sessions?.[index];
  return session?{title:session.label+' · '+session.focus,source:'来自已保存 AI 草案 · 按适用指导确认',minutes:Math.min(session.minutes,ctx.remaining),blocks:copy(session.blocks)}:{title:'今日 · 自主训练记录',source:'会员自定目标 · 不自动安排动作处方',minutes:ctx.remaining,blocks:[{name:'按已确认的安排训练',detail:'选择熟悉且适合自己的内容；具体动作、器械设置与休息由适用专业安排和现场指导确认。',minutes:ctx.remaining}]};
 }
 function create(record,profile,extras,plans,options,now=new Date()){
  const ctx=context(record,profile,extras,plans,now),recordOnly=options.skipStatus===true;if(recordOnly?ctx.risk.status!=='supplement':!ctx.eligible)throw Error(ctx.reason||'当前状态不能跳过核对。');
  if((record.sessions||[]).some(s=>['running','paused','review'].includes(s.status)))throw Error('还有一份训练记录待完成，请先继续或复盘。');
  const plan=recordOnly?{title:'自主计时与记录',source:'今日状态待补充 · 仅记录',minutes:null,blocks:[{name:'保留自己的运动记录',detail:'此模式只计时与自报，不提供训练许可、动作处方或任务积分；具体活动按适用的专业安排确认。'}]}:arrangement(ctx,plans,options.planIndex||0),minutes=recordOnly?null:Number(options.minutes);
  if(!recordOnly&&(!Number.isInteger(minutes)||minutes<1||minutes>plan.minutes))throw Error('今日分钟需在当前安排和剩余目标范围内。');
  if(!exercises.includes(options.exercise)||!['reformer','mat','barrel','treadmill','bike','rower','weights'].includes(options.activity||'reformer')||((options.activity||'reformer')!=='reformer'&&options.exercise!=='general'))throw Error('请选择匹配的运动项目与动作观察内容。');
  if(!recordOnly&&ctx.target.source!=='已保存 AI 草案'&&exerciseLabels[options.exercise]){plan.title=exerciseLabels[options.exercise]+' · 自主记录';plan.blocks[0].name='本次关注：'+exerciseLabels[options.exercise]}
  return {id:options.id,member_id:profile.member_id,profile_version:profile.version,goal_id:recordOnly?null:ctx.target.id,checkin_id:recordOnly?'unverified-'+options.id:ctx.check.id,record_only:recordOnly,sleep_snapshot:recordOnly?copy(ctx.check?.input||{}):undefined,created_at:now.toISOString(),status:'running',elapsed_seconds:0,today_goal:minutes,exercise:options.exercise,activity:options.activity||'reformer',arrangement:plan,observations:[],before_progress:ctx.progress.percent};
 }
 function advance(session,seconds){if(session.status!=='running')return session;const s=copy(session);s.elapsed_seconds=Math.min((s.today_goal===null?36000:s.today_goal*60),s.elapsed_seconds+Math.max(0,Math.min(10,seconds)));if(s.elapsed_seconds>=(s.today_goal===null?36000:s.today_goal*60)){s.status='paused';s.pause_reason='目标计时已到，准备记录感受并复盘。'}return s}
 function withSessionHold(record,session){const next=copy(record),priority={review:1,pause:2},hold=session.safety_hold;if(priority[hold?.status]&&(priority[next.hold?.status]||0)<=priority[hold.status])next.hold=copy(hold);return next}
 function canResume(session,ctx,profile,now=new Date()){
  return !session.safety_hold&&(session.record_only?['continue','supplement'].includes(ctx.risk.status):ctx.risk.status==='continue'&&ctx.target?.id===session.goal_id&&ctx.check?.id===session.checkin_id)&&session.profile_version===profile.version&&Care.day(session.created_at)===Care.day(now)&&session.elapsed_seconds<(session.today_goal===null?36000:session.today_goal*60)&&session.status==='paused';
 }
 function complete(record,session,review,profile,extras={},plans=[],now=new Date()){
  if(session.member_id!==profile.member_id)throw Error('账号已变化，请重新打开当前账号的训练。');
  const stored=(record.sessions||[]).find(s=>s.id===session.id);if(stored?.status==='completed')return {record,session:stored,idempotent:true};
  if(!stored||!['running','paused','review'].includes(stored.status))throw Error('训练记录已变化，请刷新后查看。');
  const input=review.input||{},urgent=input.feeling==='unwell'||input.symptoms==='urgent',minutes=review.minutes;
  if(!Care.validNumber(minutes,0,600)||!Number.isInteger(minutes))throw Error('实际分钟请填写 0–600 的整数；未运动可以填 0。');
  if(!urgent&&(!Care.feeling[input.feeling]||!Care.fatigue[input.fatigue]||!['none','other','urgent'].includes(input.symptoms)||(!session.record_only&&(!Care.sleep[input.sleepQuality]||!Care.validNumber(input.sleepHours,0,24)))))throw Error('请补充身体感受、疲劳和异常情况；睡眠可复用训练前记录。');
  record=withSessionHold(record,session);
  const ctx=context(record,profile,extras,plans,now),after=Care.evaluate(input,profile,extras),same=ctx.check?.id===session.checkin_id&&ctx.target?.id===session.goal_id&&profile.version===session.profile_version&&Care.day(session.created_at)===Care.day(now),pre=!session.record_only&&same?ctx.risk.status:'supplement';
  const summary='今日'+(session.activity==='reformer'?'普拉提':'运动')+'自报 '+minutes+' 分钟；计时 '+Math.floor(session.elapsed_seconds/60)+' 分 '+Math.floor(session.elapsed_seconds%60)+' 秒；'+(Care.fatigue[input.fatigue]||'疲劳未填')+'。'+(pre==='continue'&&after.status==='continue'?'按关联目标更新本周记录。':'本次保留复盘，任务不增加进度。');
  const entry={id:'training-'+session.id,training_session_id:session.id,member_id:profile.member_id,profile_version:profile.version,created_at:now.toISOString(),source:'member_report',checkin_id:session.checkin_id,pre_status:pre,goal_id:session.goal_id,activity:session.activity,minutes,diet:review.diet||'unknown',input:copy(input),result:after,summary};
  let next=Care.addFeedback(record,entry);const effective=Care.state(next,profile,extras,now),target=ctx.target,progress=Care.progress(next,target,effective,now),gained=Math.max(0,progress.points-ctx.progress.points),counted=pre==='continue'&&after.status==='continue'&&effective.status==='continue'&&same;
  const done={...copy(session),status:'completed',completed_at:now.toISOString(),actual_minutes:minutes,review:copy(review),result:after,summary,counted,points_gained:gained,week_percent:progress.percent,achievement:effective.status==='pause'||effective.status==='review'?'照顾身体，也是重要的一步。':!counted?'认真记录，让下一次更有依据。':session.today_goal!==null&&minutes>=session.today_goal?'今天的小目标，完成了。':minutes>0?'这 '+minutes+' 分钟，也算数。':'为今天留下一份真实记录。'};
  next.sessions=[done,...(next.sessions||[]).filter(s=>s.id!==done.id)].slice(0,100);return {record:next,session:done,progress};
 }
 function recap(record,session,profile,extras={},plans=[],now=new Date()){
  const f=(record.feedback||[]).find(f=>f.checkin_id===session.checkin_id);if(!f)return session;
  const ctx=context(record,profile,extras,plans,now),effective=['pause','review'].includes(ctx.risk.status)?ctx.risk:f.result,same=ctx.target?.id===session.goal_id,counted=f.pre_status==='continue'&&f.result.status==='continue',minutes=f.minutes||0;
  const without={...record,feedback:(record.feedback||[]).filter(item=>item.id!==f.id)},before=Care.progress(without,ctx.target,ctx.risk,now);
  return {...session,actual_minutes:minutes,result:effective,review:{input:f.input,diet:f.diet},summary:f.summary,counted,points_gained:same?Math.max(0,ctx.progress.points-before.points):session.points_gained,week_percent:same?ctx.progress.percent:session.week_percent,progress_label:same?'当前本周进度':'保存时本周进度',achievement:effective.status==='pause'||effective.status==='review'?'照顾身体，也是重要的一步。':!counted?'认真记录，让下一次更有依据。':session.today_goal!==null&&minutes>=session.today_goal?'今天的小目标，完成了。':minutes>0?'这 '+minutes+' 分钟，也算数。':'为今天留下一份真实记录。'};
 }
 return {exercises,context,arrangement,create,advance,canResume,complete,recap,withSessionHold};
});
