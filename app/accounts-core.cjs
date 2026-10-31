(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.QingxuAccounts=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const PROFILE='qingxu-member-ui-v1',RELATED=['qingxu-agent-v1','qingxu-care-v1','qingxu-tutorials-v1','qingxu-venue-profile-updates-v1'];
 const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
 function parse(raw,key){if(raw===null)return {};let value;try{value=JSON.parse(raw)}catch{throw Error('本机记录无法读取，尚未删除账号。请先检查或刷新页面。')}if(!object(value))throw Error('本机记录格式异常，尚未删除账号。');return value}
 function preview(storage,memberId,fallback){
  const raw=storage.getItem(PROFILE),saved=raw===null?fallback:parse(raw,PROFILE);
  if(!object(saved)||!Array.isArray(saved.profiles))throw Error('会员列表暂时无法读取，请重新打开账号管理。');
  const target=saved.profiles.find(p=>p.member_id===memberId);if(!target)throw Error('这个账号已不存在，请重新打开账号管理。');
  return {target,currentId:saved.currentId,total:saved.profiles.length};
 }
 function remove(storage,memberId,fallback){
  if(typeof memberId!=='string'||!memberId)throw Error('请选择要删除的账号。');
  const before=new Map([[PROFILE,storage.getItem(PROFILE)],...RELATED.map(key=>[key,storage.getItem(key)])]);
  const saved=before.get(PROFILE)===null?fallback:parse(before.get(PROFILE),PROFILE);preview({getItem:()=>before.get(PROFILE)},memberId,fallback);
  const target=saved.profiles.find(p=>p.member_id===memberId),profiles=saved.profiles.filter(p=>p.member_id!==memberId),extras={...(saved.extrasByMember||{})};delete extras[memberId];
  const currentId=profiles.some(p=>p.member_id===saved.currentId)?saved.currentId:profiles[0]?.member_id||null;
  const next={...saved,profiles,currentId,extrasByMember:extras},changes=new Map([[PROFILE,JSON.stringify(next)]]);
  for(const key of RELATED){const raw=before.get(key);if(raw===null)continue;const records=parse(raw,key);if(Object.hasOwn(records,memberId)){delete records[memberId];changes.set(key,JSON.stringify(records))}}
  const applied=[];try{for(const [key,value]of changes){if(storage.getItem(key)!==before.get(key))throw Error('记录发生了变化，请重新确认后再删除。');storage.setItem(key,value);applied.push(key)}}catch(error){let restored=true;for(const key of applied.reverse()){try{if(storage.getItem(key)!==changes.get(key)){restored=false;continue}const raw=before.get(key);if(raw===null)storage.removeItem(key);else storage.setItem(key,raw)}catch{restored=false}}const failure=Error(restored?'删除未完成，原有资料已保留，请重试。':'部分资料未能恢复，请保留当前页面并检查本机存储后再操作。');failure.partial=!restored;throw failure}
  return {deletedId:memberId,deletedName:target.nickname,currentId,nextName:profiles.find(p=>p.member_id===currentId)?.nickname||'',remaining:profiles.length,profileState:next};
 }
 return {PROFILE,RELATED,preview,remove};
});
