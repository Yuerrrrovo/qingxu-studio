'use strict';
const Motion=require('./motion.cjs');
function handler(config,{fetchImpl=fetch}={}){
 let active=false;const calls=[];
 return async(req,res,expected)=>{
  const send=(s,b)=>{if(res.destroyed)return;res.writeHead(s,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(b))};
  if(req.method==='GET'&&req.url==='/api/video/status')return send(200,{configured:!!config.localVision,source:'local_video_frames',max_segment_seconds:60});
  if(req.method!=='POST'||!['/api/video/analyze-batch','/api/video/calibrate','/api/video/reset'].includes(req.url))return send(404,{error:{message:'未找到视频复盘接口。'}});
  if(req.headers.origin!=='http://'+expected||req.headers['x-qingxu-video']!=='1')return send(403,{error:{message:'请从青序页面发起视频分析。'}});
  if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请使用 JSON 取样请求。'}});
  if(!config.localVision)return send(503,{error:{message:'请使用“启动含动作检测”入口，先启动本机视觉服务。'}});
  const reset=req.url.endsWith('/reset');if(active&&!reset)return send(429,{error:{message:'已有一段视频正在分析，请稍候。'}});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);res.on('close',()=>{if(!res.writableEnded)controller.abort()});if(!reset)active=true;
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>(reset?1024:req.url.endsWith('/calibrate')?360000:4200000))throw new Motion.MotionError('BODY_TOO_LARGE','这批视频取样过大，请降低视频分辨率。',413);chunks.push(chunk)}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new Motion.MotionError('BAD_JSON','无法读取本次视频请求。')}
   if(typeof body.session_id!=='string'||!/^video-[a-f0-9-]{36}$/.test(body.session_id))throw new Motion.MotionError('INVALID_VIDEO_SESSION','视频复盘会话无效。');
   if(reset)return send(200,await Motion.localAnalyze({session_id:body.session_id},config,{fetchImpl,signal:controller.signal,path:'/reset'}));
   if(body.consent!==true)throw new Motion.MotionError('CONSENT_REQUIRED','请先同意分析本次视频取样画面。',403);
   const now=Date.now();while(calls.length&&calls[0]<now-60000)calls.shift();if(calls.length>=900)throw new Motion.MotionError('VIDEO_RATE_LIMIT','本机分析较忙，请稍后再试。',429);
   const general=body.exercise==='general',exercise=general?'footwork':body.exercise;
   if(req.url.endsWith('/calibrate')){
    const request=Motion.prepare({...body,exercise});const p=body.points;if(general||!Array.isArray(p)||p.length!==3||p.some(v=>!Array.isArray(v)||v.length!==2||v.some(n=>!Number.isFinite(n))||v[0]<0||v[1]<0||v[0]>=request.frame.width||v[1]>=request.frame.height))throw new Motion.MotionError('INVALID_CALIBRATION','请在核心床画面内选择三个有效标定点。');
    calls.push(now);return send(200,await Motion.localAnalyze({...request,points:p},config,{fetchImpl,signal:controller.signal,path:'/calibrate'}));
   }
   const frames=Motion.prepareBatch({...body,exercise});if(frames.some((f,i)=>i&&f.elapsed_seconds-frames[i-1].elapsed_seconds>.501))throw new Motion.MotionError('VIDEO_GAP','视频取样间隔过大，请连续采集选段。');
   calls.push(...frames.map(()=>now));const results=[];for(const f of frames){if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');const r=await Motion.localAnalyze(f,config,{fetchImpl,signal:controller.signal});results.push(general?{version:r.version,sample_id:r.sample_id,source:'uploaded_video',pose:r.pose,observations:[],repetition_count:0}:r)}
   send(200,{version:'1.0',source:'uploaded_video',results});
  }catch(e){send(e.status||502,{error:{code:e.code||'VIDEO_ANALYSIS_FAILED',message:e instanceof Motion.MotionError?e.message:e.name==='AbortError'?'本次视频取样超时，请缩短片段再试。':'视频分析暂未完成，请检查本机视觉服务。'}})}finally{clearTimeout(timer);if(!reset)active=false}
 };
}
module.exports={handler};
