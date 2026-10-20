// --key=value 形式の引数を読む。値の無い --key は true
module.exports = function args(defaults){
  const o = {...defaults};
  for(const a of process.argv.slice(2)){
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if(!m){ console.error(`読めない引数：${a}（--名前=値 の形で指定してください）`); process.exit(1); }
    o[m[1]] = m[2] ?? true;
  }
  return o;
};
