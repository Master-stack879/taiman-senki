// 無限回廊の自動プレイ：方針別の到達階（平均・中央・上位10%）、10階ごとの分布、キャラ別の平均、負けた場所、プレイ時間の目安
// 使い方：node tools/endless.js [--pol=random,heal,up,hp,prio] [--meta=full|none] [--n=1000] [--seed=11] [--html=index.html]
//          [--set='{"m0":0.53,"quad":0.0024}']（RG_ENDLESS の値を一時的に上書きして試す）
// 到達階＝負けた階（200階を踏破したら200）。n はキャラごとの回数
const load = require('./lib/load'), args = require('./lib/args'), P = require('./lib/play');
const o = args({pol:P.POLICIES.join(','), meta:'full', n:1000, seed:11, html:load.DEFAULT_HTML});
const X = load(o.html), play = P(X), n = +o.n, meta = P.parseMeta(o.meta);
if(!X.RG_ENDLESS) throw new Error('この index.html には無限回廊がありません');
if(o.set) Object.assign(X.RG_ENDLESS, JSON.parse(o.set));
const top = X.RG_ENDLESS.max;

console.log(`永続強化：${o.meta}　キャラごと ${n}回${o.set ? '　上書き：'+o.set : ''}`);
for(const pol of o.pol.split(',')){
  X.setSeed(+o.seed);
  const all = [], per = {}, st = P.newStats(), lostAt = {battle:0, elite:0, boss:0};
  let souls = 0;
  for(const c of X.CHARS){
    per[c.id] = 0;
    for(let i=0;i<n;i++){
      const {run, cleared} = play('endless', c.id, meta, pol, st);
      const f = cleared ? top : run.floor+1;
      all.push(f); per[c.id] += f/n; souls += X.rgSoulsFor(run, cleared);
      if(!cleared) lostAt[X.rgNodeOf(run)]++;
    }
  }
  all.sort((a,b)=>a-b);
  const M = all.length, mean = all.reduce((a,b)=>a+b,0)/M, q = p => all[Math.min(M-1, Math.floor(M*p))];
  const top10 = all.slice(Math.floor(M*0.9)), top10mean = top10.reduce((a,b)=>a+b,0)/top10.length;
  const bands = [[1,10],[11,20],[21,30],[31,40],[41,50],[51,top]].map(([a,b])=>`${a}-${b===top?'':b}:${(all.filter(f=>f>=a && f<=b).length/M*100).toFixed(0)}%`);
  const pc = k => (lostAt[k]/M*100).toFixed(0)+'%';
  console.log(`\n■ ${pol}`);
  console.log(`  到達階 平均${mean.toFixed(1)} 中央${q(0.5)} 上位10%の境目${q(0.9)} 上位10%の平均${top10mean.toFixed(1)} 最高${all[M-1]}`);
  console.log(`  分布 ${bands.join(' ')}`);
  console.log(`  キャラ別平均 ` + Object.entries(per).map(([k,v])=>`${k}:${v.toFixed(1)}`).join(' '));
  console.log(`  負けた場所 魔物${pc('battle')} 強敵${pc('elite')} ボス${pc('boss')}  戦魂 平均${(souls/M).toFixed(1)}`);
  console.log(`  1戦${(st.turns/st.battles).toFixed(1)}ターン  1回のプレイ時間の目安 ${(P.playSeconds(st)/M/60).toFixed(1)}分`);
}
