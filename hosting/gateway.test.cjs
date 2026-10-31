'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {createGateway,checkedOrigin}=require('./gateway.cjs');
const {cloudHtml}=require('./site.cjs');
const root=path.resolve(__dirname,'..'),page=fs.readFileSync(path.join(root,'app/index.html'),'utf8');
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port}
async function fixture(t){
 const calls=[];
 const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);calls.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()});
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(page)}
  if(req.url.startsWith('/assets/tutorials/')){res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 0-3/10','Content-Length':4,'Accept-Ranges':'bytes'});return res.end(Buffer.from('demo'))}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,configured:true,provider:'Test Provider'}));
 });
 const target=await listen(upstream);let origin='',frontend='',time=1000000;
 const gateway=createGateway({target,getOrigin:()=>origin,getFrontendOrigin:()=>frontend,password:'synthetic-password-only',allowLocal:true,now:()=>time});origin=await listen(gateway);
 t.after(()=>{gateway.closeAllConnections();upstream.closeAllConnections();gateway.close();upstream.close()});
 const request=(p,init={})=>fetch(origin+p,init);
 const login=()=>request('/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-password-only'})});
 return {calls,origin,target,request,login,setTime:v=>time=v,setFrontend:v=>frontend=v};
}
test('HTTPS origin and internal upstream are required',()=>{
 assert.throws(()=>checkedOrigin('http://public.example'));assert.throws(()=>checkedOrigin('https://public.example/path'));assert.throws(()=>checkedOrigin('https://u:p@public.example'));
 assert.equal(checkedOrigin('https://demo.onrender.com').origin,'https://demo.onrender.com');
 assert.throws(()=>createGateway({target:'https://external.example',password:'synthetic-password-only'}));
 assert.throws(()=>createGateway({target:'http://127.0.0.1:4000',password:'short'}));
});
test('unauthenticated visitors get login, API and source paths stay closed',async t=>{
 const f=await fixture(t);const r=await f.request('/');assert.equal(r.status,200);const html=await r.text();
 assert.match(html,/访问口令/);assert.match(html,/HTTPS 传至本站服务器/);assert.doesNotMatch(html,/synthetic-password-only/);
 assert.equal((await f.request('/api/agent/status')).status,401);assert.equal((await f.request('/.env')).status,401);assert.equal(f.calls.length,0);
 assert.deepEqual(await (await f.request('/healthz')).json(),{ready:true});
});
test('login validates same-origin, cookies are secure and sessions expire',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/auth/login',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await f.request('/auth/login',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:'{"password":"wrong"}'})).status,401);
 const r=await f.login(),cookie=r.headers.get('set-cookie');assert.equal(r.status,200);assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
 assert.equal((await f.request('/api/agent/status',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
 f.setTime(1000000+43200001);assert.equal((await f.request('/api/agent/status',{headers:{Cookie:cookie.split(';')[0]}})).status,401);
});
test('authenticated proxy rewrites only internal origin, never forwards cookie or arbitrary headers',async t=>{
 const f=await fixture(t),r=await f.login(),cookie=r.headers.get('set-cookie').split(';')[0];
 const result=await f.request('/api/agent/respond',{method:'POST',headers:{Cookie:cookie,Origin:f.origin,'Content-Type':'application/json','X-Qingxu-Agent':'1','X-Forwarded-Host':'evil.example',Authorization:'do-not-forward'},body:'{"message":"synthetic hello"}'});
 assert.equal(result.status,200);const c=f.calls.at(-1);assert.equal(c.headers.origin,f.target);assert.equal(c.headers['x-qingxu-agent'],'1');assert.equal(c.headers.cookie,undefined);assert.equal(c.headers.authorization,undefined);assert.equal(c.headers['x-forwarded-host'],undefined);
 const count=f.calls.length;assert.equal((await f.request('/api/agent/respond',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'},body:'{}'})).status,403);assert.equal(f.calls.length,count);
});
test('source files, unknown paths and server-side network camera endpoints are not exposed',async t=>{
 const f=await fixture(t),cookie=(await f.login()).headers.get('set-cookie').split(';')[0];
 for(const route of ['/.env','/app/server.cjs','/hosting/start.cjs','/assets/tutorials/../../.env'])assert.equal((await f.request(route,{headers:{Cookie:cookie}})).status,404);
 for(const route of ['/api/camera/start','/api/camera/frame','/api/camera/stop'])assert.equal((await f.request(route,{method:'POST',headers:{Cookie:cookie,Origin:f.origin},body:'{}'})).status,404);
 assert.equal(f.calls.length,0);
});
test('AI requests and login attempts are bounded',async t=>{
 const f=await fixture(t),cookie=(await f.login()).headers.get('set-cookie').split(';')[0];
 for(let i=0;i<10;i++)assert.equal((await f.request('/api/agent/respond',{method:'POST',headers:{Cookie:cookie,Origin:f.origin},body:'{}'})).status,200);
 assert.equal((await f.request('/api/agent/respond',{method:'POST',headers:{Cookie:cookie,Origin:f.origin},body:'{}'})).status,429);
 for(let i=0;i<9;i++)await f.login();assert.equal((await f.login()).status,429);
});
test('large payloads are rejected before forwarding and media byte ranges survive',async t=>{
 const f=await fixture(t),cookie=(await f.login()).headers.get('set-cookie').split(';')[0];
 assert.equal((await f.request('/api/agent/respond',{method:'POST',headers:{Cookie:cookie,Origin:f.origin},body:'x'.repeat(131073)})).status,413);
 assert.equal(f.calls.length,0);
 const r=await f.request('/assets/tutorials/footwork-1.mp4',{headers:{Cookie:cookie,Range:'bytes=0-3'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-3/10');assert.equal(await r.text(),'demo');assert.equal(f.calls[0].headers.range,'bytes=0-3');
});
test('served application preserves layout and changes only cloud transport wording and floor URLs',async t=>{
 const f=await fixture(t),cookie=(await f.login()).headers.get('set-cookie').split(';')[0];
 const r=await f.request('/',{headers:{Cookie:cookie}}),html=await r.text();assert.equal(r.status,200);
 assert.match(html,/同意将本次视频选段的取样画面通过 HTTPS 发送至本站服务器分析/);assert.match(html,/云端动作分析/);assert.doesNotMatch(html,/同意把本次视频选段的取样画面交给本机/);
 for(const css of ['.nav-bubble','.nav-droplet','glassLens'])assert.equal(html.includes(css),page.includes(css));
 const scripts=Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),m=>m[1]).filter(s=>s.trim());for(const s of scripts)new vm.Script(s);
 const texture=await f.request('/mobile/assets/floor-Diffuse.jpg',{headers:{Cookie:cookie}});assert.equal(texture.status,200);assert.equal(texture.headers.get('content-type'),'image/jpeg');
});
test('logout invalidates the session without touching browser member data',async t=>{
 const f=await fixture(t),cookie=(await f.login()).headers.get('set-cookie').split(';')[0];
 assert.equal((await f.request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:f.origin}})).status,200);assert.equal((await f.request('/api/agent/status',{headers:{Cookie:cookie}})).status,401);
});
test('gateway connects to the actual original server without loosening its Host checks',async t=>{
 const {createAgentServer}=require('../app/server.cjs');
 const app=createAgentServer({config:{key:'synthetic-key-not-real',provider:'Synthetic DeepSeek',baseUrl:'https://invalid.example',model:'test-model'},htmlPath:path.join(root,'app/index.html'),fetchImpl:()=>{throw Error('No external calls allowed in tests')}});
 const target=await listen(app);let origin='';
 const gateway=createGateway({target,getOrigin:()=>origin,password:'synthetic-password-only',allowLocal:true});origin=await listen(gateway);
 t.after(()=>{gateway.closeAllConnections();app.closeAllConnections();gateway.close();app.close()});
 const login=await fetch(origin+'/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"password":"synthetic-password-only"}'});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const r=await fetch(origin+'/api/agent/status',{headers:{Cookie:cookie}});assert.equal(r.status,200);const body=await r.text();assert.match(body,/Synthetic DeepSeek/);assert.doesNotMatch(body,/synthetic-key-not-real/);
 const missing=await fetch(origin+'/api/agent/respond',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Qingxu-Agent':'1'},body:'{}'});assert.equal(missing.status,400);
});
test('Drop preflight is limited to the exact configured origin, routes and headers',async t=>{
 const f=await fixture(t);f.setFrontend('https://synthetic.ficp.fun');
 const preflight=(origin,route='/api/agent/respond',header='authorization, content-type, x-qingxu-agent')=>f.request(route,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':header}});
 const ok=await preflight('https://synthetic.ficp.fun');assert.equal(ok.status,204);assert.equal(ok.headers.get('access-control-allow-origin'),'https://synthetic.ficp.fun');assert.equal(ok.headers.get('access-control-allow-credentials'),null);
 assert.equal((await preflight('https://other.ficp.fun')).status,403);assert.equal((await preflight('https://synthetic.ficp.fun','/.env')).status,403);assert.equal((await preflight('https://synthetic.ficp.fun','/api/agent/respond','x-unknown-header')).status,403);
});
test('Drop uses a temporary bearer session without third-party cookies or an exposed AI key',async t=>{
 const f=await fixture(t);f.setFrontend('https://synthetic.ficp.fun');
 const r=await f.request('/auth/login',{method:'POST',headers:{Origin:'https://synthetic.ficp.fun','Content-Type':'application/json'},body:'{"password":"synthetic-password-only"}'}),data=await r.json();
 assert.equal(r.status,200);assert.match(data.access_token,/^[a-f0-9]{64}$/);assert.equal(r.headers.get('set-cookie'),null);
 const get=await f.request('/api/agent/status',{headers:{Origin:'https://synthetic.ficp.fun',Authorization:'Bearer '+data.access_token}});assert.equal(get.status,200);assert.equal(get.headers.get('access-control-allow-origin'),'https://synthetic.ficp.fun');assert.equal(f.calls.at(-1).headers.authorization,undefined);
 assert.equal((await f.request('/api/agent/status',{headers:{Origin:'https://synthetic.ficp.fun',Cookie:'__Host-qingxu_access='+data.access_token}})).status,401);
});
test('all copied runtime files match the supplied original and no key file is bundled',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'original-files.sha256.json'),'utf8'));
 for(const file of manifest)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'app',file.path))).digest('hex'),file.sha256,file.path);
 assert.ok(!fs.existsSync(path.join(root,'app/.env')));assert.ok(!fs.existsSync(path.join(root,'.env')));
 assert.match(cloudHtml(page),/云端动作分析/);
});
