// firestore.rules の確認（Firestore エミュレーターで実行する）
//   npm test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, collection, writeBatch, serverTimestamp, Timestamp, setDoc, updateDoc,
  deleteDoc, getDoc, getDocs, query, orderBy, limit,
} from 'firebase/firestore';

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-taiman',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const good = () => ({ name: 'テスト', char: 'kai', floor: 12, ver: '1.0.0' });

// ゲームから送るのと同じ形：scores の追加と limits/{uid} の更新を一括で
function submit(db, uid, rec, { withLimit = true, at = serverTimestamp() } = {}) {
  const b = writeBatch(db);
  b.set(doc(collection(db, 'scores')), { ...rec, at });
  if (withLimit) b.set(doc(db, 'limits', uid), { last: serverTimestamp() });
  return b.commit();
}

const user = (uid = 'u1') => env.authenticatedContext(uid).firestore();

test('正しい記録は追加できる', async () => {
  await assertSucceeds(submit(user(), 'u1', good()));
});

test('全キャラ・境界値（名前1文字/12文字、到達階1/200）は通る', async () => {
  const ok = [
    ...['kai', 'mira', 'gard', 'rin', 'shizuku', 'doran'].map(char => ({ char })),
    { name: 'あ' }, { name: 'あいうえおかきくけこさし' }, { name: 'ABCDEFGHIJKL' }, // 文字数は JS の length と同じ数え方（絵文字は2と数える）
    { name: '😀'.repeat(6) },
    { floor: 1 }, { floor: 200 },
  ];
  for (const [i, patch] of ok.entries()) {
    await assertSucceeds(submit(user('ok' + i), 'ok' + i, { ...good(), ...patch }));
  }
});

test('入力チェックで弾かれる', async () => {
  const bad = {
    '名前が空': { name: '' },
    '名前が13文字': { name: 'あいうえおかきくけこさしす' },
    '名前が絵文字7個（length 14）': { name: '😀'.repeat(7) },
    '名前が空白だけ': { name: '   ' },
    '名前が全角空白だけ': { name: '　　' },
    '名前が文字列でない': { name: 123 },
    '対戦用でないキャラ': { char: 'slime' },
    'キャラが大文字': { char: 'Kai' },
    '到達階0': { floor: 0 },
    '到達階201': { floor: 201 },
    '到達階が小数': { floor: 3.5 },
    '到達階が文字列': { floor: '10' },
    'バージョンが空': { ver: '' },
    'バージョンが長すぎ': { ver: 'x'.repeat(17) },
    '余計な項目がある': { hp: 999 },
  };
  let i = 0;
  for (const [label, patch] of Object.entries(bad)) {
    const uid = 'bad' + i++;
    await assertFails(submit(user(uid), uid, { ...good(), ...patch }), label);
  }
  // 項目が足りない
  const { ver, ...noVer } = good();
  await assertFails(submit(user('nv'), 'nv', noVer));
});

test('日時はサーバー時刻以外を受け付けない', async () => {
  await assertFails(submit(user(), 'u1', good(), { at: Timestamp.fromDate(new Date('2000-01-01')) }));
});

test('ログインしていないと書けない', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(submit(db, 'u1', good()));
});

test('limits を一緒に更新しない追加は弾かれる', async () => {
  await assertFails(submit(user(), 'u1', good(), { withLimit: false }));
});

test('他人の limits を使った追加は弾かれる', async () => {
  const db = user('u1');
  const b = writeBatch(db);
  b.set(doc(collection(db, 'scores')), { ...good(), at: serverTimestamp() });
  b.set(doc(db, 'limits', 'u2'), { last: serverTimestamp() });
  await assertFails(b.commit());
});

test('同じ端末からの短時間の連続投稿は弾かれ、時間が経てば通る', async () => {
  const db = user();
  await assertSucceeds(submit(db, 'u1', good()));
  await assertFails(submit(db, 'u1', good()));
  // 別の端末は通る
  await assertSucceeds(submit(user('u2'), 'u2', good()));
  // 前回投稿を61秒前にずらすと通る
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'limits', 'u1'),
      { last: Timestamp.fromMillis(Date.now() - 61_000) });
  });
  await assertSucceeds(submit(db, 'u1', good()));
});

test('記録の変更・削除・上書きはできない', async () => {
  let id;
  await env.withSecurityRulesDisabled(async ctx => {
    const ref = doc(collection(ctx.firestore(), 'scores'));
    id = ref.id;
    await setDoc(ref, { ...good(), at: Timestamp.now() });
  });
  const db = user();
  const ref = doc(db, 'scores', id);
  await assertFails(updateDoc(ref, { floor: 200 }));
  await assertFails(deleteDoc(ref));
  // 同じIDへの set は「変更」扱いで弾かれる
  const b = writeBatch(db);
  b.set(ref, { ...good(), floor: 200, at: serverTimestamp() });
  b.set(doc(db, 'limits', 'u1'), { last: serverTimestamp() });
  await assertFails(b.commit());
});

