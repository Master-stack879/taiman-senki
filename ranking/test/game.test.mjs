// ゲーム本体（index.html）の無限回廊ランキングを、Firestore / Auth エミュレーター相手にブラウザで操作して確かめる
//   npm run test:game
// gstatic の Firebase SDK は node_modules/firebase の同じ版のファイルで代用する。index.html?rank-emulator でエミュレーターにつながる。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../../', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('index.html', root)));
  } catch { res.statusCode = 500; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?rank-emulator`;

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
  // むずかしいを踏破済みにして、無限回廊を出す
  await page.addInitScript(() => {
    if (!localStorage.getItem('taiman-senki:rogue-best')) localStorage.setItem('taiman-senki:rogue-best', JSON.stringify({ hard: { clears: 1, bestFloor: 5 } }));
  });
  await page.goto(url);
  return page;
}
const text = (page, sel) => page.locator(sel).innerText();
async function openEndless(page) {
  await page.click('#mode-rogue');
  await page.click('#rgDiff-endless');
  await page.waitForSelector('#rgName');
}
// 名前を入れてキャラを選び、指定の階で（HP1にして）負けるところまで進める
async function playAndLose(page, name, floor) {
  await page.fill('#rgName', name);
  await page.click('#rgRoster-kai');
  await page.waitForSelector('#rgGo');
  await page.evaluate(f => { R.floor = f - 1; rgShowMap(); }, floor);
  await page.click('#rgGo');
  await page.evaluate(() => { R.feathers = 0; ST.A.hp = 1; ST.B.hp = 9999; R.battle.state = clone(ST); });
  for (let i = 0; i < 200; i++) {
    if (await page.locator('#result:not([hidden]) button', { hasText: '結果を見る' }).count()) return;
    const b = page.locator('#cmds button:not([disabled])').first();
    if (await b.count()) await b.click().catch(() => {});
    await page.waitForTimeout(150);
  }
  throw new Error('戦闘が終わらない');
}
const pending = page => page.evaluate(() => JSON.parse(localStorage.getItem('taiman-senki:rank-pending')));

try {
  // ---- 1人目：名前のチェック・再読み込みしても1回だけ ----
  const p1 = await newPage();
  await p1.click('#mode-rogue');
  check(await p1.locator('#rgRanking').count() === 1, '無限回廊のカードの近くにランキングボタンがある');
  await p1.click('#rgRanking');
  await p1.waitForFunction(() => /まだ記録がありません|読み込めません/.test(document.getElementById('rgBody').innerText));
  check(/まだ記録がありません/.test(await text(p1, '#rgBody')), 'ランキング（記録0件）を読める');
  await p1.click('#rgBack');
  await p1.click('#rgDiff-endless');
  await p1.waitForSelector('#rgName');
  check(await p1.inputValue('#rgName') === '', '初回は名前が空');
  check((await text(p1, '#rgBody')).includes('ランキングは URL を知っている人なら誰でも見られます。本名ではなくニックネームにしてください'), '入力欄の近くにニックネームの注意がある');
  for (const [bad, label] of [['', '空'], ['　 　', '空白だけ'], ['ちんこ', '禁止語'], ['ﾁﾝｺ大好き', '禁止語（半角カナ）'], ['F u c k', '禁止語（空白入り）']]) {
    await p1.fill('#rgName', bad);
    await p1.click('#rgRoster-kai');
    check(await p1.locator('#rgGo').count() === 0 && (await text(p1, '#rgNameErr')).length > 0, `名前が${label}なら始められない: ${await text(p1, '#rgNameErr')}`);
  }
  check(await p1.getAttribute('#rgName', 'maxlength') === '12', '13文字以上は入らない（maxlength 12）');
  const evil = '<img src=x>';
  await playAndLose(p1, evil, 3);
  check(JSON.parse(await p1.evaluate(() => localStorage.getItem('taiman-senki:rogue-name'))) === evil, '名前を覚えている');
  const q = await pending(p1);
  check(q?.list?.length === 1 && q.list[0].floor === 3 && q.list[0].name === evil && q.list[0].char === 'kai', '負けが決まった時点で送る記録を端末に置く');
  // 結果画面を見る前に再読み込み → ローグライトの画面を開いたときに送る
  await p1.reload();
  await p1.click('#mode-rogue');
  await p1.waitForFunction(() => !localStorage.getItem('taiman-senki:rank-pending'), null, { timeout: 20000 });
  check(true, '再読み込みのあと、残っていた記録を送れた');
  // 送れていたのに端末の記録が残っていた場合（送信直後に閉じた）を再現：もう一度送っても2件にならない
  await p1.evaluate(q => localStorage.setItem('taiman-senki:rank-pending', JSON.stringify(q)), q);
  const out = await p1.evaluate(() => rkFlush());
  check(out[q.list[0].id] === 'ok' && !(await pending(p1)), 'すでに送れた記録は送れたものとして扱う: ' + JSON.stringify(out));
  await p1.click('#rgDiff-endless');
  await p1.waitForSelector('#rgName');
  check(await p1.inputValue('#rgName') === evil, '次回は前回の名前が最初から入っている');

  // ---- 2人目：結果画面で送る ----
  const p2 = await newPage();
  await openEndless(p2);
  await playAndLose(p2, 'Tester2', 12);
  await p2.click('#result button:has-text("結果を見る")');
  await p2.waitForFunction(() => /送信しました|送れませんでした/.test(document.getElementById('rgRankStatus')?.innerText || ''), null, { timeout: 20000 });
  check(/ランキングに送信しました（名前：Tester2）/.test(await text(p2, '#rgRankStatus')), '結果画面で送信できた: ' + await text(p2, '#rgRankStatus'));
  await p2.click('#rgRankView');
  await p2.waitForSelector('#rgRankTable');
  const rows = await p2.locator('#rgRankTable tbody tr').allInnerTexts();
  check(rows.length === 2, '記録は2件（1人目は再読み込み・送り直しをしても1件）: ' + rows.length);
  check(/^1\tTester2\tカイ\t12F\t\d{4}\/\d+\/\d+$/.test(rows[0]), '1位：到達階の高い順・名前・キャラ・到達階・日付: ' + JSON.stringify(rows[0]));
  check(rows[1].split('\t')[1] === evil && await p2.locator('#rgRankTable img').count() === 0, '名前は文字として表示する（HTML として解釈しない）');

  // ---- 3人目：ネットにつながらない ----
  const p3 = await newPage(false);
  await openEndless(p3);
  await playAndLose(p3, 'オフライン', 7);
  await p3.click('#result button:has-text("結果を見る")');
  await p3.waitForFunction(() => /送信しました|送れませんでした/.test(document.getElementById('rgRankStatus')?.innerText || ''), null, { timeout: 30000 });
  check(/ランキングに送れませんでした/.test(await text(p3, '#rgRankStatus')) && await p3.locator('#rgRankRetry:not([hidden])').count() === 1, '送れなかったことを結果画面に出す: ' + await text(p3, '#rgRankStatus'));
  check((await pending(p3))?.list?.length === 1, '送れなかった記録は端末に残す');
  check(/7F/.test(await text(p3, '#rgBody')) && /最高到達 7F/.test(await text(p3, '#rgBody')), '結果・記録はふつうに残る');
  await p3.click('#rgAgain');
  await p3.waitForSelector('#rgName');
  check(await p3.inputValue('#rgName') === 'オフライン', 'オフラインでも続けて遊べる（もう一度挑戦）');
  await p3.click('#rgBack');
  await p3.click('#rgRanking');
  await p3.waitForFunction(() => /読み込めませんでした|まだ記録/.test(document.getElementById('rgBody').innerText), null, { timeout: 30000 });
  check(/ランキングを読み込めませんでした/.test(await text(p3, '#rgBody')), 'オフラインでランキングを開くと読めないと出る');
} catch (e) {
  console.log('FAIL', e.message); failed++;
}
await browser.close();
server.close();
console.log(failed ? `${failed} 件失敗` : 'すべて成功');
process.exit(failed ? 1 : 0);
