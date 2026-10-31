'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {AgentError,runAgent}=require('./agent-core.cjs');
const motion=require('./motion.cjs');
const camera=require('./camera.cjs');
const videoReview=require('./video.cjs');
const {serveTutorialMedia}=require('./tutorial-media.cjs');
function readConfig(directory=__dirname){
 const values={};try{for(const line of fs.readFileSync(path.join(directory,'.env'),'utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(!m)continue;let value=m[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);values[m[1]]=value}}catch(e){if(e.code!=='ENOENT')throw e}
 const get=n=>process.env[n]??values[n]??'';
 return {key:get('AI_API_KEY'),baseUrl:get('AI_BASE_URL'),model:get('AI_MODEL'),provider:get('AI_PROVIDER')||'兼容接口',jsonMode:get('AI_JSON_MODE')!=='false',allowLocalHttp:get('AI_ALLOW_LOCAL_HTTP')==='1',motionUrl:get('MOTION_ANALYSIS_URL'),motionKey:get('MOTION_API_KEY'),motionLocal:get('MOTION_ALLOW_LOCAL_HTTP')==='1',localVision:get('QINGXU_VISION_URL'),port:Number(get('PORT')||4184)};
}
function createAgentServer({config=readConfig(),htmlPath=path.join(__dirname,'index.html'),fetchImpl=fetch}={}){
 let active=0;const requests=[],motionHandler=motion.handler(config,{fetchImpl}),cameraHandler=camera.handler(config,{fetchImpl}),videoHandler=videoReview.handler(config,{fetchImpl});
 const server=http.createServer(async(req,res)=>{
  const local=req.socket.localPort,expected='127.0.0.1:'+local;
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
  if(req.headers.host!==expected){send(403,{error:{code:'HOST_REJECTED',message:'请通过本机 127.0.0.1 地址访问。'}});return}
  let url;try{url=new URL(req.url,'http://'+expected)}catch{return send(400,{error:{message:'无效地址。'}})}
  if(serveTutorialMedia(req,res,url.pathname))return;
  if(url.pathname.startsWith('/api/video/'))return videoHandler(req,res,expected);
  if(url.pathname.startsWith('/api/camera/'))return cameraHandler(req,res,expected);
  if(url.pathname.startsWith('/api/motion/'))return motionHandler(req,res,expected);
  if(req.method==='GET'&&['/','/index.html','/%E9%9D%92%E5%BA%8F-%E5%85%89%E5%A2%83%E5%81%A5%E8%BA%AB%E6%88%BF.html'].includes(url.pathname)){
   try{const data=fs.readFileSync(htmlPath);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(data)}catch{return send(500,{error:{code:'HTML_MISSING',message:'未找到 index.html，请保留完整接入包。'}})}return;
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/status'){send(200,{configured:!!(config.key&&config.baseUrl&&config.model),provider:config.provider,model:config.model||null});return}
  if(req.method!=='POST'||url.pathname!=='/api/agent/respond'){send(404,{error:{message:'未找到此接口。'}});return}
  if(req.headers.origin!=='http://'+expected||req.headers['x-qingxu-agent']!=='1'){send(403,{error:{code:'ORIGIN_REJECTED',message:'请从本地青序页面发起请求。'}});return}
  if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请求必须为 JSON。'}});
  const now=Date.now();while(requests.length&&requests[0]<now-60000)requests.shift();if(active>=2||requests.length>=20)return send(429,{error:{code:'BUSY',message:'请求较多，请稍后重试。'}});
  let size=0;const chunks=[];const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);res.on('close',()=>{if(!res.writableEnded)controller.abort()});
  let counted=false;try{
   for await(const chunk of req){size+=chunk.length;if(size>131072)throw new AgentError('BODY_TOO_LARGE','本次内容过长，请缩短问题或档案备注。',413);chunks.push(chunk)}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new AgentError('BAD_JSON','无法读取请求内容。')}
   if(active>=2)throw new AgentError('BUSY','已有请求在处理中，请稍候。',429);active++;counted=true;requests.push(now);
   const result=await runAgent(body,config,{fetchImpl,signal:controller.signal});if(!res.destroyed)send(200,result);
  }catch(error){if(!res.destroyed)send(error.status||502,{error:{code:error.code||(error.name==='AbortError'?'TIMEOUT':'REQUEST_FAILED'),message:error instanceof AgentError?error.message:error.name==='AbortError'?'AI 响应超时，可以稍后重试。':'AI 请求未完成，请检查网络和接口配置。'}})}
  finally{clearTimeout(timer);if(counted)active--}
 });
 return server;
}
if(require.main===module){const config=readConfig();if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('PORT must be 1024–65535');const server=createAgentServer({config});server.on('error',e=>console.error(e.code==='EADDRINUSE'?'端口已被占用，请关闭已有服务或修改 PORT。':'服务未能启动：'+e.code));server.listen(config.port,'127.0.0.1',()=>console.log('青序 AI 本地服务\nhttp://127.0.0.1:'+config.port+'\nAI 接口：'+(config.key&&config.baseUrl&&config.model?'已配置':'未配置（可先查看界面演示）')+'\n关闭此窗口即可停止服务。'))}
module.exports={readConfig,createAgentServer};
