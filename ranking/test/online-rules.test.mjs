// firestore.rules のオンライン対戦部分（matches / picks / preds / queue / rooms）の確認（Firestore エミュレーターで実行する）
//   npm test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, collection, writeBatch, serverTimestamp, Timestamp, setDoc, updateDoc,
  getDoc, getDocs, query, where, orderBy, limit, deleteDoc,
} from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-taiman-online',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const user = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const admin = fn => env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));

// index.html の CHARS と同じ値
const MAX = { kai: [140, 60], mira: [132, 100], gard: [190, 50], rin: [120, 70], shizuku: [120, 60], doran: [150, 50] };
const F = (id, over = {}) => ({ id, hp: MAX[id][0], mp: Math.floor(MAX[id][1] / 2), defUp: 0, evade: 0, atkUp: 0, poison: 0, stun: 0, guard: 0, counter: 0, ...over });
const ago = sec => Timestamp.fromMillis(Date.now() - sec * 1000);

// 試合をルールを通さずに置く（ターン・期限は自由に）
async function putMatch(mid, { turn = 1, tt = Timestamp.now(), at = Timestamp.now(), kind = 'room', here = { A: true, B: true }, ready = { A: 0, B: 0 }, over = null, A = F('kai'), B = F('gard') } = {}) {
  await admin(db => setDoc(doc(db, 'matches', mid), {
    kind, room: kind === 'room' ? 'abcde' : null, p: { A: 'pa', B: 'pb' }, names: { A: 'あかね', B: 'ぼぶ' },
    chars: { A: A.id, B: B.id }, st: { turn, A, B }, turn, ready, log: '[]', lt: turn - 1, tt, at, over, end: null, here,
  }));
}
async function putPick(mid, side, turn, idx = 0) {
  await admin(db => setDoc(doc(db, 'matches', mid, 'picks', side), { turn, idx }));
}
// ゲームと同じ形：技と ready の印を一括で
function pick(db, mid, side, turn, idx = 0) {
  const b = writeBatch(db);
  b.set(doc(db, 'matches', mid, 'picks', side), { turn, idx });
  b.update(doc(db, 'matches', mid), { ['ready.' + side]: turn });
  return b.commit();
}
// 計算結果の書き込み（盤面は差し替えられる）
function resolve(db, mid, turn, { A = F('kai', { hp: 100 }), B = F('gard', { hp: 150 }), over = null, end = null, nextTurn = over ? turn : turn + 1, tt = serverTimestamp() } = {}) {
  return updateDoc(doc(db, 'matches', mid), {
    st: { turn: nextTurn, A, B }, turn: nextTurn, log: '[["a","",[]]]', lt: turn, tt, over, end,
  });
}

test('オンライン：技を選ぶ・相手の技は自分が選ぶまで読めない・観戦者は読めない', async () => {
  await putMatch('m1');
  const a = user('pa'), b = user('pb'), s = user('spec');
  await assertSucceeds(pick(a, 'm1', 'A', 1, 3));
  // 自分の技は読める
  await assertSucceeds(getDoc(doc(a, 'matches/m1/picks/A')));
  // 相手（B）はまだ選んでいないので A の技を読めない。観戦者・ログインなしも読めない
  await assertFails(getDoc(doc(b, 'matches/m1/picks/A')));
  await assertFails(getDoc(doc(s, 'matches/m1/picks/A')));
  await assertFails(getDoc(doc(anon(), 'matches/m1/picks/A')));
  await assertFails(getDocs(collection(a, 'matches/m1/picks')));
  // B が選ぶと読める。A も B の技を読める
  await assertSucceeds(pick(b, 'm1', 'B', 1, 1));
  const got = await assertSucceeds(getDoc(doc(b, 'matches/m1/picks/A')));
  if (got.data().idx !== 3) throw new Error('技が違う');
  await assertSucceeds(getDoc(doc(a, 'matches/m1/picks/B')));
  await assertFails(getDoc(doc(s, 'matches/m1/picks/B')));
  // 試合ドキュメント（盤面・選択済みの印）は誰でも読める
  await assertSucceeds(getDoc(doc(anon(), 'matches/m1')));
  // 前のターンの技を出したままでは、相手の新しいターンの技は読めない
  await putMatch('m2', { turn: 2 });
  await putPick('m2', 'A', 1); await putPick('m2', 'B', 2);
  await assertFails(getDoc(doc(a, 'matches/m2/picks/B')));
});

