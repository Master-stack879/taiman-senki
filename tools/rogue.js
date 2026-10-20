// 難易度（やさしい・ふつう・むずかしい）の自動プレイ：方針別クリア率、キャラ別クリア率、負けた階の分布
// 使い方：node tools/rogue.js [--diff=easy,normal,hard] [--pol=random,heal,up,hp,prio] [--meta=none|full] [--n=3000] [--seed=7]
//          [--html=index.html] [--compare=git:origin/main]
// n はキャラごとの回数。--compare を付けると、同じ種で相手の版と冒険の中身まで完全一致するかを調べる
const load = require('./lib/load'), args = require('./lib/args'), resolveHtml = require('./lib/source'), P = require('./lib/play');
const crypto = require('crypto');
const o = args({diff:'easy,normal,hard', pol:P.POLICIES.join(','), meta:'none', n:3000, seed:7, html:load.DEFAULT_HTML});
const diffs = o.diff.split(','), pols = o.pol.split(','), meta = P.parseMeta(o.meta), n = +o.n;

function run(file){
  const X = load(file), play = P(X), out = [];
  for(const diff of diffs){
    if(!X.RG_DIFF[diff]) throw new Error(`知らない難易度：${diff}`);
    const top = X.RG_DIFF[diff].floors.length;
    for(const pol of pols){
      X.setSeed(+o.seed);
      const h = crypto.createHash('md5'), chars = {}, lost = Array(top).fill(0);
      let clears = 0;
      for(const c of X.CHARS){
        chars[c.id] = 0;
        for(let i=0;i<n;i++){
          const {run, cleared} = play(diff, c.id, meta, pol);
          if(cleared){ clears++; chars[c.id]++; } else lost[run.floor]++;
          h.update(JSON.stringify([run.floor, run.hp, run.lv, run.picks, run.ch, run.turns, cleared]));
        }
      }
      out.push({diff, pol, rate:clears/n/X.CHARS.length, chars, lost, hash:h.digest('hex')});
    }
  }
  return out;
}

const me = run(resolveHtml(o.html)), pct = x => (x*100).toFixed(1)+'%';
console.log(`永続強化：${o.meta}　キャラごと ${n}回`);
for(const diff of diffs){
  const rs = me.filter(r=>r.diff===diff);
  console.log(`\n■ ${diff}`);
  for(const r of rs){
    const lostAll = r.lost.reduce((a,b)=>a+b,0);
    console.log(`  ${r.pol.padEnd(6)} クリア ${pct(r.rate).padStart(6)}  キャラ別 ` + Object.entries(r.chars).map(([k,v])=>`${k}:${pct(v/n)}`).join(' '));
    console.log(`         負けた階 ` + r.lost.map((v,f)=>`${f+1}F:${lostAll ? pct(v/lostAll) : '-'}`).join(' '));
  }
  const hp = rs.find(r=>r.pol==='hp');
  if(hp){
    const others = rs.filter(r=>['random','heal','up'].includes(r.pol));
    if(others.length) console.log(`  HPを見て選ぶ − 次点 = ${((hp.rate - Math.max(...others.map(r=>r.rate)))*100).toFixed(1)}ポイント`);
  }
}
if(o.compare){
  const other = run(resolveHtml(o.compare));
  const diff = me.filter((r,i)=>r.hash!==other[i].hash);
  if(!diff.length) console.log(`\n${o.compare} と完全一致（同じ種で冒険の中身まで同じ）`);
  else { console.log(`\n${o.compare} と違う：` + diff.map(r=>`${r.diff}/${r.pol}`).join(' ')); process.exit(1); }
}
