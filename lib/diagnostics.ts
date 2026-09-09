export type Platform = 'both' | 'claude' | 'chatgpt';
export type CheckState = 'pending' | 'pass' | 'attention' | 'unknown' | 'info';
export type CheckItem = { id: string; title: string; scope: string; state: CheckState; value: string; evidence: string; advice: string };
export const REVIEWED_AT = '2026-09-07';
export const sources = {
 chatgpt:{region:'https://help.openai.com/en/articles/7947663-chatgpt-supported-countries',help:'https://help.openai.com/en/articles/7426629-why-cant-i-log-in-to-chatgpt',status:'https://status.openai.com',site:'https://chatgpt.com'},
 claude:{region:'https://support.claude.com/en/articles/8461763-where-can-i-access-claude',help:'https://support.claude.com/en/articles/12466728-troubleshoot-claude-error-messages',status:'https://status.claude.com',site:'https://claude.ai'}
};
export const initialItems: CheckItem[] = [
 {id:'https',title:'安全连接',scope:'当前页面',state:'pending',value:'等待检测',evidence:'检查当前页面是否通过 HTTPS 加载。',advice:'仅检查本站；不能读取目标平台的 TLS 或安全设置。'},
 {id:'cookie',title:'Cookie 读写',scope:'当前站点',state:'pending',value:'等待检测',evidence:'写入一个临时测试 Cookie，读回后立即清除。',advice:'如果失败，检查本站 Cookie 权限。目标平台和第三方 Cookie 权限需在对应页面核对。'},
 {id:'storage',title:'浏览器存储',scope:'当前站点',state:'pending',value:'等待检测',evidence:'读写一个随机命名的临时 localStorage 项，测试后立即删除。',advice:'若不可用，请核对本站存储权限、可用空间或换一个浏览器进行对比。此测试不读取其他存储项目。'},
 {id:'connection',title:'本站连接',scope:'浏览器 → 本站',state:'pending',value:'等待检测',evidence:'向本站发送三次不使用缓存的轻量请求，记录成功次数和往返耗时中位数。',advice:'不是网速或 AI 平台延迟测试。若失败，请确认本站能正常加载，稍后重试或联系网络管理员。'},
 {id:'exit',title:'网络出口',scope:'浏览器 → Cloudflare',state:'pending',value:'等待检测',evidence:'直接读取 Cloudflare trace 的 IP 与地区字段。IP 默认遮挡，完整值不会保存到本地存储。',advice:'此出口不等于 AI 平台看到的出口，也不等于实际所在地；分流和地理定位误差均可能影响结果。'},
 {id:'chatgpt',title:'ChatGPT 服务状态',scope:'官方整体状态',state:'pending',value:'等待检测',evidence:'从 OpenAI 官方状态页读取整体状态，不测试你的账号或到 ChatGPT 的连接。',advice:'官方报告正常仍可能存在局部问题。个人访问情况请打开 ChatGPT 核对。'},
 {id:'claude',title:'Claude 服务状态',scope:'官方整体状态',state:'pending',value:'等待检测',evidence:'从 Claude 官方状态页读取整体状态，不测试你的账号或到 Claude 的连接。',advice:'官方报告正常仍可能存在局部问题。个人访问情况请打开 Claude 核对。'}
];
export function isPlatform(value: unknown): value is Platform {return value==='both'||value==='claude'||value==='chatgpt';}
export function selectItems(platform: Platform){return initialItems.filter(x=>!['chatgpt','claude'].includes(x.id)||platform==='both'||x.id===platform);}
export function maskIp(ip:string){
 if(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)&&ip.split('.').every(x=>Number(x)<=255))return ip.split('.').slice(0,2).join('.')+'.*.*';
 if(ip.includes(':')&&/^[0-9a-f:]+$/i.test(ip)&&ip.length<=45)return ip.split(':').slice(0,2).join(':')+':…';
 throw new Error('Invalid IP field');
}
export function parseTrace(text:string){
 const fields=Object.fromEntries(text.split('\n').filter(x=>x.includes('=')).map(x=>{const at=x.indexOf('=');return [x.slice(0,at),x.slice(at+1).trim()];}));
 if(!fields.ip||!fields.loc||!/^([A-Z]{2}|T1)$/.test(fields.loc))throw new Error('Trace fields unavailable');
 return {maskedIp:maskIp(fields.ip),country:fields.loc};
}
export function regionNote(country:string,now=Date.now()){
 const age=now-Date.parse(REVIEWED_AT+'T00:00:00Z');
 if(age<0||age>30*86400000)return '支持地区资料需要重新核实。请打开官方清单核对实际所在地，勿将出口地区当作使用资格。';
 if(['CN','HK','MO'].includes(country))return '该出口地区未列入 2026-09-07 核实的 Claude 和 ChatGPT 支持地区清单。请核对实际所在地和最新官方要求；此提示不是账号封禁结论。';
 return '未对该出口地区自动判定使用资格。请在官方清单核对实际所在地；IP 地理定位不是资格证明。';
}
function regionName(code:string){try{return new Intl.DisplayNames(['zh-CN'],{type:'region'}).of(code)||code;}catch{return code;}}
export type Runtime = {
 fetch: typeof fetch; protocol: string; cookie: {read:()=>string;write:(value:string)=>void};
 storage: Pick<Storage,'setItem'|'getItem'|'removeItem'>; now:()=>number;
};
export function browserRuntime():Runtime {
 return {fetch:window.fetch.bind(window),protocol:location.protocol,cookie:{read:()=>document.cookie,write:v=>{document.cookie=v;}},
 storage:{setItem:(k,v)=>window.localStorage.setItem(k,v),getItem:k=>window.localStorage.getItem(k),removeItem:k=>window.localStorage.removeItem(k)},now:()=>performance.now()};
}
export async function runChecks(platform:Platform,onResult:(item:CheckItem)=>void,runtime?:Runtime):Promise<CheckItem[]> {
 if(!isPlatform(platform))throw new Error('Invalid platform');
 const rt=runtime??browserRuntime();const output:CheckItem[]=[];
 function emit(id:string,patch:Partial<CheckItem>){const base=initialItems.find(x=>x.id===id);if(!base)throw new Error('Unknown check');const item={...base,...patch};output.push(item);onResult(item);}
 async function read(url:string,external=false){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),6000);
  try{const response=await rt.fetch(url,{cache:'no-store',credentials:external?'omit':'same-origin',referrerPolicy:'no-referrer',signal:controller.signal,mode:external?'cors':'same-origin'});
   if(!response.ok)throw new Error('HTTP response not successful');
   // Consume the body under the same timeout as the request.
   return await response.text();
  }finally{clearTimeout(timer);}
 }
 emit('https',{state:rt.protocol==='https:'?'pass':'attention',value:rt.protocol==='https:'?'HTTPS 已启用':'当前页面不是 HTTPS',evidence:`当前页面协议：${rt.protocol}。${rt.protocol==='http:'?'本地预览也会显示此提示；正式访问时应使用 HTTPS。':''}`});
 const key='ai_preflight_'+Date.now()+'_'+Math.random().toString(36).slice(2);
 let cookieOk=false;
 try{rt.cookie.write(`${key}=1; SameSite=Lax; path=/${rt.protocol==='https:'?'; Secure':''}`);cookieOk=rt.cookie.read().split(';').some(x=>x.trim()===key+'=1');emit('cookie',{state:cookieOk?'pass':'attention',value:cookieOk?'临时 Cookie 读写成功':'未能读回临时 Cookie'});}
 catch{emit('cookie',{state:'unknown',value:'浏览器限制了本次测试'});}
 finally{try{rt.cookie.write(`${key}=; Max-Age=0; SameSite=Lax; path=/${rt.protocol==='https:'?'; Secure':''}`);}catch{/* No further access possible. */}}
 try{rt.storage.setItem(key,'1');const ok=rt.storage.getItem(key)==='1';emit('storage',{state:ok?'pass':'attention',value:ok?'临时存储读写成功':'存储未能读回'});}
 catch{emit('storage',{state:'attention',value:'本地存储不可用'});}
 finally{try{rt.storage.removeItem(key);}catch{/* Storage may be denied. */}}
 const tasks:Promise<void>[]=[];
 tasks.push((async()=>{
  const timings:number[]=[];
  for(let i=0;i<3;i++){const start=rt.now();try{const body=JSON.parse(await read('/probe.json?run='+encodeURIComponent(key)+'&n='+i));if(body.service!=='ai-preflight'||body.version!==1)throw new Error('Unexpected response');timings.push(Math.max(0,rt.now()-start));}catch{/* Record failed sample only. */}}
  timings.sort((a,b)=>a-b);const median=timings.length?Math.round(timings[Math.floor(timings.length/2)]):null;
  emit('connection',{state:timings.length===3?'pass':'attention',value:`${timings.length} / 3 次成功${median!==null?' · '+median+' ms':''}`,evidence:`三次顺序请求，成功 ${timings.length} 次。${median!==null?`成功请求的耗时中位数为 ${median} ms。`:''}测量包含本站处理时间，不代表 AI 平台连接质量。`});
 })());
 tasks.push((async()=>{try{
  const trace=parseTrace(await read('https://www.cloudflare.com/cdn-cgi/trace',true));
  emit('exit',{state:regionNote(trace.country).startsWith('该出口地区')?'attention':'info',value:`${regionName(trace.country)} · ${trace.maskedIp}`,evidence:`Cloudflare trace 返回地区 ${trace.country}（${regionName(trace.country)}），IP 已遮挡为 ${trace.maskedIp}。这只是访问 Cloudflare 的路径，不能识别“IP 纯净度”、代理信誉或平台内部评分。`,advice:regionNote(trace.country)});
 }catch{emit('exit',{state:'unknown',value:'无法读取出口信息',advice:'请求可能超时、被网络或浏览器拦截，或返回了无法识别的数据。稍后重试；不能据此判断 AI 平台是否封禁。'});}})());
 for(const p of ['claude','chatgpt'] as const){if(platform!=='both'&&platform!==p)continue;
  tasks.push((async()=>{try{
   const body=JSON.parse(await read(sources[p].status+'/api/v2/status.json',true));
   const indicator=body?.status?.indicator;
   if(!['none','minor','major','critical','maintenance'].includes(indicator))throw new Error('Invalid status');
   const statusText:Record<string,string>={none:'官方报告整体正常',minor:'官方报告部分异常',major:'官方报告较大异常',critical:'官方报告严重异常',maintenance:'官方报告维护中'};
   emit(p,{state:indicator==='none'?'info':'attention',value:statusText[indicator],evidence:`${sources[p].status} 返回整体状态 ${indicator}。${typeof body.status.description==='string'?'官方描述：'+body.status.description.slice(0,200)+'。':''}此项不是对目标网站的个人连通性测试。`,advice:indicator==='none'?'如果仍然无法使用，打开目标网站核对具体报错，并参考官方登录指南。':'打开官方状态页查看受影响组件、故障范围与恢复进展；整体异常并不代表你的账号被停用。'});
  }catch{emit(p,{state:'unknown',value:'暂时无法读取官方状态',advice:'打开官方状态页手动核对。读取失败可能来自超时或跨站限制，不能据此判断服务已宕机。'});}})());
 }
 await Promise.all(tasks);
 return selectItems(platform).map(base=>output.find(x=>x.id===base.id)??{...base,state:'unknown',value:'本次未能完成'});
}
