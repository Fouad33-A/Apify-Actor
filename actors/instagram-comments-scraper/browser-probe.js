import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();
const input = await Actor.getInput() || {};
const browser = await chromium.launch({headless:true, executablePath:'/usr/bin/google-chrome', args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  for (const url of (input.postUrls || []).slice(0,3)) {
    const context = await browser.newContext({locale:'en-US',viewport:{width:1365,height:900}});
    const page = await context.newPage();
    const network = [], comments = new Map();
    page.on('response', async response => {
      if (!/instagram\.com\/api\/graphql/.test(response.url())) return;
      const item = {status:response.status(),method:response.request().method()};
      try {
        const body = await response.json();
        item.topKeys = Object.keys(body || {}).slice(0,12);
        item.dataKeys = Object.keys(body?.data || {}).slice(0,12);
        item.errors = JSON.stringify(body?.errors || body?.error || null).slice(0,350);
        item.paths = [];
        const queue = [{v:body,path:'root',depth:0}], visited = new Set();
        while(queue.length) {
          const {v,path,depth} = queue.pop();
          if (!v || typeof v !== 'object' || visited.has(v) || depth > 12) continue;
          visited.add(v);
          if (typeof v.text === 'string' && (v.pk || v.id) && (v.user?.username || v.owner?.username)) comments.set(String(v.pk || v.id), {id:String(v.pk || v.id),text:v.text,author:v.user?.username || v.owner?.username});
          for (const [k,child] of Object.entries(v)) {
            if (/comment|edge|page_info|cursor/i.test(k) && item.paths.length < 35) item.paths.push({path:(path+'.'+k).slice(0,170),type:Array.isArray(child)?'array:'+child.length:typeof child});
            if (child && typeof child === 'object') queue.push({v:child,path:path+'.'+k,depth:depth+1});
          }
        }
      } catch(e) {item.parseError=String(e.message).slice(0,150);}
      if (network.length < 40) network.push(item);
    });
    let navigationError = null;
    try {await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});} catch(e) {navigationError=String(e.message).slice(0,180);}
    await page.waitForTimeout(3500);
    const before = (await page.locator('body').innerText().catch(()=>'')); 
    const buttons = await page.getByRole('button').allTextContents().catch(()=>[]);
    const steps = [];
    for(let i=0;i<Math.min(10,Math.max(1,Number(input.maxScrolls)||4));i++) {
      const load = page.getByRole('button',{name:/load more comments/i});
      const count = await load.count().catch(()=>0);
      let error = null;
      if(count) await load.first().evaluate(el=>el.click()).catch(e=>{error=String(e.message).slice(0,150);});
      await page.mouse.wheel(0,600);
      await page.waitForTimeout(1500);
      steps.push({step:i+1,buttonCount:count,error,textLength:(await page.locator('body').innerText().catch(()=>'' )).length,networkResponses:network.length,networkComments:comments.size});
    }
    await Actor.pushData({url,navigationError,beforeLength:before.length,beforeExcerpt:before.slice(0,550),buttons:buttons.slice(0,30),steps,network,networkComments:comments.size,commentSample:[...comments.values()].slice(0,5)});
    await context.close();
  }
} finally {await browser.close();await Actor.exit();}
