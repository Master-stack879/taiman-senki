// 対戦モードの総当たり：6キャラ×6キャラ（ミラー含む36通り）×各 n 戦。両者 cpuChoose、組み合わせごとに同じ種
// 使い方：node tools/versus.js [--n=10000] [--html=index.html] [--compare=git:origin/main]
const load = require('./lib/load'), args = require('./lib/args'), resolveHtml = require('./lib/source');
const crypto = require('crypto');
const o = args({n:10000, html:load.DEFAULT_HTML});

function run(file, n){
  const X = load(file), rows = [];
  for(const a of X.CHARS) for(const b of X.CHARS){
    X.setSeed(1000 + rows.length);
    const w = {A:0, B:0, draw:0}; let turns = 0;
    for(let i=0;i<n;i++){
      let st = X.initState(a.id, b.id);
      for(;;){ const r = X.resolveTurn(st, {A:X.cpuChoose(st,'A'), B:X.cpuChoose(st,'B')}); st = r.state; if(r.over){ w[r.over]++; turns += st.turn; break; } }
    }
    rows.push({a:a.id, b:b.id, ...w, turns});
  }
  return {rows, hash:crypto.createHash('md5').update(JSON.stringify(rows)).digest('hex')};
}

const n = +o.n, me = run(resolveHtml(o.html), n);
console.log(`対戦モード総当たり（${n}戦ずつ）  A＝行のキャラ、B＝列のキャラ。A の勝率%`);
const ids = [...new Set(me.rows.map(r=>r.a))];
console.log('        ' + ids.map(id=>id.padStart(8)).join(''));
for(const a of ids) console.log(a.padEnd(8) + ids.map(b=>{ const r = me.rows.find(r=>r.a===a && r.b===b); return (r.A/n*100).toFixed(1).padStart(8); }).join(''));
console.log(`平均ターン ${(me.rows.reduce((s,r)=>s+r.turns,0)/n/me.rows.length).toFixed(2)}  指紋 ${me.hash}`);
if(o.compare){
  const other = run(resolveHtml(o.compare), n);
  const diff = me.rows.filter((r,i)=>JSON.stringify(r)!==JSON.stringify(other.rows[i]));
  if(!diff.length){ console.log(`${o.compare} と完全一致`); }
  else { console.log(`${o.compare} と ${diff.length} 通りで違う：` + diff.map(r=>`${r.a}-${r.b}`).join(' ')); process.exit(1); }
}
