// ゲーム本体（index.html）の短い引き継ぎコードを、Firestore / Auth エミュレーター相手にブラウザで操作して確かめる
//   npm run test:transfer
// gstatic の Firebase SDK は node_modules/firebase の同じ版のファイルで代用する。index.html?rank-emulator でエミュレーターにつながる。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';

const root = new URL('../../', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('index.html', root)));
  } catch { res.statusCode = 500; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?rank-emulator`;

// 期限切れのコードを作るのに、ルールを通さずに書き込む
const env = await initializeTestEnvironment({
  projectId: 'demo-taiman',
  firestore: { host: '127.0.0.1', port: 8080, rules: await readFile(new URL('ranking/firestore.rules', root), 'utf8') },
});
await env.clearFirestore();

const browser = await chromium.launch();
let failed = 0;
function check(ok, label) { console.log((ok ? 'ok   ' : 'FAIL ') + label); if (!ok) failed++; }

// online=false：Firebase の SDK もサーバーも届かない状態（ネットにつながらない）
async function newPage(online = true) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async route => {
    const u = new URL(route.request().url());
    if (online && u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) {
      const file = u.pathname.split('/').pop();
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`ranking/node_modules/firebase/${file}`, root)) });
    }
    route.abort();   // フォント・PeerJS などの外部は読まない
  });
  if (!online) await page.route(/127\.0\.0\.1:(8080|9099)/, route => route.abort());
  page.on('pageerror', e => { console.log('pageerror:', e.message); failed++; });
  await page.goto(url);
  return page;
}
const text = (page, sel) => page.locator(sel).innerText();
const saved = page => page.evaluate(() => JSON.stringify({ meta: rgMeta(), best: rgBest(), endless: rgEndlessBest() }));
async function openCode(page) {
  await page.click('#mode-rogue');
  await page.waitForSelector('#rgTcIssue');
}
// 引き継ぎコードを入れて「読み込む」。確認画面が出るか、メッセージが出るまで待つ
async function enter(page, code) {
  await page.click('#rgTcLoad');
  await page.fill('#rgTcInput', code);
  await page.click('#rgTcGo');
  await page.waitForFunction(() => !document.getElementById('result').hidden
    || (document.getElementById('rgTcMsg')?.className === 'err' && document.getElementById('rgTcMsg').textContent), null, { timeout: 30000 });
}
const confirmShown = page => page.locator('#result:not([hidden])').count().then(n => n === 1);

try {
  // ---- 元の端末：記録を作って発行 ----
  const a = await newPage();
  await a.evaluate(() => {
    const m = rgNewMeta();
    m.souls = 37; m.ups[RG_UPGRADES[0].id] = 2; m.ups[RG_UPGRADES[1].id] = 1;
    m.cleared.easy = ['kai', 'mira']; m.cleared.normal = ['kai']; m.cleared.hard = ['kai'];
    lsSet(RG_META, m);
    lsSet(RG_BEST, { easy: { clears: 3, bestFloor: 5 }, normal: { clears: 1, bestFloor: 5 }, hard: { clears: 1, bestFloor: 5 } });
    lsSet(RG_ENDLESS_BEST, { v: 1, best: { kai: 23, mira: 7 } });
  });
  await a.reload();
  await openCode(a);
  const panel = await text(a, '#rgCode');
  check(panel.includes('同じブラウザで遊ぶ間は、記録は自動で保存されます。ブラウザや端末を変えるときは、今の端末でセーブコードを書き出し、新しい端末で読み込んでください。'), '説明文1を常に表示');
  check(panel.includes('引き継ぎコードの有効期限は発行から7日間です。1回使うと無効になります。'), '説明文2を常に表示');
  await a.click('#rgTcIssue');
  await a.waitForSelector('#rgTcCode', { timeout: 30000 });
  const shown = await a.inputValue('#rgTcCode');
  check(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(shown), '8文字のコードを4文字ずつ区切って表示（0/O・1/I/L なし）: ' + shown);
  const until = await text(a, '#rgTcUntil');
  const exp = new Date(Date.now() + 7 * 864e5);
  check(until === `${exp.getMonth() + 1}/${exp.getDate()} ${String(exp.getHours()).padStart(2, '0')}:${String(exp.getMinutes()).padStart(2, '0')} まで有効`
    || /^\d+\/\d+ \d\d:\d\d まで有効$/.test(until) && Math.abs(new Date(`${exp.getFullYear()}/${until.split(' まで')[0]}`) - exp) < 120_000, '有効期限の日時（7日後）を表示: ' + until);
  await a.click('#rgTcCopy');
  await a.waitForFunction(() => /コピー/.test(document.getElementById('rgTcMsg').textContent));
  check(/コピーしました|コピーしてください/.test(await text(a, '#rgTcMsg')), 'コピーボタン: ' + await text(a, '#rgTcMsg'));
  const before = await saved(a);
  // 続けて発行すると間隔を空けるよう言われる
  await a.click('#rgTcIssue');
  await a.waitForFunction(() => document.getElementById('rgTcMsg')?.className === 'err', null, { timeout: 30000 });
  check(/1分ほど待って/.test(await text(a, '#rgTcMsg')), '連続の発行は弾かれる: ' + await text(a, '#rgTcMsg'));

  // ---- 新しい端末：区切りなし・小文字・全角でも読める。確認画面で「やめる」を押したらコードは残る ----
  const b = await newPage();
  await openCode(b);
  const loose = ' ' + shown.replace('-', '').toLowerCase().replace(/[a-z0-9]/, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)) + ' ';
  await enter(b, loose);
  check(await confirmShown(b), `入力の揺れ（${JSON.stringify(loose)}）を許して、確認画面を出す`);
  const sub = await text(b, '#result');
  check(/今の戦魂0、強化0段階が、コードの内容（戦魂37、強化3段階）に置き換わります/.test(sub), 'セーブコードと同じ確認文: ' + sub.replace(/\n/g, ' '));
  await b.click('#result button:has-text("やめる")');
  check(JSON.parse(await saved(b)).meta.souls === 0, 'やめたら置き換わらない');
  await enter(b, shown);
  check(await confirmShown(b), 'やめたあとは同じコードをまた使える');
  await b.click('#result button:has-text("置き換える")');
  await b.waitForFunction(() => /引き継ぎコードで読み込みました/.test(document.getElementById('rgCode')?.innerText || ''), null, { timeout: 30000 });
  check(await saved(b) === before, '戦魂・強化・解放・記録・回廊の記録が元の端末と同じになる');
  check(/37/.test(await text(b, '#rgBody')), '画面にも反映される（戦魂37）');

  // ---- 2回目は使えない ----
  const c = await newPage();
  await openCode(c);
  await enter(c, shown);
  check(!(await confirmShown(c)) && /使用済み/.test(await text(c, '#rgTcMsg')) && /セーブコード/.test(await text(c, '#rgTcMsg')), '同じコードは2回目には使えない: ' + await text(c, '#rgTcMsg'));
  check(JSON.parse(await saved(c)).meta.souls === 0, '使えなかったときは何も変わらない');

  // ---- 期限切れ・存在しない・形が違う ----
  const save = await a.evaluate(() => rgExportCode());
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'transfers', 'QRST2345'), { save, at: Timestamp.fromMillis(Date.now() - 7 * 864e5 - 60_000) });
  });
  await enter(c, 'QRST-2345');
  check(!(await confirmShown(c)) && /有効期限/.test(await text(c, '#rgTcMsg')), '期限切れのコードは使えない: ' + await text(c, '#rgTcMsg'));
  await enter(c, 'ZZZZ-2222');
  check(/見つかりませんでした/.test(await text(c, '#rgTcMsg')), '存在しないコード: ' + await text(c, '#rgTcMsg'));
  await enter(c, 'K7MQ-2XP0');
  check(/使わない文字/.test(await text(c, '#rgTcMsg')), '使わない文字が入っている: ' + await text(c, '#rgTcMsg'));
  await enter(c, 'K7MQ-2X');
  check(/8文字/.test(await text(c, '#rgTcMsg')), '文字数が違う: ' + await text(c, '#rgTcMsg'));
  check(JSON.parse(await saved(c)).meta.souls === 0, 'どの場合も何も変わらない');

  // ---- ネットにつながらない：分かるように出し、長いセーブコードは今までどおり使える ----
  const d = await newPage(false);
  await openCode(d);
  await d.click('#rgTcIssue');
  await d.waitForFunction(() => document.getElementById('rgTcMsg')?.className === 'err', null, { timeout: 30000 });
  check(/接続できませんでした/.test(await text(d, '#rgTcMsg')) && /セーブコード/.test(await text(d, '#rgTcMsg')), 'オフラインで発行：接続できない・セーブコードを案内: ' + await text(d, '#rgTcMsg'));
  await enter(d, shown);
  check(/接続できませんでした/.test(await text(d, '#rgTcMsg')), 'オフラインで読み込み：接続できないと出る');
  await d.click('#rgImport');
  await d.fill('#rgCodeText', save);
  await d.click('#rgCodeLoad');
  await d.click('#result button:has-text("置き換える")');
  await d.waitForFunction(() => /セーブコードを読み込みました/.test(document.getElementById('rgCode')?.innerText || ''));
  check(await saved(d) === before, 'オフラインでも長いセーブコードで移せる');
} catch (e) {
  console.log('FAIL', e.message); failed++;
}
await browser.close();
await env.cleanup();
server.close();
console.log(failed ? `${failed} 件失敗` : 'すべて成功');
process.exit(failed ? 1 : 0);