test('オンライン：他人・観戦者は技も試合も書き換えられない', async () => {
  await putMatch('m1');
  const s = user('spec');
  // 他人の席の技
  await assertFails(pick(s, 'm1', 'A', 1));
  await assertFails(pick(user('pb'), 'm1', 'A', 1));
  await assertFails(setDoc(doc(s, 'matches/m1/picks/A'), { turn: 1, idx: 0 }));
  // 観戦者は ready・計算・降参・時間切れ・中身の書き換えのどれもできない
  await assertFails(updateDoc(doc(s, 'matches/m1'), { 'ready.A': 1 }));
  await putPick('m1', 'A', 1); await putPick('m1', 'B', 1);
  await assertFails(resolve(s, 'm1', 1));
  await assertFails(updateDoc(doc(s, 'matches/m1'), { over: 'A', end: 'left' }));
  await assertFails(updateDoc(doc(s, 'matches/m1'), { names: { A: 'x', B: 'y' } }));
  await assertFails(deleteDoc(doc(s, 'matches/m1')));
  await assertFails(updateDoc(doc(anon(), 'matches/m1'), { over: 'B', end: 'left' }));
  // プレイヤーでも、名前・座席・キャラは書き換えられない
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { names: { A: 'x', B: 'ぼぶ' } }));
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { 'p.B': 'pa2' }));
});

test('オンライン：技は1ターン1回・期限内・正しい番号だけ', async () => {
  await putMatch('m1');
  const a = user('pa');
  await assertFails(pick(a, 'm1', 'A', 1, 4));
  await assertFails(pick(a, 'm1', 'A', 2, 0));
  // ready の印なしでは書けない
  await assertFails(setDoc(doc(a, 'matches/m1/picks/A'), { turn: 1, idx: 0 }));
  await assertSucceeds(pick(a, 'm1', 'A', 1, 0));
  // 選び直しはできない
  await assertFails(pick(a, 'm1', 'A', 1, 2));
  // 期限（ターン開始から70秒）を過ぎた技は弾く
  await putMatch('m2', { tt: ago(71) });
  await assertFails(pick(a, 'm2', 'A', 1, 0));
  await putMatch('m3', { tt: ago(65) });
  await assertSucceeds(pick(a, 'm3', 'A', 1, 0));
});

test('オンライン：計算は両者の技がそろってから1回だけ', async () => {
  await putMatch('m1');
  const a = user('pa'), b = user('pb');
  await assertFails(resolve(a, 'm1', 1));
  await assertSucceeds(pick(a, 'm1', 'A', 1));
  await assertFails(resolve(a, 'm1', 1));
  await assertSucceeds(pick(b, 'm1', 'B', 1));
  await assertSucceeds(resolve(b, 'm1', 1));
  // 2回目（同じターンの計算をもう一度）は弾かれる
  await assertFails(resolve(a, 'm1', 1));
  await assertFails(resolve(a, 'm1', 2));
  // ターンを飛ばす・時刻をごまかす計算は弾く
  await putMatch('m2');
  await putPick('m2', 'A', 1); await putPick('m2', 'B', 1);
  await assertFails(resolve(a, 'm2', 1, { nextTurn: 3 }));
  await assertFails(resolve(a, 'm2', 1, { tt: Timestamp.fromMillis(Date.now() + 600_000) }));
  await assertSucceeds(resolve(a, 'm2', 1));
});