test('limits は読めず、消せず、時刻をごまかせない', async () => {
  const db = user();
  await assertSucceeds(submit(db, 'u1', good()));
  await assertFails(getDoc(doc(db, 'limits', 'u1')));
  await assertFails(deleteDoc(doc(db, 'limits', 'u1')));
  await assertFails(setDoc(doc(db, 'limits', 'u1'), { last: Timestamp.fromMillis(0) }));
});

test('誰でも上位を読める（100件まで）', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const [name, floor] of [['A', 5], ['B', 30], ['C', 12]]) {
      await setDoc(doc(collection(db, 'scores')), { ...good(), name, floor, at: Timestamp.now() });
    }
  });
  const db = env.unauthenticatedContext().firestore();
  const snap = await assertSucceeds(getDocs(query(collection(db, 'scores'),
    orderBy('floor', 'desc'), orderBy('at', 'asc'), limit(20))));
  const names = snap.docs.map(d => d.data().name);
  if (names.join() !== 'B,C,A') throw new Error('並び順がおかしい: ' + names);
  // 件数指定なし・100件超は弾く
  await assertFails(getDocs(collection(db, 'scores')));
  await assertFails(getDocs(query(collection(db, 'scores'), limit(101))));
});

// ---- 引き継ぎコード（transfers / spent / tlimits） ----
const SAVE = 'TSK2.eyJtZXRhIjp7fX0.0123abcd';
// ゲームから送るのと同じ形：transfers の追加と tlimits/{uid} の更新を一括で
function issue(db, uid, code, { save = SAVE, at = serverTimestamp(), withLimit = true, extra = {} } = {}) {
  const b = writeBatch(db);
  b.set(doc(db, 'transfers', code), { save, at, ...extra });
  if (withLimit) b.set(doc(db, 'tlimits', uid), { last: serverTimestamp() });
  return b.commit();
}
// 読み込みと同じ形：transfers の削除と spent の追加を一括で
function redeem(db, code, { withSpent = true, withDelete = true } = {}) {
  const b = writeBatch(db);
  if (withDelete) b.delete(doc(db, 'transfers', code));
  if (withSpent) b.set(doc(db, 'spent', code), { at: serverTimestamp() });
  return b.commit();
}
async function putTransfer(code, at) {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'transfers', code), { save: SAVE, at });
  });
}
const anon = () => env.unauthenticatedContext().firestore();

test('引き継ぎコード：発行して、別の人がコードで1回だけ読める', async () => {
  await assertSucceeds(issue(user(), 'u1', 'K7MQ2XPA'));
  const db = anon();
  const snap = await assertSucceeds(getDoc(doc(db, 'transfers', 'K7MQ2XPA')));
  if (snap.data().save !== SAVE) throw new Error('中身が違う');
  await assertSucceeds(redeem(db, 'K7MQ2XPA'));
  // 2回目：もう無い。使用済みの印は読める
  const again = await assertSucceeds(getDoc(doc(db, 'transfers', 'K7MQ2XPA')));
  if (again.exists()) throw new Error('使ったあとも残っている');
  if (!(await assertSucceeds(getDoc(doc(db, 'spent', 'K7MQ2XPA')))).exists()) throw new Error('使用済みの印がない');
  await assertFails(redeem(db, 'K7MQ2XPA'));
  // 無いコードは「無い」と返る（弾かれない）
  const none = await assertSucceeds(getDoc(doc(db, 'transfers', 'ABCD2345')));
  if (none.exists()) throw new Error('無いはずのコードがある');
});

test('引き継ぎコード：一覧は誰も読めない', async () => {
  await assertSucceeds(issue(user(), 'u1', 'K7MQ2XPA'));
  for (const db of [anon(), user()]) {
    await assertFails(getDocs(collection(db, 'transfers')));
    await assertFails(getDocs(query(collection(db, 'transfers'), limit(1))));
    await assertFails(getDocs(collection(db, 'spent')));
    await assertFails(getDoc(doc(db, 'tlimits', 'u1')));
  }
});

test('引き継ぎコード：期限切れ（7日）は読めず、使えない', async () => {
  await putTransfer('QRDC2345', Timestamp.fromMillis(Date.now() - 7 * 864e5 - 60_000));
  await putTransfer('NEWC2345', Timestamp.fromMillis(Date.now() - 7 * 864e5 + 3_600_000));
  const db = anon();
  await assertFails(getDoc(doc(db, 'transfers', 'QRDC2345')));
  await assertFails(redeem(db, 'QRDC2345'));
  // 期限まで1時間あるものは読める
  await assertSucceeds(getDoc(doc(db, 'transfers', 'NEWC2345')));
  await assertSucceeds(redeem(db, 'NEWC2345'));
});

