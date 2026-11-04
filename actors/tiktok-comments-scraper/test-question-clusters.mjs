import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('./main.js',import.meta.url),'utf8');
const from=source.indexOf('function isQuestionText(');
const to=source.indexOf('function parseGenuineComment(');
const code=source.slice(from,to)+'\n globalThis.check = buildRepeatedQuestions;';
const context=vm.createContext({});vm.runInContext(code,context);
const row=(username,videoId,text)=>({username,videoId,commentText:text,creator:'example',videoUrl:`https://www.tiktok.com/@example/video/${videoId}`});
const passing=[row('a','111','Where can I buy this?'),row('b','111','Where can I buy this?'),row('c','222','Where can I buy this?')];
assert.equal(context.check(passing,3,2).length,1);
assert.equal(context.check(passing,3,2)[0].askerCount,3);
assert.equal(context.check(passing.map(r=>({...r,videoId:'111'})),3,2).length,0);
assert.equal(context.check(passing.map(r=>({...r,username:'a'})),3,2).length,0);
assert.equal(context.check([row('a','111','How does it work?'),row('b','222','Where do I buy it?'),row('c','333','Can it ship?')],3,2).length,0);
const reordered=[
 row('a','111','How to apply for student loans online?'),
 row('b','222','How can I apply online for student loans?'),
 row('c','222','How do I apply for online student loans?'),
];
assert.equal(context.check(reordered,3,2).length,1, 'reordered equivalent questions should cluster');
assert.equal(context.check(reordered,3,2)[0].exampleComments.length,3);
assert.equal(context.check([reordered[0], {...reordered[1],commentText:'Why apply online for student loans?'},reordered[2]],3,2).length,0, 'different intent must not cluster');
console.log('PASS: exact and conservative token-equivalent questions; strict distinct askers/videos; intent separation');