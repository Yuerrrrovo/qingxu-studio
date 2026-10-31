'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {createGzip}=require('node:zlib');
const {splitFloorAssets,assetPaths}=require('../app/mobile-assets.cjs');
const {isTutorialMedia}=require('../app/tutorial-media.cjs');
const {loginPage,cloudHtml}=require('./site.cjs');
const cookieName='__Host-qingxu_access';
const getRoutes=new Set(['/','/index.html','/api/agent/status','/api/motion/status','/api/video/status']);
const postRoutes=new Set(['/api/agent/respond','/api/motion/analyze','/api/motion/analyze-batch','/api/motion/calibrate','/api/motion/reset','/api/video/analyze-batch','/api/video/calibrate','/api/video/reset','/api/camera/pose']);
function equal(a,b){const l=Buffer.from(String(a||'')),r=Buffer.from(String(b||''));return l.length===r.length&&crypto.timingSafeEqual(l,r)}
function checkedOrigin(value,local=false){
 const u=new URL(value);
 if(u.origin!==value||u.username||u.password||(!local&&u.protocol!=='https:')||(local&&!['https:','http:'].includes(u.protocol)))throw Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
 return u;
}
function createGateway({target,getOrigin,getFrontendOrigin=()=>'',password,ready=()=>true,fetchImpl=fetch,allowLocal=false,now=Date.now}={}){
 if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Set QINGXU_ACCESS_PASSWORD to 12–256 characters');
 const upstream=new URL(target);
 if(upstream.hostname!=='127.0.0.1'||upstream.protocol!=='http:'||upstream.origin!==target)throw Error('Upstream must be an internal loopback origin');
 const sessions=new Map();let attempts=[],aiCalls=[],active=0,assets=new Map();
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(self), microphone=()','Content-Security-Policy':"frame-ancestors 'self'",'X-Robots-Tag':'noindex, nofollow'};
 return http.createServer(async(req,res)=>{
  let cors={};
  const send=(status,body,extra={})=>{if(!res.destroyed){res.writeHead(status,{...headers,...cors,'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(body))}};
  // Health checks disclose no credentials or member information.
  if(req.method==='GET'&&req.url==='/healthz')return send(ready()?200:503,{ready:!!ready()});
  let origin;try{origin=checkedOrigin(getOrigin(),allowLocal)}catch{return send(503,{error:{message:'网站地址尚未配置。'}})}
  if(req.headers.host!==origin.host)return send(403,{error:{message:'请从本站正确地址打开。'}});
  let frontend='';try{const value=getFrontendOrigin();if(value)frontend=checkedOrigin(value,allowLocal).origin}catch{}
  const cross=!!frontend&&req.headers.origin===frontend;
  if(cross)cors={'Access-Control-Allow-Origin':frontend,'Vary':'Origin'};
  if(req.method==='OPTIONS'){
   const route=postRoutes.has(req.url)||getRoutes.has(req.url)||['/auth/login','/auth/logout'].includes(req.url);
   const requested=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
   const allowed=new Set(['content-type','authorization','x-qingxu-agent','x-qingxu-motion','x-qingxu-video','x-qingxu-camera']);
   if(!cross||!route||!['GET','POST'].includes(req.headers['access-control-request-method'])||requested.some(h=>!allowed.has(h)))return send(403,{error:{message:'前端地址尚未授权，请设置 QINGXU_FRONTEND_ORIGIN。'}});
   res.writeHead(204,{...headers,...cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':Array.from(allowed).join(', '),'Access-Control-Max-Age':'600'});return res.end();
  }
  if(req.method==='POST'&&req.headers.origin!==origin.origin&&!cross)return send(403,{error:{message:'请从当前青序页面操作。'}});
  if(!['GET','HEAD','POST'].includes(req.method))return send(405,{error:{message:'不支持此请求。'}});
  if(req.url==='/favicon.ico'&&req.method==='GET'){res.writeHead(204,headers);return res.end()}
  const bodyBytes=async limit=>{
   if(Number(req.headers['content-length'])>limit){const e=Error('请求内容过大。');e.status=413;throw e}
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>limit){const e=Error('请求内容过大。');e.status=413;throw e}chunks.push(chunk)}
   return Buffer.concat(chunks);
  };
  if(req.method==='POST'&&req.url==='/auth/login'){
   attempts=attempts.filter(t=>t>now()-60000);if(attempts.length>=10)return send(429,{error:{message:'尝试较多，请稍后再试。'}});attempts.push(now());
   if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:{message:'请从登录页面输入口令。'}});
   try{
    const body=JSON.parse((await bodyBytes(2048)).toString('utf8'));
    if(typeof body.password!=='string'||!equal(body.password,password))return send(401,{error:{message:'访问口令不正确。'}});
    for(const [token,expires]of sessions)if(expires<=now())sessions.delete(token);
    if(sessions.size>=64)return send(429,{error:{message:'当前演示访客较多，请稍后重试。'}});
    const token=crypto.randomBytes(32).toString('hex');sessions.set(token,now()+12*60*60*1000);
    return send(200,cross?{ok:true,access_token:token,expires_in:43200}:{ok:true},cross?{}:{'Set-Cookie':`${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`});
   }catch(e){return send(e.status||400,{error:{message:e.status?e.message:'无法读取口令，请重试。'}})}
  }
  const bearer=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const token=cross?bearer:(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!token||!sessions.has(token)||sessions.get(token)<=now()){
   if(token)sessions.delete(token);
   if(req.method==='GET'&&['/','/index.html'].includes(req.url)){
    const {html,nonce}=loginPage();res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'`});return res.end(html);
   }
   return send(401,{error:{code:'LOGIN_REQUIRED',message:'访问已到期，请刷新页面重新输入访问口令。'}});
  }
  if(req.method==='POST'&&req.url==='/auth/logout'){sessions.delete(token);return send(200,{ok:true},{'Set-Cookie':`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`})}
  const isAsset=req.method==='GET'&&assetPaths.has(req.url);
  const isMedia=['GET','HEAD'].includes(req.method)&&isTutorialMedia(req.url);
  if(!((req.method==='GET'&&getRoutes.has(req.url))||(req.method==='POST'&&postRoutes.has(req.url))||isAsset||isMedia))return send(404,{error:{message:'未找到此页面或接口。'}});
  if(!ready())return send(503,{error:{message:'服务正在启动，请稍后重试。'}});
  if(active>=4)return send(429,{error:{message:'当前请求较多，请稍后重试。'}});
  if(req.url==='/api/agent/respond'){
   aiCalls=aiCalls.filter(t=>t>now()-60000);if(aiCalls.length>=10)return send(429,{error:{message:'AI 请求较多，请稍后再试。'}});aiCalls.push(now());
  }
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),95000);
  res.on('close',()=>{if(!res.writableEnded)controller.abort()});
  try{
   const forwarded={};for(const key of ['content-type','x-qingxu-agent','x-qingxu-motion','x-qingxu-video','x-qingxu-camera'])if(req.headers[key])forwarded[key]=req.headers[key];
   if(req.method==='POST')forwarded.origin=upstream.origin;
   if(isMedia&&req.headers.range)forwarded.range=req.headers.range;
   if(isAsset){
    if(!assets.has(req.url)){const r=await fetchImpl(upstream.origin+'/',{signal:controller.signal,redirect:'error'});if(!r.ok)throw Error('Assets unavailable');assets=splitFloorAssets(await r.text()).assets}
    const bytes=assets.get(req.url);if(!bytes)return send(404,{error:{message:'未找到场景图片。'}});
    res.writeHead(200,{...headers,'Content-Type':'image/jpeg','Content-Length':bytes.length});return res.end(bytes);
   }
   const limit=req.url==='/api/agent/respond'?131072:req.url.endsWith('analyze-batch')?4200000:360000;
   const body=req.method==='POST'?await bodyBytes(limit):undefined;
   const result=await fetchImpl(upstream.origin+req.url,{method:req.method,headers:forwarded,body,signal:controller.signal,redirect:'error'});
   const type=result.headers.get('content-type')||'application/json; charset=utf-8';
   const replyHeaders={...headers,...cors,'Content-Type':type};
   if(isMedia){
    for(const key of ['content-length','content-range','accept-ranges'])if(result.headers.has(key))replyHeaders[key]=result.headers.get(key);
    res.writeHead(result.status,replyHeaders);if(req.method==='HEAD')return res.end();
    if(result.body)await pipeline(Readable.fromWeb(result.body),res);else res.end();return;
   }
   if(result.ok&&type.startsWith('text/html')){
    const packed=splitFloorAssets(cloudHtml(await result.text()));assets=packed.assets;
    const bytes=Buffer.from(packed.html);
    if(/\bgzip\b/.test(req.headers['accept-encoding']||'')){res.writeHead(result.status,{...replyHeaders,'Content-Encoding':'gzip','Vary':'Accept-Encoding'});await pipeline(Readable.from([bytes]),createGzip(),res)}
    else{res.writeHead(result.status,{...replyHeaders,'Content-Length':bytes.length});res.end(bytes)}return;
   }
   res.writeHead(result.status,replyHeaders);if(result.body)await pipeline(Readable.fromWeb(result.body),res);else res.end();
  }catch(e){if(!res.headersSent)send(e.status||502,{error:{message:e.status?e.message:'网站服务暂不可用，请稍后重试。'}});else res.destroy()}
  finally{clearTimeout(timer);active--}
 });
}
module.exports={createGateway,checkedOrigin};