test('引き継ぎコード：他人のコードの書き換え・期限の改ざんは弾かれる', async () => {
  await assertSucceeds(issue(user('u1'), 'u1', 'K7MQ2XPA'));
  const db = user('u2');
  const ref = doc(db, 'transfers', 'K7MQ2XPA');
  await assertFails(updateDoc(ref, { save: 'TSK2.AAAA.0123abcd' }));
  await assertFails(updateDoc(ref, { at: serverTimestamp() }));
  // 同じコードへの発行（上書き）も「変更」扱いで弾かれる
  await assertFails(issue(db, 'u2', 'K7MQ2XPA', { save: 'TSK2.AAAA.0123abcd' }));
  // spent を付けずに消す・spent だけ付ける
  await assertFails(deleteDoc(ref));
  await assertFails(redeem(db, 'K7MQ2XPA', { withDelete: false }));
  // 発行時刻：サーバー時刻以外（未来の日時で期限を延ばす）は不可
  const db3 = user('u3');
  await assertFails(issue(db3, 'u3', 'ABCD2345', { at: Timestamp.fromMillis(Date.now() + 365 * 864e5) }));
  await assertFails(issue(db3, 'u3', 'ABCD2345', { extra: { exp: Timestamp.fromMillis(Date.now() + 365 * 864e5) } }));
  // 使用済みの印は消せず、変えられない
  await assertSucceeds(redeem(anon(), 'K7MQ2XPA'));
  await assertFails(deleteDoc(doc(db, 'spent', 'K7MQ2XPA')));
  await assertFails(setDoc(doc(db, 'spent', 'K7MQ2XPA'), { at: serverTimestamp() }));
  // 無いコードに使用済みの印は付けられない
  await assertFails(setDoc(doc(db, 'spent', 'ABCD2346'), { at: serverTimestamp() }));
});

test('引き継ぎコード：大きすぎる・形の違うデータは弾かれる', async () => {
  const bad = {
    '大きすぎる（4001文字）': { save: 'TSK2.' + 'A'.repeat(3987) + '.0123abcd' },
    'セーブコードの形でない': { save: 'hello' },
    '文字列でない': { save: 123 },
  };
  let i = 0;
  for (const [label, o] of Object.entries(bad)) {
    const uid = 'tb' + i++;
    await assertFails(issue(user(uid), uid, 'ABCD234' + (i + 1), o), label);
  }
  // 4000文字ちょうどは通る
  await assertSucceeds(issue(user('tok'), 'tok', 'ABCD2349', { save: 'TSK2.' + 'A'.repeat(3986) + '.0123abcd' }));
  // 使えない文字・長さのコード
  for (const [j, code] of ['ABCD234O', 'ABCD2341', 'ABCD234I', 'ABCD234L', 'ABCD234', 'ABCD23456', 'abcd2345'].entries()) {
    await assertFails(issue(user('tc' + j), 'tc' + j, code), code);
  }
  // 余計な項目・項目不足
  await assertFails(issue(user('tx'), 'tx', 'ABCE2345', { extra: { meta: {} } }));
  const ty = user('ty');
  await assertFails(writeBatch(ty).set(doc(ty, 'transfers', 'ABCF2345'), { save: SAVE })
    .set(doc(ty, 'tlimits', 'ty'), { last: serverTimestamp() }).commit());
});

test('引き継ぎコード：ログインと tlimits の更新が要り、短時間の連続発行は弾かれる', async () => {
  await assertFails(issue(anon(), 'u1', 'ABCD2345'));
  await assertFails(issue(user(), 'u1', 'ABCD2345', { withLimit: false }));
  // 他人の tlimits を使う
  const db = user('u1');
  const b = writeBatch(db);
  b.set(doc(db, 'transfers', 'ABCD2345'), { save: SAVE, at: serverTimestamp() });
  b.set(doc(db, 'tlimits', 'u2'), { last: serverTimestamp() });
  await assertFails(b.commit());
  // 連続発行
  await assertSucceeds(issue(db, 'u1', 'ABCD2345'));
  await assertFails(issue(db, 'u1', 'ABCD2346'));
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'tlimits', 'u1'), { last: Timestamp.fromMillis(Date.now() - 61_000) });
  });
  await assertSucceeds(issue(db, 'u1', 'ABCD2346'));
  // tlimits は読めず、消せず、時刻をごまかせない
  await assertFails(deleteDoc(doc(db, 'tlimits', 'u1')));
  await assertFails(setDoc(doc(db, 'tlimits', 'u1'), { last: Timestamp.fromMillis(0) }));
});
