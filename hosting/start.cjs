'use strict';
const path=require('node:path'),{spawn}=require('node:child_process');
const {createAgentServer,readConfig}=require('../app/server.cjs');
const {createGateway,checkedOrigin}=require('./gateway.cjs');
const root=path.resolve(__dirname,'../app');
async function main(){
 const publicOrigin=(process.env.PUBLIC_ORIGIN||process.env.RENDER_EXTERNAL_URL||'').replace(/\/$/,'');
 checkedOrigin(publicOrigin);
 const port=Number(process.env.PORT||10000),visionPort=4185;
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid PORT');
 const password=process.env.QINGXU_ACCESS_PASSWORD||'';
 if(password.length<12||password.length>256)throw Error('Set QINGXU_ACCESS_PASSWORD to 12–256 characters');
 const config=readConfig(root);let ready=false,stopping=false,child=null;
 const useVision=process.env.QINGXU_ENABLE_VISION!=='false';
 if(useVision)config.localVision='http://127.0.0.1:'+visionPort;
 const app=createAgentServer({config,htmlPath:path.join(root,'index.html')});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve)});
 const gateway=createGateway({target:'http://127.0.0.1:'+app.address().port,getOrigin:()=>publicOrigin,getFrontendOrigin:()=>process.env.QINGXU_FRONTEND_ORIGIN||'',password,ready:()=>ready});
 gateway.requestTimeout=100000;gateway.headersTimeout=15000;
 const stop=()=>{if(stopping)return;stopping=true;ready=false;child?.kill();gateway.close();gateway.closeAllConnections();app.close();app.closeAllConnections();setTimeout(()=>process.exit(process.exitCode||0),200).unref()};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>child?.kill());
 gateway.on('error',e=>{console.error('Website listener failed:',e.code||e.name);process.exitCode=1;stop()});
 await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(port,'0.0.0.0',resolve)});
 console.log('青序托管入口已启动，等待服务就绪。');
 if(useVision){
  // Vision does not need or inherit the AI API key or website password.
  const env={PATH:process.env.PATH,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1',MPLCONFIGDIR:'/tmp/qingxu-matplotlib',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',QINGXU_VISION_PORT:String(visionPort)};
  child=spawn(process.env.QINGXU_PYTHON||'python',['-B',path.join(root,'vision/service.py')],{cwd:root,env,stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',b=>process.stderr.write(b));
  child.on('error',()=>{console.error('视觉环境启动失败，请检查 Docker 构建日志。');process.exitCode=1;stop()});
  child.on('exit',()=>{if(!stopping){console.error('视觉服务已退出，停止本站以避免误报就绪。');process.exitCode=1;stop()}});
  let healthy=false;
  for(let i=0;i<120&&!stopping;i++){
   try{const r=await fetch(config.localVision+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ready===true){healthy=true;break}}catch{}
   await new Promise(r=>setTimeout(r,500));
  }
  if(!healthy){console.error('视觉服务启动超时。');process.exitCode=1;stop();return}
 }
 if(stopping)return;
 ready=true;
 console.log('青序网站已就绪；AI：'+(config.key?'已配置':'待在平台 Environment 填写 AI_API_KEY')+'；动作服务：'+(useVision?'已启动':'关闭')+'。');
}
if(require.main===module)main().catch(()=>{console.error('启动失败：请检查 PUBLIC_ORIGIN、QINGXU_ACCESS_PASSWORD、PORT 与部署日志。');process.exitCode=1});
module.exports={main};
