// Daily Divination — built-in MiniApp.
// Programmer-themed tarot: 24 cards, 4 fortune dimensions, daily-locked via app.storage.

const CARDS = [
  { name: '命运之轮', tag: '机缘', symbol: '✦', keyword: '流转 · 节奏', tone: ['#5b21b6', '#1e1b4b'],
    quote: '每个 commit 都在改变命运的曲率，今天值得一次推送。' },
  { name: '星辰指引', tag: '希望', symbol: '✶', keyword: '远方 · 灵感', tone: ['#1e3a8a', '#0c1230'],
    quote: '当你卡住时，抬头看看 documentation 之外的世界。' },
  { name: '熔炉之心', tag: '锻造', symbol: '✺', keyword: '精炼 · 重构', tone: ['#9a3412', '#2a0e0a'],
    quote: '今日适合一次果敢的重构，删除即创造。' },
  { name: '寂静之钟', tag: '冥想', symbol: '☾', keyword: '深思 · 沉潜', tone: ['#1e293b', '#0f172a'],
    quote: '让 IDE 暂停十分钟，答案常在白板上浮现。' },
  { name: '银河书简', tag: '智识', symbol: '☄', keyword: '阅读 · 累积', tone: ['#4c1d95', '#1f0a3d'],
    quote: '今天读完一个长 issue 的讨论，比写十行代码值钱。' },
  { name: '红宝匠人', tag: '创造', symbol: '◆', keyword: '雕琢 · 细节', tone: ['#7f1d1d', '#260a0a'],
    quote: '把一个边界条件想清楚，就是今天最好的输出。' },
  { name: '青铜之蛇', tag: '蜕变', symbol: '∞', keyword: '环路 · 蜕变', tone: ['#065f46', '#04241c'],
    quote: '一个 retry-loop 修好了，整条链路都活了过来。' },
  { name: '光之回响', tag: '协作', symbol: '✧', keyword: '回声 · 共振', tone: ['#0e7490', '#06262e'],
    quote: '一句"我来帮你看看"，就是今日最强的 buff。' },
  { name: '苔藓低语', tag: '休憩', symbol: '❀', keyword: '生长 · 留白', tone: ['#14532d', '#031708'],
    quote: '让进度条慢一点，让创造力快一点。' },
  { name: '星海罗盘', tag: '抉择', symbol: '⊛', keyword: '方向 · 决断', tone: ['#1e40af', '#0a163b'],
    quote: '别再纠结技术选型，先把第一行代码写出来。' },
  { name: '黄昏炉火', tag: '专注', symbol: '✦', keyword: '心流 · 燃烧', tone: ['#92400e', '#2d1305'],
    quote: '关闭 Slack，今天属于你和编辑器的二人世界。' },
  { name: '悬浮之环', tag: '平衡', symbol: '◌', keyword: '取舍 · 张力', tone: ['#3730a3', '#0f0e2c'],
    quote: '完美与上线之间，请选择上线。' },
  { name: '镜面湖', tag: '复盘', symbol: '☼', keyword: '映照 · 觉察', tone: ['#155e75', '#03222b'],
    quote: '回看一周前自己写的代码，会比 review 更诚实。' },
  { name: '深林信使', tag: '消息', symbol: '✉', keyword: '传达 · 链接', tone: ['#166534', '#03200d'],
    quote: '一封写得清楚的邮件，胜过三场会议。' },
  { name: '夜之提琴', tag: '诗意', symbol: '♪', keyword: '韵律 · 优雅', tone: ['#581c87', '#1a0830'],
    quote: '为变量起一个动听的名字，命名是程序员的诗。' },
  { name: '黎明铸铁', tag: '勇气', symbol: '⚔', keyword: '直面 · 挑战', tone: ['#9f1239', '#2c0710'],
    quote: '今天直面那个一直被你跳过的 TODO。' },
  { name: '极光之纱', tag: '灵感', symbol: '✤', keyword: '迸发 · 流动', tone: ['#0d9488', '#02322f'],
    quote: '保持沐浴或散步的状态，bug 多半在水流声里被冲掉。' },
  { name: '羽落之笔', tag: '记录', symbol: '✎', keyword: '书写 · 沉淀', tone: ['#3f3f46', '#101013'],
    quote: '今日适合写一篇文档，未来的你会感谢现在的自己。' },
  { name: '潮汐之环', tag: '节奏', symbol: '∽', keyword: '起伏 · 周期', tone: ['#0369a1', '#021c33'],
    quote: '高效与低谷皆是潮汐，重要的是别在退潮时责怪自己。' },
  { name: '紫晶圣杯', tag: '丰饶', symbol: '♥', keyword: '滋养 · 馈赠', tone: ['#86198f', '#2a0833'],
    quote: '别忘了喝水。也别忘了夸自己一句。' },
  { name: '金色齿轮', tag: '系统', symbol: '✦', keyword: '机制 · 架构', tone: ['#a16207', '#2c1a05'],
    quote: '一个清晰的模块边界，胜过十个聪明的 hack。' },
  { name: '晨曦之翼', tag: '启程', symbol: '✿', keyword: '出发 · 第一步', tone: ['#be185d', '#310a1f'],
    quote: '把"等我准备好"换成"先 push 一个 draft PR"。' },
  { name: '寒星之刃', tag: '清算', symbol: '✝', keyword: '剔除 · 净化', tone: ['#0f766e', '#02211f'],
    quote: '今天适合删一些过时的依赖，少即是多。' },
  { name: '月光石阶', tag: '指引', symbol: '☽', keyword: '夜行 · 步步', tone: ['#312e81', '#0a0928'],
    quote: '不必看清整个阶梯，先迈出眼前的这一步。' },
];

