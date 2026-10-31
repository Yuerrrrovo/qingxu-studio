'use strict';
const crypto=require('node:crypto');
function loginPage(){
 const nonce=crypto.randomBytes(18).toString('base64');
 return {nonce,html:`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#dce4df"><title>青序 · 光境健身房</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;color:#254b3d;background:radial-gradient(ellipse at 10% 8%,#f7f9ef,transparent 55%),linear-gradient(140deg,#dfe8e2,#cbd8d0);font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}main{width:min(100%,440px);padding:34px 28px;border:1px solid #ffffffc0;border-radius:30px;background:#ffffff80;backdrop-filter:blur(24px) saturate(140%);box-shadow:0 24px 80px #204d3417}.mark{font-size:12px;letter-spacing:3px}h1{margin:35px 0 18px;font-size:30px;line-height:1.4;font-weight:500}p{font-size:14px;line-height:1.85;color:#456354}label{display:block;font-size:13px;margin:25px 0 8px}input,button{width:100%;min-height:48px;border-radius:15px;font:inherit}input{background:#ffffffa8;border:1px solid #a9bfb1;padding:12px;color:#254b3d}button{margin-top:12px;background:#3c6251;border:0;color:white;cursor:pointer}input:focus-visible,button:focus-visible{outline:3px solid #759e83;outline-offset:3px}button:disabled{opacity:.6}small{display:block;font-size:12px;line-height:1.9;margin-top:22px;color:#476252}.status{min-height:26px}
</style></head><body><main><div class="mark">青序 / QINGXU STUDIO</div><h1>一方空间，<br>专注当下。</h1><p>输入访问口令，进入你的光境健身房。</p><form id="login"><label for="password">访问口令</label><input id="password" type="password" autocomplete="current-password" required maxlength="256"><button id="enter" type="submit">进入场馆 ↗</button></form><p class="status" id="status" role="status" aria-live="polite"></p><small>这是演示站访问口令，并非会员登录。会员资料保存在当前浏览器，暂不跨设备同步。<br>聊天由站点配置的 DeepSeek 提供；相机默认关闭，只有另行同意取样后，画面才会通过 HTTPS 传至本站服务器分析。原视频和取样帧不写入本站文件。<br>涉及康复与慢病内容必须遵循专业意见，医疗诊断与治疗决策由具备相应资质的专业人员做出。</small></main><script nonce="${nonce}">
document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const button=document.querySelector('#enter'),status=document.querySelector('#status');button.disabled=true;status.textContent='正在进入…';try{const response=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});if(!response.ok){const data=await response.json();throw Error(data.error?.message||'暂时无法连接，请稍后重试。')}location.replace('/')}catch(error){status.textContent=error.message;button.disabled=false}});
</script></body></html>`};
}
const replacements=[
 ['同意把本次视频选段的取样画面交给本机或所连接电脑的视觉服务分析。原视频不保存到档案。','同意将本次视频选段的取样画面通过 HTTPS 发送至本站服务器分析。原视频不上传，取样帧不保存；仅在当前浏览器保存复盘摘要。'],
 ['我同意本次向已配置的动作服务发送标定单帧和动作取样画面。','我同意本次通过 HTTPS 向本站服务器发送标定单帧、人体检测与动作取样画面。'],
 ['发送一张画面及 A/B/C 三点至本机服务','发送一张画面及 A/B/C 三点至本站服务器'],
 ['本机视觉每 0.2 秒采集一帧','动作检测每 0.2 秒采集一帧'],
 ['已连接本机视觉服务','已连接网站视觉服务'],
 ['本页不保存照片或视频；外部服务的数据处理方式需在接入时确认。','本站视觉服务在服务器内存中处理取样画面，不写入照片或视频文件；聊天与计划服务的数据处理规则由所配置的 AI 平台提供。'],
 ['未连接 AI 本地服务','暂未连接网站 AI 服务'],
 ['请在电脑 Chrome / Edge 中打开本机地址','请在 Chrome / Edge 或手机系统浏览器中打开本站 HTTPS 地址']
];
function cloudHtml(html){
 for(const [from,to]of replacements)html=html.split(from).join(to);
 // Adapt only cloud transport wording. Leave the original renderer, glass,
 // navigation, account contracts and action selection code unchanged.
 const old="$('#motionTransportInfo').hidden=!(location.protocol==='https:'&&relay);";
 const next="$('#motionTransportInfo').hidden=false;$('#motionTransportInfo').textContent='云端动作分析：同意取样后，画面通过 HTTPS 发送至本站服务器，在内存中分析，不写入视频或帧文件。网络延迟可能中断检测；停止或撤回授权后不再取样。';";
 if(!html.includes(old))throw Error('Cloud transport notice integration point is missing');
 return html.replace(old,next);
}
module.exports={loginPage,cloudHtml};
