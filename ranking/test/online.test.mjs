// ゲーム本体（index.html）のオンライン対戦を、Firestore / Auth エミュレーター相手にブラウザで操作して確かめる
//   npm run test:online
// ランダムマッチ（決着まで）・ルーム（観戦・勝敗予想・再読み込みからの復帰・再戦・降参）・時間切れの不戦勝・
// 技がそろったまま期限が過ぎた試合の再開・名前を文字として表示・ネットにつながらないとき。最後に読み書きの回数を出す。
// gstatic の Firebase SDK は node_modules/firebase の同じ版のファイルで代用する。index.html?rank-emulator でエミュレーターにつながる。
// 読み書きの回数は、Firestore の SDK を数える薄い包み（下の COUNT_SHIM）に差し替えて数える（ゲームのコードは変えない）。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, Timestamp } from 'firebase/firestore';

const root = new URL('../../', import.meta.url);
const server = createServer(async (req, res) => {
  try {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(await readFile(new URL('index.html', root)));
  } catch { res.statusCode = 500; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?rank-emulator`;

const env = await initializeTestEnvironment({
  projectId: 'demo-taiman',
  firestore: { host: '127.0.0.1', port: 8080, rules: await readFile(new URL('ranking/firestore.rules', root), 'utf8') },
});
await env.clearFirestore();
const admin = async fn => { let out; await env.withSecurityRulesDisabled(async ctx => { out = await fn(ctx.firestore()); }); return out; };

// 読み書きの回数を数える包み：サーバーから届いた文書（リスナー・get・クエリ・トランザクションの読み取り）と、書いた文書の数
const COUNT_SHIM = `
import * as F from './firebase-firestore-real.js';
export * from './firebase-firestore-real.js';
const C = window.__fsCount = window.__fsCount || { r: 0, w: 0 };
const docKey = s => s.exists() ? JSON.stringify(s.data()) : '-';
export function onSnapshot(ref, ...args) {
  const i = args.findIndex(a => typeof a === 'function');
  const next = args[i];
  let last = null, first = true;
  args[i] = snap => {
    if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) {
      if ('docs' in snap) { const n = snap.docChanges().length; C.r += first ? Math.max(1, n) : n; first = false; }
      else { const k = docKey(snap); if (k !== last) { C.r++; last = k; } }
    }
    return next(snap);
  };
  return F.onSnapshot(ref, ...args);
}
export async function getDoc(ref) { const s = await F.getDoc(ref); C.r++; return s; }
export async function getDocs(q) { const s = await F.getDocs(q); C.r += Math.max(1, s.size); return s; }
export async function setDoc(...a) { const r = await F.setDoc(...a); C.w++; return r; }
export async function updateDoc(...a) { const r = await F.updateDoc(...a); C.w++; return r; }
export async function deleteDoc(...a) { const r = await F.deleteDoc(...a); C.w++; return r; }
export function writeBatch(db) {
  const b = F.writeBatch(db); let n = 0;
  return { set: (...a) => (n++, b.set(...a)), update: (...a) => (n++, b.update(...a)), delete: (...a) => (n++, b.delete(...a)),
    commit: async () => { const r = await b.commit(); C.w += n; return r; } };
}
export function runTransaction(db, fn, opt) {
  return F.runTransaction(db, async tx => {
    let r = 0, w = 0;
    const t = { get: async x => { r++; return tx.get(x); }, set: (...a) => (w++, tx.set(...a), t), update: (...a) => (w++, tx.update(...a), t), delete: (...a) => (w++, tx.delete(...a), t) };
    const out = await fn(t);
    C.r += r; C.w += w;   // 最後に成功した回の分（失敗してやり直した回の読み取りは数えない）
    return out;
  }, opt);
}
`;

const browser = await chromium.launch();
let failed = 0;
function check(ok, label) { console.log((ok ? 'ok   ' : 'FAIL ') + label); if (!ok) failed++; }

// ctx を渡すと同じブラウザ（匿名ログインの ID が同じ）で開き直す。online=false：SDK もサーバーも届かない
async function newPage({ online = true, ctx = null } = {}) {
  ctx ??= await browser.newContext();
  const page = await ctx.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async route => {
    const u = new URL(route.request().url());
    if (online && u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) {
      const file = u.pathname.split('/').pop();
      if (file === 'firebase-firestore.js') return route.fulfill({ contentType: 'text/javascript', body: COUNT_SHIM });
      const real = file === 'firebase-firestore-real.js' ? 'firebase-firestore.js' : file;
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`ranking/node_modules/firebase/${real}`, root)) });
    }
    route.abort();   // フォントなどの外部は読まない
  });
  if (!online) await page.route(/127\.0\.0\.1:(8080|9099)/, route => route.abort());
  page.on('pageerror', e => { console.log('pageerror:', e.stack); failed++; });
  await page.goto(url);
  return page;
}
const text = (page, sel) => page.locator(sel).innerText();
const visible = (page, sel) => page.locator(sel).isVisible();
const counts = page => page.evaluate(() => ({ ...(window.__fsCount || { r: 0, w: 0 }) }));
async function openOnline(page, name) {
  await page.click('#mode-online');
  await page.fill('#onName', name);
}
async function search(page, char) {
  await page.click('#onSearch');
  await page.click(`#onSearchRoster-${char}`);
}
const inBattle = page => page.waitForSelector('#battle:not([hidden])', { timeout: 40000 });
const resultShown = page => page.waitForSelector('#result:not([hidden])', { timeout: 40000 });
// 使える技をランダムに押す。押せたら true
const pickAny = page => page.evaluate(() => {
  const b = [...document.querySelectorAll('#cmds .cmd')].filter(x => !x.disabled);
  if (!b.length || !document.getElementById('result').hidden) return false;
  b[Math.floor(Math.random() * b.length)].click(); return true;
});
async function playToEnd(pages, maxMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const done = await Promise.all(pages.map(p => p.locator('#result:not([hidden])').count()));
    if (done.every(n => n === 1)) return true;
    for (const p of pages) await pickAny(p);
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}
const mid = page => page.evaluate(() => ON.mid);

try {
  // ---- ランダムマッチ：決着まで。名前は文字として表示 ----
  const a = await newPage(), b = await newPage();
  await openOnline(a, '<i>x</i>');
  await search(a, 'kai');
  check(/相手を探しています/.test(await text(a, '#onSearchMsg')), '「相手を探す」で待ち行列に入る');
  await new Promise(r => setTimeout(r, 1500));
  await openOnline(b, 'ぼぶ');
  await search(b, 'gard');
  await Promise.all([inBattle(a), inBattle(b)]);
  check(true, 'ランダムマッチで2人が対戦に入る');
  const m1 = await mid(a);
  check(m1 && m1 === await mid(b), '同じ試合に割り当てられる');
  const tagB = await text(b, '#fe .tag');
  check(tagB.includes('<i>x</i>') && await b.locator('#fe .tag i').count() === 0, '相手の名前を文字のまま表示する: ' + tagB);
  check((await text(a, '#fe .tag')).includes('ぼぶ'), '相手の名前を表示');
  await a.waitForSelector('#onTimer:not([hidden])');
  check(/残り \d+秒/.test(await text(a, '#onTimer')), '残り時間を表示: ' + await text(a, '#onTimer'));
  const q = await admin(db => getDocs(collection(db, 'queue')));
  check(q.size === 0, '対戦が決まったら待ち行列は空になる（残り ' + q.size + '）');
  const c0 = [await counts(a), await counts(b)];
  check(await playToEnd([a, b]), '決着まで遊べる');
  const ta = await text(a, '#resTitle'), tb = await text(b, '#resTitle');
  check((ta === '勝利！' && tb === '敗北…') || (ta === '敗北…' && tb === '勝利！') || (ta === '引き分け' && tb === '引き分け'), `両者の結果が合う（${ta} / ${tb}）`);
  const md = (await admin(db => getDoc(doc(db, 'matches', m1)))).data();
  check(md.over && md.end === 'ko' && (md.st.A.hp === 0 || md.st.B.hp === 0), '決着がサーバーに残る（HP は 0 で保存）');
  const c1 = [await counts(a), await counts(b)];
  const turns = md.turn;
  const r = c1[0].r + c1[1].r - c0[0].r - c0[1].r, w = c1[0].w + c1[1].w - c0[0].w - c0[1].w;
  const ra = c1[0].r + c1[1].r, wa = c1[0].w + c1[1].w;
  console.log(`     読み書き（ランダムマッチ・観戦なし・${turns}ターン）：対戦中 読み取り${r}・書き込み${w}（1ターンあたり 読み取り${(r / turns).toFixed(1)}・書き込み${(w / turns).toFixed(1)}）、マッチングを含む全体 読み取り${ra}・書き込み${wa}`);
  check(await visible(a, '#resBtn0') && /もう一度相手を探す/.test(await text(a, '#resBtn0')), 'ランダムマッチのあとは「もう一度相手を探す」');
  check(await a.evaluate(() => localStorage.getItem('taiman-senki:online')) === null, '決着したら復帰用の保存は消える');

  // ---- ルーム：作る・参加・観戦・予想・再読み込みから復帰・再戦・降参 ----
  const hctx = await browser.newContext(), gctx = await browser.newContext();
  const h = await newPage({ ctx: hctx }), s = await newPage();
  let g = await newPage({ ctx: gctx });
  await openOnline(h, 'ひろ');
  await h.click('#onCreate');
  await h.waitForSelector('#onLobby:not([hidden])', { timeout: 30000 });
  const code = await text(h, '#onCodeShow');
  check(/^[a-hjkmnp-z2-9]{5}$/.test(code), 'ルームコード（5文字）: ' + code);
  await openOnline(g, 'げん');
  await g.fill('#onCode', code); await g.click('#onJoinForm button[type=submit]');
  await g.waitForSelector('#onRole:not([hidden])', { timeout: 30000 });
  await g.click('#rolePlayer');
  await g.waitForSelector('#onLobby:not([hidden])');
  // 観戦者は招待URL から
  await s.goto(url + '&room=' + code);
  await s.fill('#onName', 'しー');
  await s.click('#onJoinForm button[type=submit]');
  await s.waitForSelector('#onRole:not([hidden])', { timeout: 30000 });
  check(await s.locator('#rolePlayer').isDisabled(), '満席なら観戦だけ選べる');
  await s.click('#roleSpec');
  await s.waitForSelector('#specHint:not([hidden])');
  await h.waitForFunction(() => /げん/.test(document.getElementById('onStatus').textContent));
  check(/げん/.test(await text(h, '#onStatus')), 'ロビーに相手の名前');
  await h.click('#onRoster-kai'); await g.click('#onRoster-rin');
  await Promise.all([inBattle(h), inBattle(g), inBattle(s)]);
  check(true, '両者がキャラを選ぶと対戦が始まり、観戦者も観戦画面へ');
  const rm1 = await mid(h);
  const s0 = await counts(s);
  await s.waitForSelector('#pred-A');
  await s.click('#pred-A');
  await h.waitForFunction(() => /勝敗予想 ひろ 1 : 0 げん/.test(document.getElementById('predBar').textContent), null, { timeout: 20000 });
  check(true, '観戦者の勝敗予想がプレイヤーにも見える: ' + await text(h, '#predBar'));
  // 1ターン目：h が選んだあと g を再読み込み → 「対戦に戻る」で同じ試合へ
  await h.waitForSelector('#cmd-0'); await h.click('#cmd-0');
  await g.close();
  g = await newPage({ ctx: gctx });
  await g.click('#mode-online');
  await g.waitForSelector('#onResumeBox:not([hidden])', { timeout: 30000 });
  check(/ルーム/.test(await text(g, '#onResumeText')), '再読み込みすると「ルームに戻る」が出る');
  await g.click('#onResume');
  await inBattle(g);
  check(await mid(g) === rm1, '同じ試合に戻る');
  check(await playToEnd([h, g]), '戻ったあとも決着まで遊べる');
  await resultShown(s);
  const s1 = await counts(s), rmTurns = (await admin(db => getDoc(doc(db, 'matches', rm1)))).data().turn;
  console.log(`     読み書き（観戦者1人・${rmTurns}ターン・予想1件）：読み取り${s1.r - s0.r}・書き込み${s1.w - s0.w}（1ターンあたり 読み取り${((s1.r - s0.r) / rmTurns).toFixed(1)}）`);
  const st = await text(s, '#resTitle');
  check(/予想的中！|予想はずれ…|勝利|引き分け/.test(st), '観戦者にも結果（予想の当たり外れ）: ' + st);
  // 再戦：両者が押すと始まる
  await h.click('#resBtn0');
  await h.waitForFunction(() => /相手の準備を待っています/.test(document.getElementById('resNote').textContent), null, { timeout: 20000 });
  check(true, '片方だけ再戦を押すと相手を待つ');
  await g.click('#resBtn0');
  await h.waitForFunction(m => ON.mid && ON.mid !== m && !document.getElementById('battle').hidden && document.getElementById('result').hidden, rm1, { timeout: 30000 });
  await g.waitForFunction(m => ON.mid && ON.mid !== m && document.getElementById('result').hidden, rm1, { timeout: 30000 });
  await s.waitForFunction(m => ON.mid && ON.mid !== m && document.getElementById('result').hidden, rm1, { timeout: 30000 });
  check(true, '両者が再戦を押すと次の試合が始まり、観戦者も切り替わる');
  // 降参
  await h.click('#quit');
  await h.click('#result button:has-text("降参する")');
  await resultShown(g);
  check(await text(g, '#resTitle') === '勝利！' && /降参/.test(await text(g, '#resSub')), '対戦中に退出すると相手の勝ち（降参）: ' + await text(g, '#resSub'));
  await g.waitForFunction(() => /参加を待っています/.test(document.getElementById('onStatus')?.textContent || '') || true);
  const room = (await admin(db => getDoc(doc(db, 'rooms', code)))).data();
  check(room.seats.A === null, '退出した人の席は空く');

  // ---- 時間切れ：選んだ側の不戦勝 ----
  const c = await newPage(), d = await newPage();
  await openOnline(c, 'しろう'); await search(c, 'mira');
  await new Promise(r => setTimeout(r, 1500));
  await openOnline(d, 'だい'); await search(d, 'doran');
  await Promise.all([inBattle(c), inBattle(d)]);
  const m3 = await mid(c);
  await c.waitForSelector('#cmd-0'); await c.click('#cmd-0');
  await c.waitForFunction(() => /相手の選択を待っています/.test(document.getElementById('cmds').textContent));
  // 期限を過ぎたことにする（ターン開始を80秒前に）
  await admin(db => updateDoc(doc(db, 'matches', m3), { tt: Timestamp.fromMillis(Date.now() - 80_000) }));
  await Promise.all([resultShown(c), resultShown(d)]);
  check(await text(c, '#resTitle') === '勝利！' && /不戦勝/.test(await text(c, '#resSub')), '期限までに選ばなかった相手に不戦勝: ' + await text(c, '#resSub'));
  check(await text(d, '#resTitle') === '敗北…' && /時間内に技を選ばなかった/.test(await text(d, '#resSub')), '選ばなかった側は負け: ' + await text(d, '#resSub'));

  // ---- 技がそろったまま期限が過ぎても、戻ってきた方が計算して続けられる ----
  const ectx = await browser.newContext(), fctx = await browser.newContext();
  let e = await newPage({ ctx: ectx }), f = await newPage({ ctx: fctx });
  await openOnline(e, 'えり'); await search(e, 'shizuku');
  await new Promise(r => setTimeout(r, 1500));
  await openOnline(f, 'ふみ'); await search(f, 'kai');
  await Promise.all([inBattle(e), inBattle(f)]);
  const m4 = await mid(e);
  await e.close(); await f.close();
  // 両者とも選んだところで閉じた（計算されないまま期限切れ）ことにする
  await admin(async db => {
    await setDoc(doc(db, 'matches', m4, 'picks', 'A'), { turn: 1, idx: 0 });
    await setDoc(doc(db, 'matches', m4, 'picks', 'B'), { turn: 1, idx: 0 });
    await updateDoc(doc(db, 'matches', m4), { ready: { A: 1, B: 1 }, tt: Timestamp.fromMillis(Date.now() - 300_000) });
  });
  e = await newPage({ ctx: ectx });
  await e.click('#mode-online');
  await e.waitForSelector('#onResumeBox:not([hidden])', { timeout: 30000 });
  await e.click('#onResume');
  await e.waitForFunction(() => ON.m && (ON.m.turn === 2 || ON.m.over), null, { timeout: 30000 });
  const m4d = (await admin(db => getDoc(doc(db, 'matches', m4)))).data();
  check(m4d.lt === 1 && (m4d.turn === 2 || m4d.over === 'A' || m4d.over === 'B' || m4d.over === 'draw') && m4d.end !== 'timeout', '戻ってきた方が1ターン目を計算して続ける（時間切れにはならない）');
  await e.waitForSelector('#onTimer:not([hidden])');
  check(/残り/.test(await text(e, '#onTimer')), '新しいターンの期限は計算した時刻から: ' + await text(e, '#onTimer'));

  // ---- ネットにつながらない ----
  const off = await newPage({ online: false });
  await openOnline(off, 'おふ');
  await search(off, 'kai');
  await off.waitForFunction(() => /探せませんでした/.test(document.getElementById('onSearchMsg').textContent), null, { timeout: 40000 });
  check(true, 'つながらないときは分かるように出す: ' + await text(off, '#onSearchMsg'));
  await off.click('#onBack');
  await off.click('#onBack');
  await off.click('#mode-cpu');
  check(await visible(off, '#pick'), 'つながらなくても CPU 対戦などはそのまま遊べる');
} finally {
  await browser.close();
  await env.cleanup();
  server.close();
}
console.log(failed ? `\n${failed} 件失敗` : '\nすべて成功');
process.exit(failed ? 1 : 0);
