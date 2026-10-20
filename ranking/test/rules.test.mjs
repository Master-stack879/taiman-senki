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
