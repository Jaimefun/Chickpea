const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function getHeaders(targetUrl) {
  const origin = new URL(targetUrl).origin;
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    'Referer': origin + '/'
  };
}

function proxyUrl(u, base, wb) {
  try {
    if (!u) return u;
    if (u.startsWith('data:')) return u;
    if (u.startsWith('blob:')) return u;
    if (u.startsWith('javascript:')) return u;
    if (u.startsWith('#')) return u;
    if (u.startsWith(wb)) return u;
    return wb + '/proxy?url=' + encodeURIComponent(new URL(u, base).href);
  } catch (e) {
    return u;
  }
}

function rewriteCSS(css, base, wb) {
  return css.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, function(m, u) {
    return 'url("' + proxyUrl(u.trim(), base, wb) + '")';
  });
}

function rewriteHTML(html, base, wb) {
  // Remove CSP meta tags
  html = html.replace(/<meta[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  // Rewrite attributes
  html = html.replace(/(\s)(src|href|action|data-src)(\s*=\s*)(['"])((?!data:|blob:|javascript:|#)[^'"]+)\4/gi, function(match, space, attr, eq, quote, val) {
    try {
      var abs = new URL(val, base).href;
      return space + attr + eq + quote + wb + '/proxy?url=' + encodeURIComponent(abs) + quote;
    } catch (e) {
      return match;
    }
  });

  // Inject script
  var script = '<script>(function(){' +
    'var W="' + wb + '",B="' + base + '";' +
    'function px(u){' +
      'if(!u||u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("javascript:")||u.startsWith("#")||u.startsWith(W))return u;' +
      'try{return W+"/proxy?url="+encodeURIComponent(new URL(u,B).href);}catch(e){return u;}' +
    '}' +
    'var _f=window.fetch.bind(window);' +
    'window.fetch=function(i,o){if(typeof i==="string")i=px(i);return _f(i,o);};' +
    'var _o=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(m,u){arguments[1]=px(u);return _o.apply(this,arguments);};' +
    'document.addEventListener("click",function(e){' +
      'var el=e.target;' +
      'while(el&&el.tagName!=="A")el=el.parentElement;' +
      'if(!el)return;' +
      'var h=el.getAttribute("href");' +
      'if(!h||h.startsWith("javascript:")||h==="#")return;' +
      'e.preventDefault();e.stopPropagation();' +
      'try{top.postMessage({type:"nav",url:new URL(h,B).href},"*");}catch(e){}' +
    '},true);' +
    'document.addEventListener("submit",function(e){' +
      'var f=e.target,a=f.getAttribute("action")||B;' +
      'e.preventDefault();' +
      'var u;try{u=new URL(a,B).href;}catch(e){u=B;}' +
      'if(f.method&&f.method.toLowerCase()==="get"){var p=new URLSearchParams(new FormData(f)).toString();u=u.split("?")[0]+(p?"?"+p:"");}' +
      'top.postMessage({type:"nav",url:u},"*");' +
    '},true);' +
  '})();<\/script>';

  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, '<head$1>' + script);
  } else {
    html = script + html;
  }

  return html;
}

app.get('/proxy', function(req, res) {
  var target = req.query.url;
  if (!target) return res.status(400).send('No URL');
  if (!target.startsWith('http')) target = 'https://' + target;

  var wb = req.protocol + '://' + req.get('host');

  fetch(target, { headers: getHeaders(target), redirect: 'follow' })
    .then(function(response) {
      var ct = response.headers.get('content-type') || '';
      var finalUrl = response.url || target;

      var hdrs = {};
      response.headers.forEach(function(v, k) {
        var skip = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'content-encoding'];
        if (skip.indexOf(k.toLowerCase()) === -1) hdrs[k] = v;
      });
      hdrs['access-control-allow-origin'] = '*';

      if (ct.includes('text/css')) {
        return response.text().then(function(css) {
          css = rewriteCSS(css, finalUrl, wb);
          hdrs['content-type'] = 'text/css;charset=utf-8';
          res.set(hdrs).send(css);
        });
      }

      if (!ct.includes('text/html')) {
        return response.buffer().then(function(buf) {
          res.set(hdrs).send(buf);
        });
      }

      return response.text().then(function(html) {
        html = rewriteHTML(html, finalUrl, wb);
        hdrs['content-type'] = 'text/html;charset=utf-8';
        res.set(hdrs).send(html);
      });
    })
    .catch(function(e) {
      res.status(500).send('<html><body style="background:#0a0a0f;color:#e2e8f0;font-family:monospace;padding:2rem"><h2 style="color:#ef4444">Could not load site</h2><p>' + e.message + '</p><p style="color:#64748b;margin-top:1rem">The site may block proxies or require login.</p></body></html>');
    });
});

app.use(function(req, res) {
  var wb = req.protocol + '://' + req.get('host');
  var ref = req.headers['referer'] || '';
  if (ref.includes('/proxy?url=')) {
    try {
      var refUrl = new URL(ref);
      var origBase = decodeURIComponent(refUrl.searchParams.get('url') || '');
      if (origBase) {
        var abs = new URL(req.path + req.search, new URL(origBase).origin).href;
        return res.redirect(wb + '/proxy?url=' + encodeURIComponent(abs));
      }
    } catch (e) {}
  }
  res.status(404).send('Not found');
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Portal running on port ' + PORT);
});
