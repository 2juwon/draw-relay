/* 의견·고장 신고함: 보낸 내용을 저장하고, 관리자 페이지에서만 읽음 */
import { DurableObject } from 'cloudflare:workers';

const MAX_TEXT = 2000;
const MAX_CONTACT = 100;
const MAX_CONTEXT = 16000;
const GAP_MS = 20 * 1000;   // 같은 사람이 연달아 보내지 못하게
const PER_DAY = 20;

export class Inbox extends DurableObject {
  // 보낼 수 있는지 확인하고 저장. 실패하면 { error } 를 돌려줌
  async add(item, who) {
    const now = Date.now();
    const day = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const rk = 'r:' + who;
    const r = (await this.ctx.storage.get(rk)) || { last: 0, day, n: 0 };
    if (r.day !== day) { r.day = day; r.n = 0; }
    if (now - r.last < GAP_MS) return { error: '조금 뒤에 다시 보내 주세요' };
    if (r.n >= PER_DAY) return { error: '오늘은 더 보낼 수 없어요. 내일 다시 보내 주세요' };
    const text = String(item.text || '').trim().slice(0, MAX_TEXT);
    if (!text) return { error: '내용을 적어 주세요' };
    let context = null;
    try { const s = JSON.stringify(item.context ?? null); context = s.length <= MAX_CONTEXT ? JSON.parse(s) : { note: '게임 정보가 너무 커서 뺐어요', size: s.length }; } catch (e) { context = null; }
    const id = now.toString(36) + '-' + crypto.randomUUID().slice(0, 8);
    await this.ctx.storage.put('f:' + id, {
      id, at: now, status: 'new',
      kind: item.kind === 'bug' ? 'bug' : 'idea',
      text, contact: String(item.contact || '').trim().slice(0, MAX_CONTACT),
      context, ua: String(item.ua || '').slice(0, 300),
    });
    r.last = now; r.n += 1;
    await this.ctx.storage.put(rk, r);
    return { ok: true, id };
  }
  async list() {
    const m = await this.ctx.storage.list({ prefix: 'f:', reverse: true, limit: 500 });
    return [...m.values()];
  }
  async setStatus(id, status) {
    const k = 'f:' + id;
    const v = await this.ctx.storage.get(k);
    if (!v) return false;
    v.status = status === 'done' ? 'done' : 'new';
    await this.ctx.storage.put(k, v);
    return true;
  }
  async remove(id) { return this.ctx.storage.delete('f:' + id); }
}

