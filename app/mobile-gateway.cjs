'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {createGzip} = require('node:zlib');
const {splitFloorAssets,assetPaths} = require('./mobile-assets.cjs');
const {isTutorialMedia} = require('./tutorial-media.cjs');

const routes = new Set(['GET /', 'GET /index.html', 'GET /api/video/status', 'POST /api/video/analyze-batch', 'POST /api/video/calibrate', 'POST /api/video/reset', 'GET /api/motion/status', 'GET /api/agent/status', 'POST /api/motion/analyze', 'POST /api/motion/analyze-batch', 'POST /api/motion/calibrate', 'POST /api/motion/reset', 'POST /api/agent/respond']);
const cookieName = '__Host-qingxu_mobile';
function equalSecret(a, b) {
 const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
 return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function publicOrigin(value) {
 try { const url = new URL(value); return url.protocol === 'https:' && (/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)||/^[a-f0-9]{10,32}\.lhr\.life$/.test(url.hostname)) && !url.port && url.origin === value ? value : ''; } catch { return ''; }
}
function loginPage(relay='Cloudflare') {
 const nonce = crypto.randomBytes(18).toString('base64');
 const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#dce4df"><title>青序 · 手机连接</title><style nonce="${nonce}">
 *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;color:#173e33;background:radial-gradient(ellipse at 12% 10%,#f7f9ee,transparent 55%),linear-gradient(145deg,#e1e9e3,#cbd9d1);font-family:"PingFang SC","Microsoft YaHei",sans-serif}main{width:min(100%,430px);padding:34px 27px;border:1px solid #ffffffb8;border-radius:30px;background:#ffffffa8;box-shadow:0 24px 80px #204d341c}.mark{font-size:12px;letter-spacing:3px;color:#536c5e}h1{font-size:29px;font-weight:500;line-height:1.3;margin:35px 0 18px}p{font-size:14px;line-height:1.8;color:#456354}label{display:block;font-size:13px;margin:24px 0 8px}input,button{width:100%;min-height:48px;border-radius:15px;font:inherit}input{background:#ffffffb5;border:1px solid #b8c8be;padding:12px;color:#173e33}button{margin-top:12px;background:#345d4c;border:0;color:white;cursor:pointer}input:focus-visible,button:focus-visible{outline:3px solid #729b82;outline-offset:3px}small{display:block;line-height:1.8;color:#627a6d;margin-top:25px}.status{min-height:25px;overflow-wrap:anywhere}button:disabled{opacity:.6}
 </style><main><div class="mark">〰 青序 / QINGXU STUDIO</div><h1>让手机，<br>成为你的观察视角。</h1><p>相机默认关闭。进入后可选择前置或后置摄像头，电脑负责动作分析。</p><form id="connect"><label for="key">访问口令</label><input id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required><button id="submit">连接青序</button></form><p class="status" id="status" role="status" aria-live="polite">请使用电脑提供的完整链接或二维码。</p><small>画面仅在你同意取样后发送，经 Cloudflare HTTPS 通道转发至电脑。麦克风不启用。电脑需保持开机；若 WB 预览不支持相机，请在手机系统浏览器打开。</small></main><script nonce="${nonce}">
 const input=document.querySelector('#key'),form=document.querySelector('#connect'),status=document.querySelector('#status'),button=document.querySelector('#submit');
 const token=new URLSearchParams(location.hash.slice(1)).get('key');
 if(location.hash)history.replaceState(null,'',location.pathname);
 async function connect(){button.disabled=true;status.textContent='正在连接电脑上的青序…';try{const response=await fetch('/mobile/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:input.value})});if(!response.ok){const body=await response.json();throw Error(body.error?.message||'连接未完成，请重试。')}location.replace('/')}catch(error){status.textContent=error.message;button.disabled=false}}
 form.addEventListener('submit',event=>{event.preventDefault();connect()});if(token){input.value=token;connect()}
 </script></html>`;
 return {html:html.replace('经 Cloudflare HTTPS 通道','经 '+relay+' HTTPS 通道'), nonce};
}
function createMobileGateway({token, sessionSecret = crypto.randomBytes(32).toString('hex'), expiresAt, getOrigin, target = 'http://127.0.0.1:4284', fetchImpl = fetch, now = Date.now} = {}) {
 const upstream = new URL(target);
 if (upstream.origin !== target || upstream.hostname !== '127.0.0.1' || upstream.protocol !== 'http:') throw Error('Gateway target must be a loopback HTTP origin');
 if (!/^[a-f0-9]{64}$/.test(token || '') || !Number.isFinite(expiresAt) || typeof getOrigin !== 'function') throw Error('Gateway needs a random access token, expiration and exact HTTPS origin');
 let active = 0, attempts = [], mobileAssets = new Map();
 return http.createServer(async (req, res) => {
  const headers = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Permissions-Policy':'camera=(self), microphone=()', 'Content-Security-Policy':"frame-ancestors 'self'", 'X-Robots-Tag':'noindex, nofollow'};
  const send = (code, body, extra = {}) => { res.writeHead(code, {...headers, 'Content-Type':'application/json; charset=utf-8', ...extra}); res.end(JSON.stringify(body)); };
  const origin = publicOrigin(getOrigin());
  if (!origin || req.headers.host !== new URL(origin).host) return send(403, {error:{message:'手机连接地址尚未就绪或地址不匹配。'}});
  if (now() >= expiresAt) return send(410, {error:{message:'手机临时链接已到期，请在电脑重新启动手机连接。'}});
  if (req.method === 'POST' && req.headers.origin !== origin) return send(403, {error:{message:'请从当前青序 HTTPS 页面操作。'}});
  if (req.url === '/favicon.ico') { res.writeHead(204, headers); return res.end(); }
  const readBody = async limit => {
   if (Number(req.headers['content-length']) > limit) { const error = Error('请求内容过大。'); error.status = 413; throw error; }
   let size = 0; const chunks = [];
   for await (const chunk of req) { size += chunk.length; if (size > limit) { const error = Error('请求内容过大。'); error.status = 413; throw error; } chunks.push(chunk); }
   return Buffer.concat(chunks);
  };
  if (req.method === 'POST' && req.url === '/mobile/unlock') {
   attempts = attempts.filter(time => time > now() - 60000);
   if (attempts.length >= 20) return send(429, {error:{message:'连接尝试过多，请稍后重试。'}});
   attempts.push(now());
   if (!req.headers['content-type']?.startsWith('application/json')) return send(415, {error:{message:'请使用连接页面提交口令。'}});
   try {
    const body = JSON.parse((await readBody(512)).toString('utf8'));
    if (!equalSecret(body.key, token)) return send(401, {error:{message:'口令不正确，请重新打开完整链接或扫码。'}});
    const seconds = Math.max(1, Math.floor((expiresAt - now()) / 1000));
    return send(200, {connected:true}, {'Set-Cookie':`${cookieName}=${sessionSecret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`});
   } catch (error) { return send(error.status || 400, {error:{message:error.status ? error.message : '无法读取访问口令。'}}); }
  }
  const cookie = (req.headers.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='));
  const authenticated = equalSecret(cookie?.slice(cookieName.length + 1), sessionSecret);
  if (!authenticated) {
   if (req.method === 'GET' && ['/', '/index.html'].includes(req.url)) {
    const {html, nonce} = loginPage(origin.endsWith('.lhr.life')?'localhost.run':'Cloudflare');
    res.writeHead(200, {...headers, 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'`}); return res.end(html);
   }
   return send(401, {error:{message:'请先使用手机连接链接验证访问。'}});
  }
  const isAsset=req.method==='GET'&&assetPaths.has(req.url);
  const isMedia=['GET','HEAD'].includes(req.method)&&isTutorialMedia(req.url);
  if (!routes.has(req.method + ' ' + req.url)&&!isAsset&&!isMedia) return send(404, {error:{message:'未找到此页面或接口。'}});
  if (active >= 4) return send(429, {error:{message:'当前请求较多，请稍候。'}});
  active++;
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(), 95000);
  res.on('close', ()=>{ if (!res.writableEnded) controller.abort(); });
  try {
   const forwarded = {};
   for (const key of ['content-type', 'x-qingxu-motion', 'x-qingxu-agent', 'x-qingxu-video']) if (req.headers[key]) forwarded[key] = req.headers[key];
   if(isMedia&&req.headers.range)forwarded.range=req.headers.range;
   if (req.method === 'POST') forwarded.origin = upstream.origin;
   if(isAsset){
    if(!mobileAssets.has(req.url)){
     const page=await fetchImpl(upstream.origin+'/',{signal:controller.signal,redirect:'error'});
     if(!page.ok)throw Error('Cannot read mobile assets');
     mobileAssets=splitFloorAssets(await page.text()).assets;
    }
    const bytes=mobileAssets.get(req.url);if(!bytes)return send(404,{error:{message:'未找到此图片。'}});
    res.writeHead(200,{...headers,'Content-Type':'image/jpeg','Content-Length':bytes.length});res.end(bytes);return;
   }
   const body = req.method === 'POST' ? await readBody(req.url === '/api/agent/respond' ? 131072 : (req.url === '/api/motion/analyze-batch' || req.url === '/api/video/analyze-batch') ? 4200000 : 360000) : undefined;
   const result = await fetchImpl(upstream.origin + req.url, {method:req.method, headers:forwarded, body, signal:controller.signal, redirect:'error'});
   const contentType = result.headers.get('content-type') || 'application/json; charset=utf-8';
   if(isMedia){
    const mediaHeaders={...headers,'Content-Type':contentType};
    for(const key of ['content-length','content-range','accept-ranges'])if(result.headers.has(key))mediaHeaders[key]=result.headers.get(key);
    res.writeHead(result.status,mediaHeaders);
    if(req.method==='HEAD'){res.end();return}
    if(result.body)await pipeline(Readable.fromWeb(result.body),res);else res.end();return;
   }
   if(result.ok&&contentType.startsWith('text/html')){
    const packed=splitFloorAssets(await result.text());mobileAssets=packed.assets;
    const htmlBytes=Buffer.from(packed.html);
    if(/\bgzip\b/.test(req.headers['accept-encoding']||'')){
     res.writeHead(result.status,{...headers,'Content-Type':contentType,'Content-Encoding':'gzip','Vary':'Accept-Encoding'});
     await pipeline(Readable.from([htmlBytes]),createGzip(),res);return;
    }
    res.writeHead(result.status,{...headers,'Content-Type':contentType,'Content-Length':htmlBytes.length});res.end(htmlBytes);return;
   }
   if (contentType.startsWith('text/html') && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && result.body) {
    res.writeHead(result.status, {...headers, 'Content-Type':contentType, 'Content-Encoding':'gzip', 'Vary':'Accept-Encoding'});
    await pipeline(Readable.fromWeb(result.body), createGzip(), res); return;
   }
   res.writeHead(result.status, {...headers, 'Content-Type':contentType});
   for await (const chunk of result.body || []) { if (res.destroyed) break; res.write(chunk); }
   res.end();
  } catch (error) { if (!res.headersSent) send(error.status || 502, {error:{message:error.status ? error.message : '电脑上的服务暂不可用，请保持电脑和青序服务运行。'}}); else res.destroy(); }
  finally { clearTimeout(timer); active--; }
 });
}
if (require.main === module) {
 const file = path.join(__dirname, 'runtime-mobile-secret.json'), read = ()=>JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), config = read();
 const server = createMobileGateway({...config, getOrigin:()=>{try{return read().origin || ''}catch{return ''}}});
 server.requestTimeout = 100000; server.headersTimeout = 15000;
 server.listen(4286, '127.0.0.1', ()=>console.log('Mobile gateway ready on loopback port 4286; access expires automatically.'));
 server.on('error', error=>{console.error('Mobile gateway failed: '+error.code); process.exitCode=1;});
}
module.exports = {createMobileGateway, publicOrigin};