test('オンライン：盤面の範囲（HP 0〜最大HP、MP 0〜最大MP、キャラ）と決着の整合', async () => {
  const bad = {
    'HPが最大超え': { A: F('kai', { hp: 141 }) },
    'HPがマイナス': { B: F('gard', { hp: -5 }) },
    'MPが最大超え': { A: F('kai', { mp: 61 }) },
    'MPがマイナス': { B: F('gard', { mp: -1 }) },
    'HPが小数': { A: F('kai', { hp: 99.5 }) },
    'キャラのすり替え': { A: F('mira', { hp: 100 }) },
    '余計な項目': { A: { ...F('kai', { hp: 100 }), u: { hp: 999 } } },
    '状態異常の値がおかしい': { B: F('gard', { poison: 99 }) },
    '決着なのにHPが残っている': { over: 'A', end: 'ko' },
    'HPが0なのに決着していない': { B: F('gard', { hp: 0 }) },
    '勝者が逆': { B: F('gard', { hp: 0 }), over: 'B', end: 'ko' },
  };
  let i = 0;
  for (const [label, opt] of Object.entries(bad)) {
    const mid = 'mb' + i++;
    await putMatch(mid);
    await putPick(mid, 'A', 1); await putPick(mid, 'B', 1);
    await assertFails(resolve(user('pa'), mid, 1, opt), label);
  }
  // 境界：HP 0 と最大、MP 0 と最大は通る。決着は HP と合っていれば通る
  await putMatch('ok1');
  await putPick('ok1', 'A', 1); await putPick('ok1', 'B', 1);
  await assertSucceeds(resolve(user('pa'), 'ok1', 1, { A: F('kai', { hp: 140, mp: 0 }), B: F('gard', { hp: 1, mp: 50 }) }));
  await putMatch('ok2');
  await putPick('ok2', 'A', 1); await putPick('ok2', 'B', 1);
  await assertSucceeds(resolve(user('pb'), 'ok2', 1, { B: F('gard', { hp: 0 }), over: 'A', end: 'ko' }));
  await putMatch('ok3');
  await putPick('ok3', 'A', 1); await putPick('ok3', 'B', 1);
  await assertSucceeds(resolve(user('pa'), 'ok3', 1, { A: F('kai', { hp: 0 }), B: F('gard', { hp: 0 }), over: 'draw', end: 'ko' }));
  // 決着後はもう計算できない
  await putPick('ok2', 'A', 1);
  await assertFails(resolve(user('pa'), 'ok2', 1));
});

test('オンライン：時間切れ（期限前は不可、選んだ側の不戦勝、両者なしは引き分け）', async () => {
  // 期限前
  await putMatch('m1');
  await putPick('m1', 'A', 1);
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { over: 'A', end: 'timeout' }));
  // 期限後：選んだ A は不戦勝にできる。選んでいない B は自分の勝ちにできない。観戦者は不可
  await putMatch('m2', { tt: ago(71) });
  await putPick('m2', 'A', 1);
  await assertFails(updateDoc(doc(user('pb'), 'matches/m2'), { over: 'B', end: 'timeout' }));
  await assertFails(updateDoc(doc(user('pb'), 'matches/m2'), { over: 'draw', end: 'timeout' }));
  await assertFails(updateDoc(doc(user('spec'), 'matches/m2'), { over: 'A', end: 'timeout' }));
  await assertSucceeds(updateDoc(doc(user('pa'), 'matches/m2'), { over: 'A', end: 'timeout' }));
  // 前のターンの技は数えない
  await putMatch('m3', { turn: 3, tt: ago(71) });
  await putPick('m3', 'A', 3); await putPick('m3', 'B', 2);
  await assertSucceeds(updateDoc(doc(user('pa'), 'matches/m3'), { over: 'A', end: 'timeout' }));
  // 両者とも選んでいなければ引き分けだけ
  await putMatch('m4', { tt: ago(71) });
  await assertFails(updateDoc(doc(user('pa'), 'matches/m4'), { over: 'A', end: 'timeout' }));
  await assertSucceeds(updateDoc(doc(user('pb'), 'matches/m4'), { over: 'draw', end: 'timeout' }));
});

test('オンライン：両者の技がそろったまま期限を過ぎても、戻ってきた方が計算して続けられる', async () => {
  await putMatch('m1', { tt: ago(300) });
  await putPick('m1', 'A', 1); await putPick('m1', 'B', 1);
  // 時間切れにはできない（そろっているので）
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { over: 'A', end: 'timeout' }));
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { over: 'draw', end: 'timeout' }));
  // どちらでも計算できる。新しいターンの期限は今から
  await assertSucceeds(resolve(user('pb'), 'm1', 1));
  await assertSucceeds(pick(user('pa'), 'm1', 'A', 2));
});