// 관리자 페이지 (비밀번호는 브라우저에만 저장, 요청마다 헤더로 보냄)
export const ADMIN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>그림 릴레이 관리</title>
<style>
:root{--bg:#2b3a55;--paper:#fbf6ea;--ink:#211d18;--seal:#e2553d;--dim:#6a6250;--line:rgba(33,29,24,.14);--brass:#f2b84b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 40px}
h1{color:var(--paper);font-size:22px;margin:0 0 4px}.sub{color:#d6d0b5;margin:0 0 16px;font-size:13px}
.card{background:var(--paper);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 4px 18px rgba(0,0,0,.25)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input,button,select{font:inherit}input{flex:1;min-width:0;min-height:42px;border-radius:10px;border:1.5px solid var(--line);padding:0 10px;background:#fff}
button{min-height:38px;border-radius:10px;border:1px solid rgba(28,25,19,.3);background:transparent;padding:0 14px;cursor:pointer}
button.primary{background:var(--seal);color:var(--paper);border-color:var(--seal)}
.badge{font-size:12px;font-weight:700;padding:2px 8px;border-radius:6px;background:rgba(28,25,19,.08)}
.badge.bug{background:var(--seal);color:var(--paper)}.badge.done{background:#8fc27a;color:var(--ink)}
.meta{color:var(--dim);font-size:12px}.text{white-space:pre-wrap;word-break:break-word;margin:8px 0}
.item.done{opacity:.6}details{margin-top:6px}pre{background:rgba(28,25,19,.06);border-radius:8px;padding:10px;overflow:auto;font-size:12px;max-height:320px}
.filters button[aria-pressed=true]{background:var(--ink);color:var(--paper)}.empty{color:var(--dim)}
</style></head><body><main>
<h1>그림 릴레이 의견함</h1><p class="sub">게임에서 보낸 의견과 고장 신고예요.</p>
<div class="card" id="login"><div class="row"><input id="key" type="password" placeholder="관리자 비밀번호" autocomplete="current-password"><button class="primary" id="go">열기</button></div><p class="meta" id="msg"></p></div>
<div id="box" hidden>
<div class="card row filters"><button data-f="new" aria-pressed="true">새 의견</button><button data-f="all" aria-pressed="false">전체</button><button data-f="bug" aria-pressed="false">고장 신고만</button><span class="meta" id="count" style="margin-left:auto"></span><button id="reload">새로고침</button></div>
<div id="list"></div>
</div>
</main><script>
const $=s=>document.querySelector(s);let key='';let items=[];let filter='new';
try{key=localStorage.getItem('dr-admin')||''}catch(e){}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'x-admin-key':key,'content-type':'application/json'}});if(r.status===401)throw new Error('비밀번호가 맞지 않아요');if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||('오류 '+r.status))}return r.json()}
async function load(){try{items=(await api('/api/admin/feedback')).items;try{localStorage.setItem('dr-admin',key)}catch(e){}$('#login').hidden=true;$('#box').hidden=false;draw()}catch(e){$('#msg').textContent=e.message;$('#login').hidden=false;$('#box').hidden=true}}
function fmt(t){return new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}
function draw(){const L=$('#list');L.innerHTML='';const shown=items.filter(i=>filter==='all'||(filter==='new'?i.status==='new':i.kind==='bug'));
$('#count').textContent=shown.length+'건';if(!shown.length){const p=document.createElement('p');p.className='card empty';p.textContent='아직 없어요';L.append(p);return}
for(const i of shown){const c=document.createElement('div');c.className='card item'+(i.status==='done'?' done':'');
const top=document.createElement('div');top.className='row';const b=document.createElement('span');b.className='badge '+(i.kind==='bug'?'bug':'');b.textContent=i.kind==='bug'?'고장 신고':'의견';top.append(b);
if(i.status==='done'){const d=document.createElement('span');d.className='badge done';d.textContent='처리함';top.append(d)}
const m=document.createElement('span');m.className='meta';m.textContent=fmt(i.at)+(i.contact?' · 연락처: '+i.contact:'');top.append(m);c.append(top);
const t=document.createElement('div');t.className='text';t.textContent=i.text;c.append(t);
if(i.context||i.ua){const d=document.createElement('details');const s=document.createElement('summary');s.textContent='게임 정보';const p=document.createElement('pre');p.textContent=JSON.stringify({ua:i.ua,...(i.context||{})},null,2);d.append(s,p);c.append(d)}
const a=document.createElement('div');a.className='row';a.style.marginTop='8px';
const done=document.createElement('button');done.textContent=i.status==='done'?'새 의견으로':'처리함';done.onclick=async()=>{await api('/api/admin/feedback/'+i.id,{method:'POST',body:JSON.stringify({status:i.status==='done'?'new':'done'})});i.status=i.status==='done'?'new':'done';draw()};
const del=document.createElement('button');del.textContent='지우기';del.onclick=async()=>{if(del.dataset.sure!=='1'){del.dataset.sure='1';del.textContent='한 번 더 누르면 지워요';return}await api('/api/admin/feedback/'+i.id,{method:'DELETE'});items=items.filter(x=>x.id!==i.id);draw()};
a.append(done,del);c.append(a);L.append(c)}}
$('#go').onclick=()=>{key=$('#key').value;load()};$('#key').onkeydown=e=>{if(e.key==='Enter'){key=$('#key').value;load()}};
$('#reload').onclick=load;document.querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{filter=b.dataset.f;document.querySelectorAll('[data-f]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw()});
if(key)load();
</script></body></html>`;
