import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const DEFAULT_DOC_IDS = ['27837656105907150', '6974885689225067'];
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function mediaId(sc) { let n = 0n; for (const ch of sc) { const i = alphabet.indexOf(ch); if (i < 0) throw new Error('Invalid shortcode'); n = n * 64n + BigInt(i); } return n.toString(); }
function shortcode(value) {
  const s = String(value).trim();
  if (/^[A-Za-z0-9_-]{5,30}$/.test(s)) return s;
  const m = s.match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m?.[1] || null;
}
function inspect(body) {
  const paths = [], comments = new Map(), cursors = [];
  const queue = [{value:body,path:'root',depth:0}], seen = new Set();
  while (queue.length) {
    const {value,path,depth} = queue.pop();
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 15) continue;
    seen.add(value);
    const author = value.user?.username || value.owner?.username;
    if (typeof value.text === 'string' && (value.pk || value.id) && author) {
      const id = String(value.pk || value.id);
      comments.set(id, {id,author,text:value.text.slice(0,160)});
    }
    if (value.page_info && typeof value.page_info === 'object') cursors.push({path:path+'.page_info',hasNext:!!value.page_info.has_next_page,hasCursor:!!value.page_info.end_cursor});
    for (const [key,child] of Object.entries(value)) {
      if (/comment|edge|page_info|cursor/i.test(key) && paths.length < 35) paths.push({path:(path+'.'+key).slice(0,150),kind:Array.isArray(child)?'array:'+child.length:typeof child});
      if (child && typeof child === 'object') queue.push({value:child,path:path+'.'+key,depth:depth+1});
    }
  }
  return {paths,commentCount:comments.size,commentIds:[...comments.keys()].slice(0,30),cursors};
}
await Actor.init();
try {
  const input = await Actor.getInput() || {};
  const urls = (input.postUrls || []).slice(0,3);
  const docs = (input.docIds || DEFAULT_DOC_IDS).map(String).slice(0,5).filter(s=>/^\d{6,25}$/.test(s));
  const proxyMode = input.proxyMode === 'none' ? 'none' : 'datacenter';
  const proxy = proxyMode === 'none' ? null : await Actor.createProxyConfiguration();
  for (const raw of urls) {
    const sc = shortcode(raw);
    if (!sc) { await Actor.pushData({sourceUrl:raw,error:'invalid_shortcode'}); continue; }
    const id = mediaId(sc);
    const jar = new CookieJar();
    const client = gotScraping.extend({cookieJar:jar,proxyUrl:proxy ? await proxy.newUrl() : undefined,retry:{limit:0},timeout:{request:20000},headerGeneratorOptions:{browsers:[{name:'chrome',minVersion:130}],devices:['desktop'],locales:['en-US']}});
    const referer = 'https://www.instagram.com/p/'+sc+'/';
    const headers = {'accept':'*/*','accept-language':'en-US,en;q=0.9','x-ig-app-id':'936619743392459','x-requested-with':'XMLHttpRequest','referer':referer,'origin':'https://www.instagram.com','content-type':'application/x-www-form-urlencoded'};
    const variants = [
      {name:'media_id',variables:{media_id:id,first:50}},
      {name:'shortcode',variables:{shortcode:sc,first:50}},
      {name:'id',variables:{id,first:50}},
    ];
    for (const docId of docs) for (const variant of variants) {
      const form = new URLSearchParams({doc_id:docId,variables:JSON.stringify(variant.variables)});
      const row = {sourceUrl:raw,shortcode:sc,mediaId:id,docId,variant:variant.name,proxyMode};
      try {
        const response = await client.post('https://www.instagram.com/api/graphql',{headers,body:form.toString(),throwHttpErrors:false,followRedirect:false});
        row.httpStatus=response.statusCode;
        row.contentType=response.headers['content-type'] || null;
        row.redirect=Boolean(response.headers.location);
        let body;
        try {body=JSON.parse(response.body);} catch {body=null;}
        row.isJson=Boolean(body);
        if (body) {
          row.topKeys=Object.keys(body).slice(0,12);
          row.dataKeys=Object.keys(body.data||{}).slice(0,12);
          row.errors=JSON.stringify(body.errors||body.error||null).slice(0,500);
          Object.assign(row,inspect(body));
        } else row.bodyPrefix=String(response.body).replace(/https?:\/\/[^\s"'<>]+:[^\s"'<>]+@/g,'https://***@').slice(0,100);
      } catch(e) {row.error=String(e.message).slice(0,220);}
      await Actor.pushData(row);
      log.info('GRAPHQL_PROBE '+JSON.stringify({shortcode:sc,docId,variant:variant.name,status:row.httpStatus,comments:row.commentCount,error:row.error||row.errors}));
    }
  }
} finally {await Actor.exit();}
