'use strict';
class MotionError extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status}}
const codes=['general','footwork','straps','pelvic','shortbox','chest'];
const visionActions={footwork:'footwork',straps:'feet_in_straps',pelvic:'pelvic_curl',shortbox:'short_box',chest:'chest_expansion'};
function localRequest(body){
 const request=prepare(body),action=visionActions[request.exercise];if(!action)throw new MotionError('INVALID_MOTION_REQUEST','本机 Reformer 分析需要先选择五个具体动作之一。');
 return {...request,exercise:action};
}
function validScore(value){return value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100}
function validReformer(value){if(value===undefined)return;if(!value||!['completed','in_progress','needs_calibration','insufficient_data'].includes(value.assessment_status)||!validScore(value.score)||typeof value.calibrated!=='boolean'||!Array.isArray(value.deductions)||!Array.isArray(value.missing_measurements)||typeof value.live_cue!=='string'||(value.assessment_status==='completed')!==(value.score!==null)||(value.score!==null&&!value.calibrated))throw new MotionError('INVALID_MOTION_RESPONSE','本机视觉返回的评分信息不完整。',502);return {assessment_status:value.assessment_status,score:value.score,calibrated:value.calibrated,state:typeof value.state==='string'?value.state.slice(0,40):'',live_cue:value.live_cue.slice(0,500),deductions:value.deductions,missing_measurements:value.missing_measurements.map(x=>String(x).slice(0,100)).slice(0,20)}}
function prepare(body){
 if(!body||body.version!=='1.0'||typeof body.session_id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(body.session_id)||!codes.includes(body.exercise))throw new MotionError('INVALID_MOTION_REQUEST','动作分析请求格式不完整。');
 const f=body.frame;if(!f||f.mime!=='image/jpeg'||!Number.isInteger(f.width)||!Number.isInteger(f.height)||f.width<1||f.height<1||f.width>640||f.height>640||typeof f.data!=='string'||f.data.length>340000||!/^[A-Za-z0-9+/]+={0,2}$/.test(f.data)||!Buffer.from(f.data,'base64').subarray(0,3).equals(Buffer.from([255,216,255])))throw new MotionError('INVALID_FRAME','请提供不超过 640px 的 JPEG 取样帧。');
 return {version:'1.0',session_id:body.session_id,exercise:body.exercise,sample_id:String(body.sample_id||'').slice(0,80),elapsed_seconds:Math.max(0,Math.min(36000,Number(body.elapsed_seconds)||0)),frame:{mime:f.mime,width:f.width,height:f.height,data:f.data}};
}
function normalize(raw,request){
 if(!raw||raw.version!=='1.0'||raw.sample_id!==request.sample_id||!Array.isArray(raw.observations)||raw.observations.length>8||!['none','review','pause'].includes(raw.safety))throw new MotionError('INVALID_MOTION_RESPONSE','动作服务返回格式不符合接口约定，本次未记录分析。',502);
 const observations=raw.observations.map(o=>{if(!o||!['positive','improve','uncertain'].includes(o.kind)||typeof o.text!=='string'||!o.text.trim()||o.text.length>300||typeof o.confidence!=='number'||!Number.isFinite(o.confidence)||o.confidence<0||o.confidence>1)throw new MotionError('INVALID_MOTION_RESPONSE','动作反馈缺少有效内容或置信度。',502);return {kind:o.confidence<.6?'uncertain':o.kind,text:o.text.trim(),confidence:o.confidence}});
 if(raw.safety!=='none'&&(typeof raw.safety_reason!=='string'||!raw.safety_reason.trim()))throw new MotionError('INVALID_MOTION_RESPONSE','动作提示缺少依据。',502);
 const result={version:'1.0',sample_id:request.sample_id,source:'motion_service',observations,safety:raw.safety,safety_reason:typeof raw.safety_reason==='string'?raw.safety_reason.slice(0,300):'',analyzed_at:new Date().toISOString()};
 if(Number.isInteger(raw.repetition_count)&&raw.repetition_count>=0&&raw.repetition_count<=10000)result.repetition_count=raw.repetition_count;
 const reformer=validReformer(raw.reformer);if(reformer)result.reformer=reformer;
 if(raw.pose!==undefined){
  const p=raw.pose;
  if(!p||typeof p.detected!=='boolean'||typeof p.source_gap!=='boolean'||!Array.isArray(p.landmarks)||![0,33].includes(p.landmarks.length)||p.landmarks.some(v=>!Array.isArray(v)||v.length!==3||v.some(n=>typeof n!=='number'||!Number.isFinite(n))||v[0]<-2||v[0]>3||v[1]<-2||v[1]>3||v[2]<0||v[2]>1))throw new MotionError('INVALID_MOTION_RESPONSE','人体检测结果无效。',502);
  result.pose={detected:p.detected,source_gap:p.source_gap,landmarks:p.landmarks};
 }
 return result;
}
function prepareBatch(body){
 if(!Array.isArray(body?.frames)||body.frames.length<1||body.frames.length>12)throw new MotionError('INVALID_BATCH','每批需要 1–12 张取样帧。');
 const frames=body.frames.map(f=>{
  if(typeof f.elapsed_seconds!=='number'||!Number.isFinite(f.elapsed_seconds)||f.elapsed_seconds<0||f.elapsed_seconds>36000)throw new MotionError('INVALID_BATCH','取样必须包含有效的真实源时间。');
  localRequest({...f,version:body.version,session_id:body.session_id,exercise:body.exercise});
  return prepare({...f,version:body.version,session_id:body.session_id,exercise:body.exercise});
 });
 const ids=new Set();let previous=-1;
 for(const frame of frames){if(!frame.sample_id||ids.has(frame.sample_id)||frame.elapsed_seconds<=previous)throw new MotionError('INVALID_BATCH','取样编号与真实源时间必须唯一且递增。');ids.add(frame.sample_id);previous=frame.elapsed_seconds}
 return frames;
}
async function analyze(body,config,{fetchImpl=fetch,signal}={}){
 if(config.localVision)return localAnalyze(body,config,{fetchImpl,signal});
 if(!config.motionUrl||!config.motionKey)throw new MotionError('MOTION_NOT_CONFIGURED','动作分析接口尚未配置，可以继续计时与自报记录。',503);
 let url;try{url=new URL(config.motionUrl)}catch{throw new MotionError('MOTION_CONFIG_INVALID','动作接口地址无效。',503)}
 if((url.protocol!=='https:'&&!(config.motionLocal&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))||url.username||url.password||url.hash)throw new MotionError('MOTION_CONFIG_INVALID','动作接口需使用不含凭证的 HTTPS 地址。',503);
 const request=prepare(body),reply=await fetchImpl(url.href,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.motionKey},body:JSON.stringify(request),signal,redirect:'error'});
 if(!reply.ok)throw new MotionError('MOTION_UPSTREAM_FAILED','动作服务暂不可用，请检查配置或稍后重试；训练计时不受影响。',502);
 const reader=reply.body?.getReader();if(!reader)throw new MotionError('INVALID_MOTION_RESPONSE','动作服务返回为空。',502);let chunks=[],size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32768){await reader.cancel();throw new MotionError('INVALID_MOTION_RESPONSE','动作反馈过长，本次未采用。',502)}chunks.push(Buffer.from(part.value))}
 let raw;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new MotionError('INVALID_MOTION_RESPONSE','动作服务未返回有效 JSON。',502)}return normalize(raw,request);
}
async function localAnalyze(body,config,{fetchImpl=fetch,signal,path='/analyze'}={}){
 if(!config.localVision)throw new MotionError('MOTION_NOT_CONFIGURED','本机视觉服务尚未配置。',503);
 let url;try{url=new URL(config.localVision)}catch{throw new MotionError('MOTION_CONFIG_INVALID','本机视觉地址无效。',503)}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.hash||url.search||url.pathname!=='/')throw new MotionError('MOTION_CONFIG_INVALID','本机视觉仅允许回环地址。',503);
 let request;
 if(path==='/reset'){
  if(!body||typeof body.session_id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(body.session_id))throw new MotionError('INVALID_MOTION_REQUEST','训练会话无效。');
  request={session_id:body.session_id};
 }else request=localRequest(body);
 const headers={'Content-Type':'application/json','X-Qingxu-Vision':'local-reformer-v1'};
 let reply;try{reply=await fetchImpl(url.origin+path,{method:'POST',headers,body:JSON.stringify(path==='/calibrate'?{...request,points:body.points}:request),signal,redirect:'error'})}catch(error){if(error.name==='AbortError')throw error;throw new MotionError('MOTION_UPSTREAM_FAILED','本机视觉服务未启动，请先运行整合版启动脚本。',503)}
 const raw=await reply.json().catch(()=>null);if(!reply.ok)throw new MotionError('MOTION_UPSTREAM_FAILED',typeof raw?.message==='string'?raw.message.slice(0,300):'本机视觉分析未完成，请检查侧视画面与标定。',502);
 if(path==='/reset')return {reset:raw?.reset===true};
 if(path==='/calibrate'){
  if(raw?.calibrated!==true)throw new MotionError('INVALID_MOTION_RESPONSE','本机视觉未确认标定成功。',502);
  return {calibrated:true};
 }
 return normalize(raw,request);
}
function handler(config,{fetchImpl=fetch}={}){
 let active=0;const calls=[];
 return async(req,res,expected)=>{
  const send=(status,body)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
  if(req.method==='GET'&&req.url==='/api/motion/status'){send(200,{configured:!!(config.motionUrl&&config.motionKey||config.localVision),version:'1.0',sample_interval_seconds:config.localVision ? 0.2 : 6,calibration:!!config.localVision,batch:!!config.localVision});return}
  if(req.method==='POST'&&req.url==='/api/motion/reset'&&config.localVision){
   if(req.headers.origin!=='http://'+expected||req.headers['x-qingxu-motion']!=='1')return send(403,{error:{code:'ORIGIN_REJECTED',message:'请从本机青序训练页面发起请求。'}});
   if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请求必须为 JSON。'}});
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
   try{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>1024)throw new MotionError('BODY_TOO_LARGE','清理请求过大。',413);chunks.push(chunk)}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new MotionError('BAD_JSON','无法读取清理请求。')}
    send(200,await localAnalyze(body,config,{fetchImpl,signal:controller.signal,path:'/reset'}));
   }catch(error){send(error.status||502,{error:{code:error.code||'RESET_FAILED',message:error instanceof MotionError?error.message:'本机视觉会话清理未完成。'}})}finally{clearTimeout(timer)}return;
  }
  if(req.method==='POST'&&req.url==='/api/motion/calibrate'&&config.localVision){
   if(req.headers.origin!=='http://'+expected||req.headers['x-qingxu-motion']!=='1')return send(403,{error:{code:'ORIGIN_REJECTED',message:'请从本机青序训练页面发起请求。'}});
   if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请求必须为 JSON。'}});
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
   try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>360000)throw new MotionError('BODY_TOO_LARGE','标定帧过大，请缩小画面。',413);chunks.push(chunk)}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));const points=body.points;if(!Array.isArray(points)||points.length!==3||points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>640)))throw new MotionError('INVALID_CALIBRATION','请依次选择床架固定点 A、B 和滑车点 C。');send(200,await localAnalyze(body,config,{fetchImpl,signal:controller.signal,path:'/calibrate'}))}catch(error){send(error.status||502,{error:{code:error.code||'CALIBRATION_FAILED',message:error instanceof MotionError?error.message:'标定未完成，请检查画面后重试。'}})}finally{clearTimeout(timer)}return;
  }
  const batch=req.url==='/api/motion/analyze-batch'&&!!config.localVision;
  if(req.method!=='POST'||(!batch&&req.url!=='/api/motion/analyze')){send(404,{error:{message:'未找到动作接口。'}});return}
  if(req.headers.origin!=='http://'+expected||req.headers['x-qingxu-motion']!=='1')return send(403,{error:{code:'ORIGIN_REJECTED',message:'请从本机青序训练页面发起请求。'}});
  if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请求必须为 JSON。'}});
  const now=Date.now();while(calls.length&&calls[0]<now-60000)calls.shift();if(active>=1||calls.length>=(config.localVision?360:12))return send(429,{error:{message:'动作取样过于频繁，请稍后重试。'}});
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);res.on('close',()=>{if(!res.writableEnded)controller.abort()});
  try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(batch?4200000:360000))throw new MotionError('BODY_TOO_LARGE','取样帧过大，请缩小画面。',413);chunks.push(chunk)}let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new MotionError('BAD_JSON','无法读取动作请求。')}
   const frames=batch?prepareBatch(body):[prepare(body)];
   if(calls.length+frames.length>(config.localVision?360:12))throw new MotionError('RATE_LIMIT','动作取样过于频繁，请稍后重试。',429);
   calls.push(...frames.map(()=>now));
   const results=[];for(const frame of frames){if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');results.push(await analyze(frame,config,{fetchImpl,signal:controller.signal}));if(results.at(-1).safety!=='none')break}
   send(200,batch?{version:'1.0',source:'motion_service',results}:results[0]);
  }
  catch(error){send(error.status||502,{error:{code:error.code||'MOTION_FAILED',message:error instanceof MotionError?error.message:error.name==='AbortError'?'动作分析超时，已停止取样，请重试。':'动作分析未完成，已停止取样；请检查服务后重试。'}})}finally{clearTimeout(timer);active--}
 };
}
module.exports={MotionError,prepare,prepareBatch,normalize,analyze,localAnalyze,handler};
