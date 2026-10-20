// 全強化までの冒険回数。遊び方：使えるキャラからランダムに選び、戦魂が貯まったら安い強化から買う。難易度は解放されたら次へ進む
// --endless=1（既定）ならむずかしいを踏破したあとは無限回廊で遊ぶ。--endless=0 ならむずかしいを続ける
// 使い方：node tools/progress.js [--n=2000] [--pol=hp] [--endless=1] [--seed=23] [--html=index.html]
const load = require('./lib/load'), args = require('./lib/args'), P = require('./lib/play');
const o = args({n:2000, pol:'hp', endless:'1', seed:23, html:load.DEFAULT_HTML});
const X = load(o.html), play = P(X), N = +o.n, useEndless = o.endless!=='0' && !!X.RG_ENDLESS;
X.setSeed(+o.seed);
const counts = [], playsBy = {};
for(let p=0;p<N;p++){
  const meta = X.rgNewMeta(), cleared = {}; let runs = 0;
  const done = () => X.RG_UPGRADES.every(u=>meta.ups[u.id]===u.prices.length);
  while(!done() && runs<500){
    const diff = cleared.hard && useEndless ? 'endless' : cleared.normal ? 'hard' : cleared.easy ? 'normal' : 'easy';
    const ch = X.pickOne(X.CHARS.filter(c=>X.rgCharOpen(meta, c.id))).id;
    const {run, cleared:c} = play(diff, ch, {ups:{...meta.ups}}, o.pol);
    X.rgSettleMeta(meta, run, c); runs++;
    if(c) cleared[diff] = true;
    playsBy[diff] = (playsBy[diff]||0) + 1;
    for(;;){
      const cand = X.RG_UPGRADES.map(u=>({u, p:X.rgUpPrice(meta, u.id)})).filter(x=>x.p!=null).sort((a,b)=>a.p-b.p)[0];
      if(!cand || meta.souls<cand.p || !X.rgBuy(meta, cand.u.id)) break;
    }
  }
  counts.push(runs);
}
counts.sort((a,b)=>a-b);
const mean = counts.reduce((a,b)=>a+b,0)/N;
console.log(`方針：${o.pol}　むずかしい踏破後：${useEndless ? '無限回廊' : 'むずかしいを続ける'}　${N}人分`);
console.log(`全強化までの冒険回数 平均${mean.toFixed(1)}回 中央${counts[N>>1]}回 10〜90%で${counts[Math.floor(N*0.1)]}〜${counts[Math.floor(N*0.9)]}回`);
console.log('1人あたりの冒険回数 ' + Object.entries(playsBy).map(([d,v])=>`${d}:${(v/N).toFixed(1)}`).join(' '));
