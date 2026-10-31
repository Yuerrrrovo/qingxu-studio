'use strict';
const fs=require('node:fs'),path=require('node:path');
const mediaPath=/^\/assets\/tutorials\/(footwork|straps|pelvic|shortbox|chest)-[12]\.(mp4|jpg|vtt)$/;
function isTutorialMedia(url){return typeof url==='string'&&mediaPath.test(url)}
function serveTutorialMedia(req,res,url,root=__dirname){
 if(!isTutorialMedia(url))return false;
 const fail=(status,extra={})=>{res.writeHead(status,{'Cache-Control':'no-store',...extra});res.end()};
 if(!['GET','HEAD'].includes(req.method)){fail(405,{Allow:'GET, HEAD'});return true}
 const file=path.join(root,...url.slice(1).split('/'));
 let info;try{info=fs.statSync(file);if(!info.isFile())throw Error()}catch{fail(404);return true}
 const size=info.size,extension=path.extname(file),headers={'Content-Type':extension==='.mp4'?'video/mp4':extension==='.jpg'?'image/jpeg':'text/vtt; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Accept-Ranges':'bytes'};
 let start=0,end=size-1,status=200;
 if(req.headers.range){
  const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if(!range||(!range[1]&&!range[2])){fail(416,{'Content-Range':'bytes */'+size});return true}
  if(!range[1]){const suffix=Number(range[2]);if(!Number.isSafeInteger(suffix)||suffix<=0){fail(416,{'Content-Range':'bytes */'+size});return true}start=Math.max(0,size-suffix)}
  else{start=Number(range[1]);if(range[2])end=Number(range[2])}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start){fail(416,{'Content-Range':'bytes */'+size});return true}
  end=Math.min(end,size-1);status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
 }
 headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
 if(req.method==='HEAD'||size===0){res.end();return true}
 const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
}
module.exports={isTutorialMedia,serveTutorialMedia};