test('オンライン：降参は本人だけ・相手の勝ちだけ', async () => {
  await putMatch('m1');
  await assertFails(updateDoc(doc(user('spec'), 'matches/m1'), { over: 'A', end: 'left' }));
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { over: 'A', end: 'left' }));
  await assertSucceeds(updateDoc(doc(user('pa'), 'matches/m1'), { over: 'B', end: 'left' }));
  // 決着後は変えられない
  await assertFails(updateDoc(doc(user('pb'), 'matches/m1'), { over: 'A', end: 'left' }));
});

test('オンライン：勝敗予想は観戦者が1人1件、1ターン目の決着まで', async () => {
  await putMatch('m1');
  const s = user('spec');
  await assertSucceeds(setDoc(doc(s, 'matches/m1/preds/spec'), { side: 'A' }));
  await assertFails(setDoc(doc(s, 'matches/m1/preds/spec'), { side: 'B' }));
  await assertFails(setDoc(doc(s, 'matches/m1/preds/other'), { side: 'B' }));
  await assertFails(setDoc(doc(user('pa'), 'matches/m1/preds/pa'), { side: 'A' }));
  await assertFails(setDoc(doc(user('s2'), 'matches/m1/preds/s2'), { side: 'C' }));
  const snap = await assertSucceeds(getDocs(query(collection(anon(), 'matches/m1/preds'), limit(100))));
  if (snap.size !== 1) throw new Error('予想の数が違う');
  await putMatch('m2', { turn: 2 });
  await assertFails(setDoc(doc(user('s3'), 'matches/m2/preds/s3'), { side: 'A' }));
  // ランダムマッチには予想できない
  await putMatch('m3', { kind: 'random' });
  await assertFails(setDoc(doc(user('s4'), 'matches/m3/preds/s4'), { side: 'A' }));
});

// ---- ランダムマッチ ----
const queueEntry = (name = 'あかね', char = 'kai') => ({ name, char, at: serverTimestamp(), mid: null });
// 後から来た me が、待っている other と試合を作る（ゲームと同じ一括書き込み）
function matchWith(db, me, other, mid, { myName = 'ぼぶ', myChar = 'gard', otherName = 'あかね', otherChar = 'kai' } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'matches', mid), {
    kind: 'random', room: null, p: { A: me, B: other }, names: { A: myName, B: otherName },
    chars: { A: myChar, B: otherChar }, st: { turn: 1, A: F(myChar), B: F(otherChar) }, turn: 1,
    ready: { A: 0, B: 0 }, log: '[]', lt: 0, tt: serverTimestamp(), at: serverTimestamp(), over: null, end: null,
    here: { A: true, B: false },
  });
  b.update(doc(db, 'queue', other), { mid });
  b.delete(doc(db, 'queue', me));
  return b.commit();
}

test('ランダムマッチ：待ち行列に入り、後から来た人が試合を作って割り当てる', async () => {
  const u1 = user('u1'), u2 = user('u2');
  await assertSucceeds(setDoc(doc(u1, 'queue/u1'), queueEntry()));
  await assertSucceeds(setDoc(doc(u2, 'queue/u2'), queueEntry('ぼぶ', 'gard')));
  // 候補の検索（10件まで）
  const since = Timestamp.fromMillis(Date.now() - 60_000);
  const snap = await assertSucceeds(getDocs(query(collection(u2, 'queue'), where('at', '>', since), orderBy('at'), limit(10))));
  if (snap.size !== 2) throw new Error('候補の数が違う');
  await assertFails(getDocs(query(collection(u2, 'queue'), limit(11))));
  // 名前・キャラが待ち行列と違うと作れない
  await assertFails(matchWith(u2, 'u2', 'u1', 'mx', { otherName: 'にせもの' }));
  await assertFails(matchWith(u2, 'u2', 'u1', 'mx', { otherChar: 'rin' }));
  await assertSucceeds(matchWith(u2, 'u2', 'u1', 'r1'));
  // 割り当て済みの人はもう取れない
  const u3 = user('u3');
  await assertSucceeds(setDoc(doc(u3, 'queue/u3'), queueEntry('ちえ', 'rin')));
  await assertFails(matchWith(u3, 'u3', 'u1', 'r2', { myName: 'ちえ', myChar: 'rin' }));
  // 割り当てられた B が参加を確かめる
  await assertFails(updateDoc(doc(u3, 'matches/r1'), { 'here.B': true }));
  await assertSucceeds(updateDoc(doc(u1, 'matches/r1'), { 'here.B': true }));
  await assertSucceeds(deleteDoc(doc(u1, 'queue/u1')));
});

