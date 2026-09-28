// 临时脚本：定位 w() 资产函数定义（用完即删）
const fs = require('fs');
const js = fs.readFileSync('d:/fankangsong/srv-dashboard/node_modules/classicy/dist/classicy.es.js', 'utf8');
// NC 映射表前后文
const i = js.indexOf('"../../../../assets/img/icons/applications/internet-explorer/app.png"');
console.log('--- NC map context ---');
console.log(js.slice(Math.max(0, i - 600), i + 200));
// new URL 用法
let idx = js.indexOf('new URL(');
let n = 0;
while (idx >= 0 && n < 3) {
  console.log('--- new URL at', idx, '---');
  console.log(js.slice(Math.max(0, idx - 250), idx + 250));
  idx = js.indexOf('new URL(', idx + 1);
  n++;
}
// import.meta.url
const u = js.indexOf('import.meta.url');
console.log('--- import.meta.url ---');
console.log(u < 0 ? 'NOT FOUND' : js.slice(Math.max(0, u - 300), u + 200));
