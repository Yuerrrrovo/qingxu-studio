'use strict';
// Keep the standalone desktop file intact. Mobile loads the original, unmodified
// JPEG floor textures separately so the application script need not wait for them.
const names=['Diffuse','nor_gl','Rough'];
const paths=names.map(name=>'/mobile/assets/floor-'+name+'.jpg');
function splitFloorAssets(html){
 const match=html.match(/^const floorAssets=(\{[^\r\n]+\});?$/m);
 if(!match)return {html,assets:new Map()};
 let source;try{source=JSON.parse(match[1])}catch{throw Error('Invalid embedded floor asset map')}
 const assets=new Map(),links={};
 for(let i=0;i<names.length;i++){
  const value=source[names[i]],data=typeof value==='string'&&value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!data)throw Error('Invalid floor JPEG');
  const bytes=Buffer.from(data[1],'base64');
  if(bytes.length>3000000||!bytes.subarray(0,3).equals(Buffer.from([255,216,255])))throw Error('Invalid floor JPEG size or signature');
  assets.set(paths[i],bytes);links[names[i]]=paths[i];
 }
 return {html:html.replace(match[0],()=> 'const floorAssets='+JSON.stringify(links)+';'),assets};
}
module.exports={splitFloorAssets,assetPaths:new Set(paths)};
