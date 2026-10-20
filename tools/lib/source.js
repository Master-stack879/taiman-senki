// 比べる相手の index.html を決める。git:<ref>（例：git:origin/main）なら、その版の index.html を一時ファイルに書き出す
const fs = require('fs'), os = require('os'), path = require('path'), {execFileSync} = require('child_process');
module.exports = function resolveHtml(spec){
  if(!spec.startsWith('git:')) return path.resolve(spec);
  const ref = spec.slice(4), root = path.join(__dirname, '..', '..');
  const body = execFileSync('git', ['show', `${ref}:index.html`], {cwd:root, maxBuffer:64<<20});
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taiman-')), 'index.html');
  fs.writeFileSync(file, body);
  return file;
};
