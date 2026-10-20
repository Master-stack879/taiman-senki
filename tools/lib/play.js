// 冒険の自動プレイ。画面と同じ順番でデータ側の関数を呼ぶ（両陣営の技選び：自分は cpuChoose、敵は rgFoeChoose）
// 報酬の選び方（pol）：
//   random：ランダム / heal：常に回復 / up：常に強化
//   hp：HPを見て選ぶ（HP40%未満、または次がボスでHP60%未満なら回復。それ以外は強化。強化どうしはランダム）
//   prio：HPを見て選ぶ（優先順位版。強化どうしは 体力→攻撃→技→防御 の順）
// 休憩所（無限回廊）：hp / prio は HP60%未満なら休む、それ以外は強化
// 引き直し：hp / prio は「回復したいのに回復が無いとき」に使う
const POLICIES = ['random', 'heal', 'up', 'hp', 'prio'];
const FULL = {ups:{hp:3, mp:2, reroll:1, three:1}};   // 全強化

module.exports = function makePlayer(X){
  const nextBoss = run => X.rgNodeOf ? X.rgNodeOf(run, run.floor+1)==='boss' : X.RG_DIFF[run.diff].floors[run.floor+1]==='boss';
  const wantHeal = run => { const r = run.hp/run.ch.hp; return r<0.4 || (nextBoss(run) && r<0.6); };
  const prioUp = ups => { for(const t of ['hp','atk','pow','def']){ const x = ups.find(x=>x.o.t===t); if(x) return x.i; } return X.pickOne(ups).i; };
  function pick(run, offer, pol, rest){
    const h = offer.findIndex(o=>o.heal), ups = offer.map((o,i)=>({o,i})).filter(x=>!x.o.heal);
    if(pol==='random') return Math.floor(X.rand()*offer.length);
    if(pol==='heal') return h>=0 ? h : X.pickOne(ups).i;
    if(pol==='up') return X.pickOne(ups).i;
    if(h>=0 && (rest ? run.hp/run.ch.hp<0.6 : wantHeal(run))) return h;
    return pol==='prio' ? prioUp(ups) : X.pickOne(ups).i;
  }
  // 1回の冒険。stats を渡すとターン数・演出の行数などを数える
  return function playRun(diff, charId, meta, pol, stats){
    if(!POLICIES.includes(pol)) throw new Error(`知らない方針：${pol}`);
    const run = X.rgNewRunState(diff, charId, meta);
    for(;;){
      run.battle = {state:X.rgBattleState(run)}; run.stage = 'battle';
      let out;
      do{
        const st = run.battle.state;
        const r = X.resolveTurn(st, {A:X.cpuChoose(st,'A'), B:X.rgFoeChoose(st, run)});
        if(stats){ stats.turns++; stats.steps += r.steps.length; stats.lunges += r.steps.filter(s=>s[1][0]==='l').length; }
        out = X.rgCommitTurn(run, r);
      }while(out.type==='cont' || out.type==='revive');
      if(stats) stats.battles++;
      if(out.type==='lose') return {run, cleared:false};
      if(out.type==='clear') return {run, cleared:true};
      if((pol==='hp' || pol==='prio') && run.rerolls>0 && wantHeal(run) && !run.offer.some(o=>o.heal)) X.rgReroll(run);
      X.rgAfterReward(run, pick(run, run.offer, pol, false));
      if(run.stage==='rest'){ X.rgAfterRest(run, pick(run, run.offer, pol, true)); if(stats) stats.rests++; }
    }
  };
};
module.exports.POLICIES = POLICIES;
module.exports.FULL = FULL;
module.exports.newStats = () => ({turns:0, steps:0, lunges:0, battles:0, rests:0});
// 演出込みのプレイ時間の目安（秒）。演出1行0.65秒（突進は0.45秒）、決着0.6秒（index.html の playback / queueResult の値）
// 技選び1ターン2秒、1戦ごとの画面（開始・結果・報酬）8秒、休憩所4秒は仮定
module.exports.playSeconds = st => st.steps*0.65 - st.lunges*0.2 + st.battles*0.6 + st.turns*2 + st.battles*8 + st.rests*4;
module.exports.parseMeta = m => m==='full' ? FULL : m==='none' ? null : (()=>{ throw new Error(`--meta は none か full：${m}`); })();
