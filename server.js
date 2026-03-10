const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function getBrowserHeaders(targetUrl) {
  const origin = new URL(targetUrl).origin;
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': origin + '/',
  };
}

function proxyUrl(u, base, wb) {
  try {
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') || u.startsWith('#') || u.startsWith(wb)) return u;
    return wb + '/proxy?url=' + encodeURIComponent(new URL(u, base).href);
  } catch { return u; }
}

function rewriteCSS(css, base, wb) {
  return css.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (m, u) => `url("${proxyUrl(u.trim(), base, wb)}")`);
}

function rewriteHTML(html, base, wb) {
  html = html.replace(/<meta[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  html = html.replace(/(\s)(src|href|action|data-src)(\s*=\s*)(['"])((?!data:|blob:|javascript:|#)[^'"]+)\4/gi, (match, space, attr, eq, quote, val) => {
    try {
      return space + attr + eq + quote + wb + '/proxy?url=' + encodeURIComponent(new URL(val, base).href) + quote;
    } catch { return match; }
  });

  html = html.replace(/(\s)srcset(\s*=\s*)(['"])(.*?)\3/gi, (match, space, eq, quote, srcset) => {
    const rewritten = srcset.split(',').map(part => {
      const t = part.trim(), si = t.search(/\s/);
      const u = si === -1 ? t : t.slice(0, si), rest = si === -1 ? '' : t.slice(si);
      return proxyUrl(u, base, wb) + rest;
    }).join(', ');
    return space + 'srcset' + eq + quote + rewritten + quote;
  });

  const script = `<script>
(function(){
  var W="${wb}",B="${base}";
  function px(u){
    if(!u||u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('javascript:')||u.startsWith('#')||u.startsWith(W))return u;
    try{return W+'/proxy?url='+encodeURIComponent(new URL(u,B).href);}catch(e){return u;}
  }
  var _f=window.fetch.bind(window);
  window.fetch=function(i,o){if(typeof i==='string')i=px(i);return _f(i,o);};
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){arguments[1]=px(u);return _o.apply(this,arguments);};
  history.pushState=function(s,t,u){if(u){try{top.postMessage({type:'nav',url:new URL(u,B).href},'*');}catch(e){}}};
  try{
    window.location.assign=function(u){try{top.postMessage({type:'nav',url:new URL(u,B).href},'*');}catch(e){}};
    window.location.replace=function(u){try{top.postMessage({type:'nav',url:new URL(u,B).href},'*');}catch(e){}};
  }catch(e){}
  document.addEventListener('click',function(e){
    var el=e.target;
    while(el&&el.tagName!=='A')el=el.parentElement;
    if(!el)return;
    var h=el.getAttribute('href');
    if(!h||h.startsWith('javascript:')||h==='#')return;
    e.preventDefault();e.stopPropagation();
    try{top.postMessage({type:'nav',url:new URL(h,B).href},'*');}catch(e){}
  },true);
  document.addEventListener('submit',function(e){
    var f=e.target,a=f.getAttribute('action')||B;
    e.preventDefault();
    var u;try{u=new URL(a,B).href;}catch(e){u=B;}
    if(f.method&&f.method.toLowerCase()==='get'){var p=new URLSearchParams(new FormData(f)).toString();u=u.split('?')[0]+(p?'?'+p:'');}
    top.postMessage({type:'nav',url:u},'*');
  },true);
})();
<\/script>`;

  if(/<head[\s>]/i.test(html)) html=html.replace(/<head([^>]*)>/i,`<head$1>${script}`);
  else html=script+html;
  return html;
}

app.get('/proxy', async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).send('No URL');
  if (!target.startsWith('http')) target = 'https://' + target;
  const wb = req.protocol + '://' + req.get('host');

  try {
    const response = await fetch(target, { headers: getBrowserHeaders(target), redirect: 'follow' });
    const ct = response.headers.get('content-type') || '';
    const finalUrl = response.url || target;

    const hdrs = {};
    response.headers.forEach((v, k) => {
      if (!['x-frame-options','content-security-policy','content-security-policy-report-only','strict-transport-security','content-encoding'].includes(k.toLowerCase())) hdrs[k] = v;
    });
    hdrs['access-control-allow-origin'] = '*';

    if (ct.includes('text/css')) {
      const css = rewriteCSS(await response.text(), finalUrl, wb);
      return res.set({...hdrs,'content-type':'text/css;charset=utf-8'}).send(css);
    }
    if (!ct.includes('text/html')) {
      const buf = await response.buffer();
      return res.set(hdrs).send(buf);
    }
    const html = rewriteHTML(await response.text(), finalUrl, wb);
    return res.set({...hdrs,'content-type':'text/html;charset=utf-8'}).send(html);

  } catch(e) {
    res.status(500).send(`<html><body style="background:#0a0a0f;color:#e2e8f0;font-family:monospace;padding:2rem">
      <h2 style="color:#ef4444">Could not load site</h2>
      <p>${e.message}</p>
      <p style="color:#64748b;margin-top:1rem">The site may block proxies or require login.</p>
    </body></html>`);
  }
});

app.use((req, res) => {
  const wb = req.protocol + '://' + req.get('host');
  const ref = req.headers['referer'] || '';
  if (ref.includes('/proxy?url=')) {
    try {
      const refUrl = new URL(ref);
      const origBase = decodeURIComponent(refUrl.searchParams.get('url') || '');
      if (origBase) {
        const abs = new URL(req.path + (req.query ? '?' + new URLSearchParams(req.query).toString() : ''), new URL(origBase).origin).href;
        return res.redirect(wb + '/proxy?url=' + encodeURIComponent(abs));
      }
    } catch(e) {}
  }
  res.status(404).send('Not found');
});

app.listen(process.env.PORT || 3000, () => console.log('Portal running'));