const FORTUNE_KEYS = [
  { key: 'overall', label: '综合' },
  { key: 'work', label: '工作' },
  { key: 'inspire', label: '灵感' },
  { key: 'wealth', label: '财运' },
];

const SUITS_GOOD = [
  '重构一段陈年代码', '写一篇技术笔记', '认真做一次 Code Review', 'Pair programming',
  '提一个 draft PR', '关闭通知专注 90 分钟', '用便签理清需求', '部署一次到测试环境',
  '认真补单元测试', '把一个 TODO 注释清掉', '请同事喝一杯咖啡', '早一点下班，散步回家',
  '给变量起个好听的名字', '更新依赖小版本', '阅读一份开源项目 README',
];

const SUITS_BAD = [
  '周五傍晚发布到生产', '直接改 main 分支', 'git push --force', '跳过测试就合并',
  'rm -rf 不看路径', '在没备份时改数据库', 'npm install -g 不看版本', '关掉 CI 通知',
  '在情绪激动时回复评论', '把 try { ... } catch {} 留在 PR 里', '熬夜调一个一行就能改的 bug',
];

const COLORS = [
  { name: '靛青', hex: '#4f46e5' },
  { name: '玫珀', hex: '#f472b6' },
  { name: '湖蓝', hex: '#06b6d4' },
  { name: '森绿', hex: '#10b981' },
  { name: '橙金', hex: '#f59e0b' },
  { name: '雾紫', hex: '#a78bfa' },
  { name: '砖红', hex: '#ef4444' },
  { name: '雪白', hex: '#f5f5f7' },
  { name: '炭黑', hex: '#1f2937' },
];

const HOURS = ['上午 09:30 — 11:00', '下午 14:00 — 15:30', '下午 16:00 — 17:30', '夜晚 20:00 — 21:30', '深夜 22:00 — 23:30'];

const MANTRAS = [
  'It compiles. Ship it.',
  'Make it work, make it right, make it fast.',
  'Done is better than perfect.',
  '最好的代码，是不必写的代码。',
  '一次只解决一个问题。',
  '能跑起来，就先跑起来。',
  '相信你的下一个 git commit。',
  '今天的我，不评判过去的我。',
];

// ── Random utilities (seeded) ────────────────────────
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function pickN(rand, arr, n) {
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(rand() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

// ── Fortune generation ───────────────────────────────
function generateFortune(date) {
  const seed = hashSeed('bitfun-divination-' + date);
  const rand = mulberry32(seed);
  const card = CARDS[Math.floor(rand() * CARDS.length)];

  // Each dimension 1..5 stars, biased towards 3-4.
  const fortunes = FORTUNE_KEYS.map(({ key, label }) => {
    const r = rand();
    const stars = r < 0.06 ? 1 : r < 0.2 ? 2 : r < 0.55 ? 3 : r < 0.85 ? 4 : 5;
    return { key, label, stars };
  });

  const goods = pickN(rand, SUITS_GOOD, 3);
  const bads = pickN(rand, SUITS_BAD, 2);
  const color = pick(rand, COLORS);
  const luckyNumber = 1 + Math.floor(rand() * 99);
  const hour = pick(rand, HOURS);
  const mantra = pick(rand, MANTRAS);

  return { card, fortunes, goods, bads, color, luckyNumber, hour, mantra };
}

// ── DOM ──────────────────────────────────────────────
const dom = {
  dateLabel: document.getElementById('date-label'),
  revealStage: document.getElementById('reveal-stage'),
  resultStage: document.getElementById('result-stage'),
  cardBack: document.getElementById('card-back'),
  cardFront: document.getElementById('card-front'),
  cardIndex: document.getElementById('card-index'),
  cardTag: document.getElementById('card-tag'),
  cardArt: document.getElementById('card-art'),
  cardName: document.getElementById('card-name'),
  cardKeyword: document.getElementById('card-keyword'),
  cardQuote: document.getElementById('card-quote'),
  fortunes: document.getElementById('fortunes'),
  suitGood: document.getElementById('suit-good'),
  suitBad: document.getElementById('suit-bad'),
  luckyColorSwatch: document.getElementById('lucky-color-swatch'),
  luckyColorName: document.getElementById('lucky-color-name'),
  luckyNumber: document.getElementById('lucky-number'),
  luckyHour: document.getElementById('lucky-hour'),
  luckyMantra: document.getElementById('lucky-mantra'),
  btnShare: document.getElementById('btn-share'),
  toast: document.getElementById('toast'),
};

let currentResult = null;

function fmtDate(date) {
  const [y, m, d] = date.split('-');
  return `${y} 年 ${parseInt(m, 10)} 月 ${parseInt(d, 10)} 日`;
}

async function init() {
  const today = dateKey();
  dom.dateLabel.textContent = fmtDate(today);
  let saved = null;
  try { saved = await app.storage.get('lastReading'); } catch (_e) { /* ignore */ }
  if (saved && saved.date === today) {
    revealCard(today, true);
  } else {
    setupReveal(today);
  }
}

function setupReveal(today) {
  dom.revealStage.hidden = false;
  dom.resultStage.hidden = true;
  const handler = () => revealCard(today, false);
  dom.cardBack.addEventListener('click', handler, { once: true });
  dom.cardBack.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealCard(today, false); }
  }, { once: true });
}

