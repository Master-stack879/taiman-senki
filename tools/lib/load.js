// index.html の「CHARS」〜「ローグライト：データと計算」を Node で読み込む（画面・通信の部分は読まない）
// 戻り値の X に、ゲームの定数・関数と、乱数の種を決める setSeed / 乱数 rand が入る
const fs = require('fs'), vm = require('vm'), path = require('path');
const NAMES = ('CHARS CHAR MONSTERS RG_DIFF RG_DIFFS RG_ENDLESS RG_MODES RG_REWARD RG_UPGRADE RG_UPGRADES RG_LV_EXP RG_GROWTH ' +
  'initState resolveTurn cpuChoose rgNewRunState rgEnemy rgFoeChoose rgBattleState rgCommitTurn rgAfterReward rgAfterRest ' +
  'rgOffers rgReroll rgApply rgGainExp clone pickOne rgNodeOf rgTop rgMode rgSoulsFor rgSettleMeta rgNewMeta rgBuy rgUpPrice rgCharOpen').split(' ');
const DEFAULT_HTML = path.join(__dirname, '..', '..', 'index.html');

module.exports = function load(file = DEFAULT_HTML){
  const src = fs.readFileSync(file, 'utf8').split('\n');
  const s = src.findIndex(l=>l.startsWith('const CHARS'));
  const e = src.findIndex(l=>l.includes('ローグライト：画面'));
  if(s<0 || e<0) throw new Error(`${file} から戦闘エンジンと冒険のデータ部分を見つけられません`);
  let code = src.slice(s, e).join('\n') + '\nconst isRosterId = id => CHARS.some(c=>c.id===id);\nthis.X = {};\n';
  // 古い版の index.html には無い名前もあるので、あるものだけ取り出す
  for(const n of NAMES) code += `try{ this.X.${n} = ${n}; }catch(e){}\n`;
  const ctx = {matchMedia:()=>({matches:false}), Math:Object.create(Math), console};
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const X = ctx.X;
  // 種つきの乱数（mulberry32）。ゲーム内の Math.random をこれに差し替える
  X.setSeed = seed => { let a = seed>>>0; ctx.Math.random = () => { a |= 0; a = a+0x6D2B79F5|0; let t = Math.imul(a^a>>>15, 1|a); t = t+Math.imul(t^t>>>7, 61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; };
  X.rand = () => ctx.Math.random();
  return X;
};
module.exports.DEFAULT_HTML = DEFAULT_HTML;