test('ランダムマッチ：待ち行列の書き換え・古い待ち行列・試合なしの割り当ては弾く', async () => {
  const u1 = user('u1'), u2 = user('u2');
  await assertFails(setDoc(doc(u1, 'queue/u2'), queueEntry()));
  await assertFails(setDoc(doc(u1, 'queue/u1'), { ...queueEntry(), at: ago(10) }));
  await assertFails(setDoc(doc(u1, 'queue/u1'), queueEntry('', 'kai')));
  await assertFails(setDoc(doc(u1, 'queue/u1'), queueEntry('あかね', 'slime')));
  await assertFails(setDoc(doc(u1, 'queue/u1'), { ...queueEntry(), mid: 'x' }));
  await assertSucceeds(setDoc(doc(u1, 'queue/u1'), queueEntry()));
  await assertFails(deleteDoc(doc(u2, 'queue/u1')));
  await assertFails(updateDoc(doc(u2, 'queue/u1'), { mid: 'nomatch' }));
  await assertFails(updateDoc(doc(u2, 'queue/u1'), { name: 'かえた' }));
  // 60秒より前に入った人は候補にならない（作れない）
  await admin(db => setDoc(doc(db, 'queue/old'), { name: 'あかね', char: 'kai', at: ago(61), mid: null }));
  await assertFails(matchWith(u2, 'u2', 'old', 'r1'));
});

test('ランダムマッチ：参加が確かめられないときは15秒後に取り消せる', async () => {
  await putMatch('m1', { kind: 'random', here: { A: true, B: false } });
  await assertFails(updateDoc(doc(user('pa'), 'matches/m1'), { over: 'void', end: 'cancel' }));
  await putMatch('m2', { kind: 'random', here: { A: true, B: false }, at: ago(16) });
  await assertFails(updateDoc(doc(user('pb'), 'matches/m2'), { 'here.B': true }));
  await assertFails(updateDoc(doc(user('pb'), 'matches/m2'), { over: 'void', end: 'cancel' }));
  await assertSucceeds(updateDoc(doc(user('pa'), 'matches/m2'), { over: 'void', end: 'cancel' }));
});

// ---- ルーム ----
const newRoom = (uid, name = 'あかね') => ({
  seats: { A: uid, B: null }, names: { A: name, B: null }, chars: { A: null, B: null },
  ready: { A: false, B: false }, mid: null, at: serverTimestamp(),
});
const roomUpd = (db, code, patch) => updateDoc(doc(db, 'rooms', code), { ...patch, at: serverTimestamp() });
function roomMatch(db, code, mid, { p = { A: 'h', B: 'g' }, names = { A: 'あかね', B: 'ぼぶ' }, chars = { A: 'kai', B: 'gard' } } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'matches', mid), {
    kind: 'room', room: code, p, names, chars, st: { turn: 1, A: F(chars.A), B: F(chars.B) }, turn: 1,
    ready: { A: 0, B: 0 }, log: '[]', lt: 0, tt: serverTimestamp(), at: serverTimestamp(), over: null, end: null,
    here: { A: true, B: true },
  });
  b.update(doc(db, 'rooms', code), { mid, ready: { A: false, B: false }, at: serverTimestamp() });
  return b.commit();
}

