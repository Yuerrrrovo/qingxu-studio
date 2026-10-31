'use strict';
const {prepare}=require('./motion.cjs');
const routes=new Set(['/api/camera/start','/api/camera/frame','/api/camera/stop','/api/camera/pose']);
function handler(config,{fetchImpl=fetch}={}){
 let active=0;
 return async(req,res,expected)=>{
  const send=(status,body)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}};
  if(!routes.has(req.url)||req.method!=='POST')return send(404,{error:{message:'未找到相机接口。'}});
  if(req.headers.origin!=='http://'+expected||req.headers['x-qingxu-camera']!=='1')return send(403,{error:{message:'请从电脑上的青序网页连接外接摄像头。'}});
  if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请求必须为 JSON。'}});
  let target;try{target=new URL(config.localVision);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password||target.search||target.hash||target.pathname!=='/')throw Error()}catch{return send(503,{error:{message:'请通过整合版启动入口运行本机视觉服务。'}})}
  if(active>=4)return send(429,{error:{message:'相机请求较多，请稍候。'}});
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  res.on('close',()=>{if(!res.writableEnded)controller.abort()});
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>(req.url.endsWith('/pose')?360000:2048)){const error=Error('相机请求过大。');error.status=413;throw error}chunks.push(chunk)}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{const error=Error('无法读取相机请求。');error.status=400;throw error}
   let data;
   if(req.url.endsWith('/pose')){
    if(body.consent!==true){const error=Error('请先勾选本次画面取样授权。');error.status=403;throw error}
    const checked=prepare({version:'1.0',session_id:'camera-preview',exercise:'footwork',sample_id:'preview',elapsed_seconds:0,frame:body.frame});
    data={consent:true,frame:checked.frame};
   }else{
    if(typeof body.camera_id!=='string'||!/^[a-f0-9-]{36}$/.test(body.camera_id)){const error=Error('相机会话无效。');error.status=400;throw error}
    data={camera_id:body.camera_id};if(req.url.endsWith('/start'))data.url=body.url;
   }
   const reply=await fetchImpl(target.origin+req.url.replace('/api',''),{method:'POST',headers:{'Content-Type':'application/json','X-Qingxu-Vision':'local-reformer-v1'},body:JSON.stringify(data),signal:controller.signal,redirect:'error'});
   const raw=await reply.json();send(reply.status,raw);
  }catch(error){send(error.status||502,{error:{message:error.status?error.message:'本机相机服务暂不可用，请检查设备推流和整合版后台。'}})}finally{clearTimeout(timer);active--}
 };
}
module.exports={handler};
