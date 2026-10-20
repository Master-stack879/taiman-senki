// test.html を Firestore / Auth エミュレーター相手に実際に操作して確かめる
//   npm run test:page
// gstatic の Firebase SDK は node_modules/firebase の同じ版のファイルで代用する。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('test.html', root)));
  } catch { res.statusCode = 500; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/test.html?emulator`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('https://www.gstatic.com/firebasejs/**', async route => {
  const file = new URL(route.request().url()).pathname.split('/').pop();
  route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`node_modules/firebase/${file}`, root)) });
});
page.on('pageerror', e => console.log('pageerror:', e.message));

let failed = 0;
function check(ok, label) { console.log((ok ? 'ok   ' : 'FAIL ') + label); if (!ok) failed++; }
const logText = () => page.locator('#log').innerText();
async function waitLog(re) { await page.waitForFunction(r => new RegExp(r).test(document.getElementById('log').innerText), re.source); }

await page.goto(url);
await page.fill('#cfg', '{ apiKey: "demo-key", authDomain: "demo-taiman.firebaseapp.com", projectId: "demo-taiman" }');
await page.click('#connect');
await waitLog(/接続しました|接続エラー/);
check(/接続しました/.test(await logText()), '匿名ログインで接続できる');

await page.click('#bad');
await waitLog(/弾かれた数: \d+/);
let t = await logText();
check(!/通ってしまった|できてしまった/.test(t), '弾かれるべきデータがすべて弾かれる');
check(/弾かれた数: 9/.test(t), '入力チェックの9件が弾かれた（記録がまだ無いので変更・削除は省略）');

await page.fill('#name', 'Tester');
await page.fill('#floor', '42');
await page.click('#send');
await waitLog(/送信できました|弾かれました/);
check(/送信できました/.test(await logText()), '正しい記録を送れる');

await page.click('#top');
await waitLog(/上位を読み出しました|読み出しエラー/);
const rows = await page.locator('#ranking tr').allInnerTexts();
check(rows.length === 2 && /Tester\tkai\t42/.test(rows[1]), '上位に送った記録が出る: ' + JSON.stringify(rows[1]));

// 2回目は新しい匿名 ID で、記録があるので変更・削除まで確かめる
await page.evaluate(() => { document.getElementById('log').textContent = ''; });
await page.click('#bad');
await waitLog(/弾かれた数: \d+/);
t = await logText();
check(!/通ってしまった|できてしまった/.test(t) && /弾かれた数: 11/.test(t), '記録の変更・削除も弾かれる（計11件）');

// 新しい匿名 ID はまだ投稿していないので通る（＝上の確認は連続投稿よけで弾かれたのではない）
await page.click('#send');
await waitLog(/送信できました|弾かれました/);
check(/送信できました/.test(await logText()), '新しい ID からは送れる');

// 送信直後なので1回目から連続投稿で弾かれる
await page.click('#twice');
await waitLog(/1回目/);
check(/1回目も弾かれました/.test(await logText()), '60秒以内の再送信は弾かれる');

console.log((await logText()).split('\n').reverse().join('\n'));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