function revealCard(date, immediate) {
  const fortune = generateFortune(date);
  currentResult = { date, ...fortune };
  if (!immediate) {
    dom.cardBack.style.transition = 'transform .35s ease, opacity .35s ease';
    dom.cardBack.style.transform = 'rotateY(90deg) scale(0.96)';
    dom.cardBack.style.opacity = '0';
    setTimeout(() => paintResult(fortune), 320);
  } else {
    paintResult(fortune);
  }
  app.storage.set('lastReading', { date, cardName: fortune.card.name }).catch(() => {});
}

function paintResult(f) {
  dom.revealStage.hidden = true;
  dom.resultStage.hidden = false;
  dom.btnShare.hidden = false;

  const idx = CARDS.indexOf(f.card) + 1;
  dom.cardIndex.textContent = `No. ${String(idx).padStart(2, '0')}`;
  dom.cardTag.textContent = f.card.tag;
  dom.cardArt.textContent = f.card.symbol;
  dom.cardName.textContent = f.card.name;
  dom.cardKeyword.textContent = f.card.keyword;
  dom.cardQuote.textContent = `"${f.card.quote}"`;
  dom.cardFront.style.setProperty('--card-tone-1', f.card.tone[0]);
  dom.cardFront.style.setProperty('--card-tone-2', f.card.tone[1]);

  dom.fortunes.innerHTML = '';
  for (const item of f.fortunes) {
    const li = document.createElement('li');
    li.className = 'fortune';
    li.innerHTML = `
      <span class="fortune__label">${item.label}</span>
      <span class="fortune__bar"><span class="fortune__fill" style="width:0"></span></span>
      <span class="fortune__stars">${'★'.repeat(item.stars)}<span class="ghost">${'★'.repeat(5 - item.stars)}</span></span>
    `;
    dom.fortunes.appendChild(li);
    requestAnimationFrame(() => {
      li.querySelector('.fortune__fill').style.width = `${item.stars * 20}%`;
    });
  }

  dom.suitGood.innerHTML = f.goods.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  dom.suitBad.innerHTML = f.bads.map((s) => `<li>${escapeHtml(s)}</li>`).join('');

  dom.luckyColorSwatch.style.background = f.color.hex;
  dom.luckyColorName.textContent = f.color.name;
  dom.luckyNumber.textContent = String(f.luckyNumber);
  dom.luckyHour.textContent = f.hour;
  dom.luckyMantra.textContent = `"${f.mantra}"`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

dom.btnShare.addEventListener('click', async () => {
  if (!currentResult) return;
  const f = currentResult;
  const lines = [];
  lines.push(`【${f.card.name}】 ${f.card.keyword}`);
  lines.push(f.card.quote);
  lines.push('');
  for (const item of f.fortunes) {
    lines.push(`${item.label}：${'★'.repeat(item.stars)}${'☆'.repeat(5 - item.stars)}`);
  }
  lines.push('');
  lines.push(`今日宜：${f.goods.join('、')}`);
  lines.push(`今日忌：${f.bads.join('、')}`);
  lines.push('');
  lines.push(`幸运色：${f.color.name}　幸运数字：${f.luckyNumber}　推荐时段：${f.hour}`);
  lines.push(`咒语：${f.mantra}`);
  const text = lines.join('\n');
  try {
    await app.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch (_e) {
    showToast('复制失败');
  }
});

let toastTimer = null;
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 1600);
}

init();
