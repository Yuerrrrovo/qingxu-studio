'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
const {readConfig,createAgentServer}=require('./server.cjs');
const root=__dirname,config=readConfig(root),visionPort=Number(process.env.QINGXU_VISION_PORT||4185);
const visionHome=process.env.QINGXU_VISION_HOME||path.resolve(root,'../qingxu-vision-runtime');
const candidates=[process.env.QINGXU_PYTHON,path.join(visionHome,'Scripts/python.exe'),path.join(root,'.venv/Scripts/python.exe'),path.join(root,'.venv/bin/python'),process.env.USERPROFILE&&path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),'python','py'].filter(Boolean);
const python=candidates.find(p=>{const r=spawnSync(p,['-c','import cv2,mediapipe,numpy; assert hasattr(mediapipe,"solutions")'],{stdio:'ignore',windowsHide:true,timeout:20000});return r.status===0});
let child=null,server=null,stopping=false;
function stop(){if(stopping)return;stopping=true;if(child)child.kill();if(server){server.close(()=>process.exit(0));server.closeAllConnections();setTimeout(()=>process.exit(0),2000).unref()}else process.exit(0)}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',()=>child?.kill());
async function launch(){
 if(python){
  child=spawn(python,['-B',path.join(root,'vision/service.py')],{cwd:root,env:{...process.env,QINGXU_VISION_PORT:String(visionPort),PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));
  child.on('error',()=>console.log('视觉服务未启动，普通网页仍可使用。'));
  for(let i=0;i<100;i++){
   if(child.exitCode!==null)break;
   try{const r=await fetch('http://127.0.0.1:'+visionPort+'/health',{signal:AbortSignal.timeout(500)}),v=await r.json();if(r.ok&&v.ready===true){config.localVision='http://127.0.0.1:'+visionPort;break}}catch{}
   await new Promise(r=>setTimeout(r,200));
  }
 }
 if(!config.localVision)console.log('本机视觉环境尚未就绪；请安装 vision/requirements.txt。AI、视频、计时与复盘可正常使用。');
 server=createAgentServer({config});server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'网页端口已被占用；请关闭原启动窗口或设置 PORT。':'网页未能启动：'+e.code);child?.kill();process.exitCode=1});
 server.listen(config.port,'127.0.0.1',()=>console.log('青序 · 协作整合版\nhttp://127.0.0.1:'+config.port+'\n动作检测：'+(config.localVision?'本机服务已就绪':'待安装依赖')+'\n相机默认关闭，关闭启动窗口可停止服务。'));
}
if(require.main===module)launch();