test('ルーム：作る・参加する・キャラと準備・両者の準備で試合を作る', async () => {
  const h = user('h'), g = user('g'), s = user('s');
  await assertFails(setDoc(doc(h, 'rooms/ABCDE'), newRoom('h')));
  await assertFails(setDoc(doc(h, 'rooms/abcd1'), newRoom('h')));
  await assertFails(setDoc(doc(h, 'rooms/abcde'), newRoom('g')));
  await assertSucceeds(setDoc(doc(h, 'rooms/abcde'), newRoom('h')));
  await assertFails(setDoc(doc(g, 'rooms/abcde'), newRoom('g')));   // 使用中のコードは上書きできない
  await assertFails(getDocs(collection(anon(), 'rooms')));
  await assertSucceeds(getDoc(doc(anon(), 'rooms/abcde')));
  // 参加（空いた座席に座る）
  await assertFails(roomUpd(g, 'abcde', { 'seats.B': 'g', 'names.B': '' }));
  await assertSucceeds(roomUpd(g, 'abcde', { 'seats.B': 'g', 'names.B': 'ぼぶ' }));
  await assertFails(roomUpd(s, 'abcde', { 'seats.B': 's', 'names.B': 'しー' }));   // 満席
  // キャラを選ぶ前の準備は不可。自分の分だけ変えられる
  await assertFails(roomUpd(h, 'abcde', { 'ready.A': true }));
  await assertSucceeds(roomUpd(h, 'abcde', { 'chars.A': 'kai', 'ready.A': true }));
  await assertFails(roomUpd(h, 'abcde', { 'chars.B': 'rin' }));
  await assertFails(roomUpd(s, 'abcde', { 'chars.A': 'rin' }));
  await assertFails(roomUpd(h, 'abcde', { 'chars.A': 'slime' }));
  // 片方しか準備していないと試合を作れない
  await assertFails(roomMatch(h, 'abcde', 'rm1'));
  await assertSucceeds(roomUpd(g, 'abcde', { 'chars.B': 'gard', 'ready.B': true }));
  // 観戦者は試合を作れない。ルームと違うキャラでは作れない
  await assertFails(roomMatch(s, 'abcde', 'rm1'));
  await assertFails(roomMatch(h, 'abcde', 'rm1', { chars: { A: 'kai', B: 'rin' } }));
  await assertSucceeds(roomMatch(g, 'abcde', 'rm1'));
  // 試合中は次の試合を作れない・席を立てない・相手を外せない
  await assertSucceeds(roomUpd(h, 'abcde', { 'ready.A': true }));
  await assertSucceeds(roomUpd(g, 'abcde', { 'ready.B': true }));
  await assertFails(roomMatch(h, 'abcde', 'rm2'));
  await assertFails(roomUpd(h, 'abcde', { 'seats.A': null, 'names.A': null, 'chars.A': null, 'ready.A': false }));
  await assertFails(roomUpd(h, 'abcde', { 'seats.B': null, 'names.B': null, 'chars.B': null, 'ready.B': false }));
  // 決着後は再戦できる
  await assertSucceeds(updateDoc(doc(g, 'matches/rm1'), { over: 'A', end: 'left' }));
  await assertSucceeds(roomMatch(h, 'abcde', 'rm2'));
});

test('ルーム：試合のないときは席を立てる・戻らない相手を外せる・期限切れのコードは使い直せる', async () => {
  const h = user('h'), g = user('g'), s = user('s');
  await assertSucceeds(setDoc(doc(h, 'rooms/abcde'), newRoom('h')));
  await assertSucceeds(roomUpd(g, 'abcde', { 'seats.B': 'g', 'names.B': 'ぼぶ' }));
  await assertFails(roomUpd(s, 'abcde', { 'seats.B': null, 'names.B': null, 'chars.B': null, 'ready.B': false }));
  await assertSucceeds(roomUpd(h, 'abcde', { 'seats.B': null, 'names.B': null, 'chars.B': null, 'ready.B': false }));
  await assertSucceeds(roomUpd(s, 'abcde', { 'seats.B': 's', 'names.B': 'しー' }));
  await assertSucceeds(roomUpd(h, 'abcde', { 'seats.A': null, 'names.A': null, 'chars.A': null, 'ready.A': false }));
  await assertSucceeds(roomUpd(g, 'abcde', { 'seats.A': 'g', 'names.A': 'ぼぶ' }));
  // 期限切れ（最後の動きから2時間）
  await admin(db => updateDoc(doc(db, 'rooms/abcde'), { at: ago(2 * 3600 + 5) }));
  await assertFails(roomUpd(g, 'abcde', { 'names.A': 'ぼぶ2' }));
  await assertSucceeds(setDoc(doc(user('n'), 'rooms/abcde'), newRoom('n', 'にゅー')));
});
