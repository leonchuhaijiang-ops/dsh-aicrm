// sales-lib.js — AI-CRM客资管理系统数据访问层（命令行）
// 用法: node sales-lib.js <command> [args...]
// 所有输出为 JSON 到 stdout。数据源: 销售客户-主表.xlsx + 销售客户-流水表.xlsx
// 原则: 数据以 Excel 为唯一事实源; 本脚本只是读写它的壳。
const X = require('xlsx');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------- 数据目录解析（开源版：源码里不写死任何本机路径） ----------
// 优先级：--dir 参数（插件运行时显式传）> 环境变量 SALE_DIR > 配置文件 dataDir > 默认目录。
// 默认目录 = <home>/dsh-sales-data；首次使用请跑 `npm run setup` 或看板里的「首次设置」，
//   它会把数据目录、空表、示例语料一起建好（见 scripts/setup.mjs）。
function argDataDir() {
  for (const flag of ['--dir', '--data-dir']) {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1]);
  }
  return '';
}
function configDataDir() {
  try {
    const envFile = String(process.env.DSH_SALES_CONFIG || '').trim();
    const file = envFile ? path.resolve(envFile) : path.join(os.homedir(), '.dsh', 'sales.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const d = String((cfg && cfg.dataDir) || '').trim();
    return d && path.isAbsolute(d) ? d : '';
  } catch (e) { return ''; }
}
// 产品名（话术模板里自报家门用）：配置里的 profile.product，没配就一句中性说法。
//   ⚠ 话术模板（SCENE_MSG / OPEN_TPL 等）是**可改的**：换成你自己的产品说法见 README 的「自定义话术」。
function configProduct() {
  try {
    const envFile = String(process.env.DSH_SALES_CONFIG || '').trim();
    const file = envFile ? path.resolve(envFile) : path.join(os.homedir(), '.dsh', 'sales.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = String((cfg && cfg.profile && cfg.profile.product) || '').trim();
    return p.slice(0, 60);
  } catch (e) { return ''; }
}
const PRODUCT = configProduct() || '我们的产品';
const DIR = path.resolve(
  argDataDir() || String(process.env.SALE_DIR || '').trim() || configDataDir() || path.join(os.homedir(), 'dsh-sales-data')
);
const MASTER = path.join(DIR, '销售客户-主表.xlsx');
const FLOW = path.join(DIR, '销售客户-流水表.xlsx');
// 营销资料库的结构化语料（格式见 templates/营销资料库/销售技巧-结构化.json）
const TIPS_JSON = path.join(DIR, '营销资料库', '销售技巧-结构化.json');

// ---------- 表头契约（2026-09-14 加固 P0） ----------
// 根因: 原 headers 取 Object.keys(rows[0])。首行若为空/被重排 → headers={} →
//   json_to_sheet(rows,{header:{}}) 产出零单元格表 → atomicWrite 整表覆盖 → 全表静默清空(实测 ref=A1)。
// 现存: 写表头一律取「工作表表头行」，取不到退契约常量；写前断言关键列齐全、非空列名、非零行，不满足直接抛错不落盘。
const HEADERS_MASTER = ['客户ID','公司','姓名/联系人','手机','客户等级','跟进状态','触达状态','下次跟进时间','下次跟进方式','备注','原编号','建档日期','建档类型','微信昵称','城市','来源','意向阶段','是否购买','付款总额','责任人','放弃原因分类','首访排期','注册时间','最后登陆时间','到期时间','智算次数','智写登录次数','智写剩余字数','智写消耗字数','智写文章生成次数','智写购买字数'];
const HEADERS_FLOW = ['流水ID','客户ID','日期','方式','类型','沟通内容','对方反应','下一步动作','下次跟进时间','下次跟进方式','阶段'];
const HEADERS_CONTACT = ['客户ID','姓名','手机','微信昵称','角色/备注'];
// 2026-10-13 批次5 审计 P0-3：原来只取前 10 列 → 第 11~31 列（意向阶段/触达状态/微信昵称/城市/到期时间/
//   注册时间/用量 4 列…）表头一旦损坏，写闸不拦；readMaster 的 headers 取自工作表实际表头行，
//   json_to_sheet(rows,{header:headers}) 会按坏表头产出新表 → 整列静默丢弃（cmdLog/cmdAdd 的
//   headers.includes(x) 还只是 skip，不报错）。实测 2026-10-13 主表表头 31 列齐全、空列名 0 →
//   直接取全量契约（缺任一列 = 结构损坏，fail-closed 拒绝写入，与不变量 #2 逐字一致）。
const MST = HEADERS_MASTER.slice();   // 全量关键列(缺一即表头损坏)
const FLT = HEADERS_FLOW.slice();
const CT = HEADERS_CONTACT.slice();
// 表头行读取（唯一允许用 header:1 的地方 —— 只读表头，绝不回写） lint-allow-header1
function sheetHeader(ws, fallback) {
  try {
    const aoa = X.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    const cols = (aoa[0] || []).map(v => String(v == null ? '' : v).trim()).filter(Boolean);
    if (cols.length) return cols;
  } catch (e) { /* 落到契约常量 */ }
  return fallback.slice();
}
function assertWritable(headers, required, label, rows, existingCount) {
  if (!Array.isArray(headers) || headers.length === 0) throw new Error(label + '表头为空，拒绝写入(防整表清空)');
  if (headers.some(h => !String(h == null ? '' : h).trim())) throw new Error(label + '表头含空列名，拒绝写入');
  const miss = required.filter(k => !headers.includes(k));
  if (miss.length) throw new Error(label + '表头缺关键列: ' + miss.join('/') + '，拒绝写入(疑似结构损坏)');
  if (rows.length === 0 && existingCount > 0) throw new Error(label + '将被写成 0 行(原有 ' + existingCount + ' 行)，拒绝写入');
}
// ---------- 变更日志（2026-09-14 新增）----------
// 每次落盘前追加一行 jsonl：谁(pid/入口)、写哪张表、多少行多少列。出事后能追溯，不再靠猜。
const LOG_DIR = path.join(DIR, 'logs');
function logChange(target, note) {
  try {
    const fs = require('fs');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const f = path.join(LOG_DIR, 'changes-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + '.jsonl');
    const entry = Object.assign({ ts: new Date().toISOString(), pid: process.pid, entry: process.argv[2] || '', file: path.basename(target) }, note || {});
    fs.appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { /* 留痕失败不阻塞主流程 */ }
}
// ---------- 工具 ----------
function readMaster() {
  const wb = X.readFile(MASTER);
  const ws = wb.Sheets['客户主表'];
  const rows = X.utils.sheet_to_json(ws, { defval: '' });
  return { wb, rows, headers: sheetHeader(ws, HEADERS_MASTER) };
}
function readFlow() {
  const wb = X.readFile(FLOW);
  const ws = wb.Sheets['跟进流水'];
  const rows = X.utils.sheet_to_json(ws, { defval: '' });
  return { wb, rows, headers: sheetHeader(ws, HEADERS_FLOW) };
}
function writeMaster(wb, rows, headers, opts) {
  const existing = X.utils.sheet_to_json(wb.Sheets['客户主表'], { defval: '' }).length;
  assertWritable(headers, MST, '主表', rows, (opts && opts.allowEmpty) ? 0 : existing);
  const ws = X.utils.json_to_sheet(rows, { header: headers });
  // 2026-09-14: opts.addDate1904=false → 只改几行时不要把整表日期转成序列号/Date 单元格，保持原始口径
  if (opts && opts.addDate1904 === false) ws['!date1904'] = false;
  wb.Sheets['客户主表'] = ws;
  atomicWrite(wb, MASTER);
  // 2026-10-08 审计 A17：留痕移到**写成功之后**。原来先记后写，写失败（或被 kill）会留下一条"并未发生"的变更记录。
  logChange(MASTER, { op: 'writeMaster', rows: rows.length, cols: headers.length, before: existing });
}
function writeFlow(wb, rows, headers, opts) {
  const existing = X.utils.sheet_to_json(wb.Sheets['跟进流水'], { defval: '' }).length;
  assertWritable(headers, FLT, '流水表', rows, (opts && opts.allowEmpty) ? 0 : existing);
  const ws = X.utils.json_to_sheet(rows, { header: headers });
  wb.Sheets['跟进流水'] = ws;
  atomicWrite(wb, FLOW);
  logChange(FLOW, { op: 'writeFlow', rows: rows.length, cols: headers.length, before: existing });
}
// 原子写：先写临时文件，成功后 rename 覆盖原文件。写一半崩溃也不损坏原文件。
// 2026-08-24 修复: tmp 文件名唯一(pid+时间戳)，杜绝并发写(看板30秒刷新 vs cmdLog)互相覆盖同一 .tmp 导致丢行
// 2026-10-08 审计 A15 重构: 抽 renameWithRetrySync 供 xlsx 与 JSON 两条原子写路径共用（原来 JSON 路径无退避）
function renameWithRetrySync(tmp, target) {
  const fs = require('fs');
  let lastErr = null;
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(tmp, target); return { ok: true }; }
    catch (e) {
      lastErr = e;
      const code = String((e && e.code) || '');
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'EEXIST') break;
      const until = Date.now() + 60 + i * 40;
      while (Date.now() < until) { /* 退避等待，Windows 锁通常几十毫秒释放 */ }
    }
  }
  return { ok: false, err: lastErr };
}
function atomicWrite(wb, target) {
  const fs = require('fs');
  const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  X.writeFile(wb, tmp, { bookType: 'xlsx' }); // 显式指定 xlsx，避免按 .tmp 后缀推断失败
  // 2026-09-14 加固(P0): Windows 上 rename 会被杀毒/索引器/Excel 短暂占用而报 EPERM/EBUSY。
  //   原实现直接抛错 → cmdLog 变成"流水已写、主表未回写"的半写（selftest 已复现）。
  //   现在退避重试；彻底失败时**保留 tmp 文件**（数据不丢，可人工改名恢复）并给出明确文案。
  const r = renameWithRetrySync(tmp, target);
  if (r.ok) return;
  try { process.stderr.write('[sales-lib] 写盘失败(临时文件已保留): ' + tmp + ' err=' + String(r.err && r.err.message || r.err) + '\n'); } catch (_) { /* 忽略 */ }
  throw new Error('写 ' + path.basename(target) + ' 失败: ' + String(r.err && r.err.message || r.err) + '（临时文件已保留: ' + path.basename(tmp) + '，可改名恢复）');
}

// ---------- 原子写 JSON 状态文件 + 坏文件留痕（2026-09-14 新增） ----------
// 背景: 首访任务清单.json 原来 readFileSync→parse→writeFileSync 全程无锁、非原子；
//   被 kill 时 writeFileSync 截断 → 次日 JSON.parse 抛错被 catch 吞掉 → 静默重置成"无状态"，
//   当天清单被重排（"当天不补新"铁律失效）。此处补唯一的 tmp + rename 原子写 + .corrupt 留痕。
function atomicWriteJSON(obj, target) {
  const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    require('fs').writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  } catch (e) {
    try { require('fs').unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    return false;
  }
  // 2026-10-08 审计 A15：JSON 路径原来直接用 renameSync（无 EPERM/EBUSY 退避）且失败时**删掉临时文件**，
  //   与 xlsx 路径行为不一致、数据也丢了。现在共用 renameWithRetrySync，失败保留 tmp 供人工恢复。
  const r = renameWithRetrySync(tmp, target);
  if (r.ok) return true;
  try { process.stderr.write('[sales-lib] JSON 原子写失败(临时文件已保留): ' + tmp + ' err=' + String(r.err && r.err.message || r.err) + '\n'); } catch (_) { /* 忽略 */ }
  return false;
}
function readJSONState(target) {
  const fs = require('fs');
  if (!fs.existsSync(target)) return null;
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (e) {
    // 坏文件不静默吞：另存 .corrupt-<ts> 留证，并返回 {__corrupt:true} 让调用方**拒绝重建**
    //   （2026-09-14 加固：原来返回 null → 调用方按"无状态"重建 → 当天清单被重排，违反"当天不补新"）
    let renamed = false;
    try { fs.renameSync(target, target + '.corrupt-' + Date.now()); renamed = true; }
    catch (err) {
      try { process.stderr.write('[sales-lib] 坏状态文件改名失败(将原地保留): ' + String(err && err.message || err) + '\n'); } catch (_) { /* 忽略 */ }
    }
    return { __corrupt: true, renamed, error: String(e && e.message || e) };
  }
}

// ---------- 写入锁（并发防撞） ----------
// 用锁文件保证同时只有一个写操作在改 Excel；拿不到锁则等待，超时返回失败。
const LOCK_PATH = path.join(DIR, '.sales-lock');
const LOCK_TIMEOUT_MS = 8000;   // 最长等锁 8 秒
const LOCK_POLL_MS = 60;        // 每 60ms 重试一次
const LOCK_STALE_MS = 60000;    // 2026-09-14: 锁超过 60 秒视为陈旧（进程被 kill 的残留），可抢占
// 2026-10-08 审计 A16/B3：锁归属身份 —— 每进程一个 token，抢占要看**持有者是否还活着**，释放只删自己的锁。
//   原来只按 mtime 判陈旧 + releaseLock 无条件 unlink：持锁超过 60s 会被别人抢走，之后原持有者一释放
//   就把**别人的锁**删掉 → 两个写进程同时进临界区 → 双写覆盖。
const LOCK_TOKEN = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
function readLockOwner() {
  try {
    const j = JSON.parse(require('fs').readFileSync(LOCK_PATH, 'utf8'));
    return (j && typeof j === 'object') ? j : null;
  } catch (_) { return null; }
}
function lockOwnerAlive(owner) {
  const pid = owner && Number(owner.pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;   // 拿不到 pid：按"无法确认存活"处理，允许按陈旧抢占
  try { process.kill(pid, 0); return true; }              // 能发信号 = 活着
  catch (e) { return String((e && e.code) || '') === 'EPERM'; } // 活着但没权限（视为活着）
}
function acquireLock() {
  const fs = require('fs');
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx'); // 'wx' 独占创建，已存在则抛 EEXIST
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token: LOCK_TOKEN })); } catch (_) { /* 内容只是留证 */ }
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false; // 非"已存在"错误，直接失败
    }
    // 2026-09-14: 陈旧锁检测（restart-dsh.bat / 崩溃会永久留下 .sales-lock，此后所有写操作一律"文件忙"）
    // 2026-10-08 加固: 只有"mtime 陈旧 **且** 持有者进程已不在"才抢占；持有者还活着就不动它。
    try {
      const st = fs.statSync(LOCK_PATH);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS && !lockOwnerAlive(readLockOwner())) {
        try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* 别人抢先删了也无妨 */ }
        continue;
      }
    } catch (_) { /* 锁刚被释放，下一轮 openSync 会成功 */ }
    if (Date.now() - start >= LOCK_TIMEOUT_MS) return false;
    // 等待重试（同步阻塞极小段）
    const waitUntil = Date.now() + LOCK_POLL_MS;
    while (Date.now() < waitUntil) { /* spin */ }
  }
}
function releaseLock() {
  // 2026-10-08 审计 A16：只删**自己的**锁（token 比对），绝不误删抢锁者的锁。
  try {
    const owner = readLockOwner();
    if (owner && owner.token === LOCK_TOKEN) require('fs').unlinkSync(LOCK_PATH);
  } catch (e) { /* 忽略 */ }
}
// 带锁执行写操作；fn 返回 {ok,...}
function withWriteLock(fn) {
  if (!acquireLock()) return { ok: false, message: '文件忙（有其他写入进行中），请稍后重试' };
  try {
    return fn();
  } finally {
    releaseLock();
  }
}
// ---------- 日期口径统一（2026-09-14 修复：兼容 Excel 序列号 / YYYY-MM-DD 字符串） ----------
// 背景: 2026-08-25 并入李昂批次脚本（backup/治理-并入李昂批次-20260825.js:111）与 9-14 官网导出
//   都把日期写成了 Excel 序列号(如 46253)。而 ruleHits(近5天登录)/byDateWithin(P2优先)/
//   silentDaysOf(静默天数) 只认 /^\d{4}-\d{2}-\d{2}$/ 字符串，序列号一律静默失效：
//   命中少算1条、P2 优先级丢失、待定区静默天数变 null。此处统一入口，任何写入口都必须先过它。
// 口径: 序列号按 1900 日期系统(与本文件 dateToSerial 同基准，基准 1899-12-30)；5位数字(20000~60000)才当序列号。
// 2026-09-14 (t6/G1 加固): 日历换算统一走 UTC(序列号→Date 用 UTC 正午语义)，彻底避开本地时区/DST
//   （中国 1986-1991 有夏令时，本地 setDate/getDate 会把 DST 日折回前一天；历史注册时间跨这些年份）。
const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
function utcMidnight(y, mo, d) { return new Date(Date.UTC(y, mo, d)); }
function parseDate(cell) {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return isNaN(cell.getTime()) ? null : cell;
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return null;
    const n = Math.floor(cell);
    // 2026-09-14 加固: 序列号范围放宽到 10000~59999（原来 20000 下界会漏判早期日期），
    //   并新增 8 位 YYYYMMDD 数字型日期（如 20240102）——两者原来都静默返回 null。
    if (n >= 10000 && n < 60000) {        // Excel 序列号(1900制, dateToSerial 反算)
      const d = new Date(SERIAL_EPOCH + n * 86400000 + 43200000); // +12h 防边界
      return isNaN(d.getTime()) ? null : d;
    }
    if (n >= 19000101 && n <= 22001231) { // 8 位 YYYYMMDD
      const y = Math.floor(n / 10000), mo = Math.floor(n / 100) % 100, dd = n % 100;
      if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) return utcMidnight(y, mo - 1, dd);
    }
    return null;
  }
  const s = String(cell).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // YYYY-MM-DD（含带时间的 ISO）
  if (!m) m = s.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})/);  // YYYY/MM/DD、YYYY.MM.DD
  if (!m) m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);     // 中文日期
  if (m) {
    // 2026-10-08 审计 A8：原实现不校验月/日，'2024-13-45' 被静默折成 2025-02-14、'2024-02-30' 折成 2024-03-01。
    //   现在月/日必须在合法范围，且 UTC 回算必须与输入一致（挡住 2-30 / 4-31 这类"跨月进位"）。
    const y = Number(m[1]), mo = Number(m[2]), dd = Number(m[3]);
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
    const d = utcMidnight(y, mo - 1, dd);
    if (isNaN(d.getTime()) || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== dd) return null;
    return d;
  }
  if (/^\d{5}$/.test(s)) return parseDate(Number(s));          // 字符串形式的序列号
  if (/^\d{8}$/.test(s)) return parseDate(Number(s));          // 2026-10-08 审计 A8：8 位字符串日期与数字型口径对齐
  const d = new Date(s);                                       // 最后兜底
  return isNaN(d.getTime()) ? null : d;
}
// 任意日期输入 -> 'YYYY-MM-DD'；无法识别返回 ''（写入口只接受这一种落库格式）
function normDateStr(v) {
  const d = parseDate(v);
  if (!d) return '';
  // 2026-09-14 加固: 消除"Date 走本地 / 其余走 UTC"的双口径（同一时刻会静默差 1 天）。
  //   规则: Date 对象且时间恰为本地零点 → 按本地日历日(Excel 真日期单元格的常见形态)；
  //         其余(字符串/序列号/带时间的 Date) → 按 UTC 日历日。
  const localMidnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  if (v instanceof Date && localMidnight) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
// 日序号（纯日历天数, UTC 基准）：用于算"静默天数"等跨天差，不受 DST 影响
function dayNum(v) {
  const n = dateToSerial(v);
  return Number.isFinite(n) ? n : NaN;
}
// 日期格式校验: YYYY-MM-DD
function isDateStr(s) {
  // 2026-10-21 体检（m03962，P0）：原来只做正则，'2026-02-30' 这类假日期一路放行 →
  //   ① cmdLog 落「日期」时 normDateStr 得空串（事件日期静默丢失）；
  //   ② 「下次跟进时间」写原始值不归一 → 读侧算不出逾期，客户静默掉出队列；
  //   ③ cmdSettle 的锚点得空串 → 该客户既不算「锚点到期」也不进「停住·无锚点」，永久隐身。
  //   现在必须真能解析，并且解析回来与原串一致（2 月 30 日 / 4 月 31 日会被挡掉）。
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = parseDate(s)
  return !!d && normDateStr(d) === s
}
// 合法枚举
const METHOD_SET = { '电话':1, '微信':1, '上门':1, '短信':1, '合同':1, '官网申请':1, '其他':1 };
const TYPE_SET = { '首触':1, '试用回访':1, '高意向跟进':1, '老客服务':1, '客户反馈':1, '策略调整':1, '放弃跟进':1, '数据整理':1 };
// ===== SOP 阶段（2026-09-29 用户定 7 段漏斗 → 2026-10-08 延伸为企业级双轨 13 段）=====
// 标品段(1-7): 线索获取 → **客户触达** → 需求挖掘 → 产品演示 → 异议处理 → 方案报价 → 成交签约
// 企业级段(8-13): 企业级机会 → 决策链摸排 → 需求与现状勘察 → 方案与试点设计 → 商务推进 → 私有化签约
//   来由(用户 2026-10-08 总体计划)：能成交的客户两条路——① 先买标品，用标品建立信任后向企业级 AI 落地推动；
//   ② 直接私有化部署，直接谈企业级 AI 落地。企业级 6 段 = 《企业级AI落地全景推介简报》落地四阶段的售前侧
//   （选择场景 → 整理资料 → 建设试点 → 评估扩展），段名一律用用户一眼看懂的业务词。
//   赛道(track) 由「阶段 + 结果」派生，不落盘、不新增列（见 sopTrackOf）。
// 出口(终态, 兜住「每个客户都要有个结果」): 无法联系 / 推进终止
// 落库口径: 主表「意向阶段」= 客户**当前阶段**；流水「阶段」= **这条跟进发生在哪个阶段**。
//   空 = 未标注（历史数据/尚未纳入 SOP）。不新增主表列（复用原「意向阶段」，旧值一次性映射）。
// 2026-09-29 三次调整: ① 第 3 段「预约演示」改名「产品演示」；② **取消「价值传递」段，并入「产品演示」**
//   （用户口径：产品演示即是价值传递；与他自己的《三季度客户线索统计》表「产品演示与价值传递」同口径）；
//   ③ **新增第 2 段「客户触达」**（用户定：线索获取=线索进池还没跟；客户触达=第一次打通/加上微信）。
// 旧名一律留在 STAGE_ALIAS 兜底（口误/历史数据自动归一，不会被当非法值拒掉）。
const STAGE_STD = ['线索获取', '客户触达', '需求挖掘', '产品演示', '异议处理', '方案报价', '成交签约'];
const STAGE_ENT = ['企业级机会', '决策链摸排', '需求与现状勘察', '方案与试点设计', '商务推进', '私有化签约'];
const STAGE_MAIN = STAGE_STD.concat(STAGE_ENT);   // 13 段有序漏斗：seq/统计/看板/check 全部从这里派生
const STAGE_ENT_MIN = STAGE_STD.length + 1;       // 8 = 企业级第一段的 seq（赛道派生用）
const STAGE_EXIT = ['无法联系', '推进终止'];
const STAGE_SET = Object.create(null);   // 2026-10-08 审计 A13：null 原型 —— 别让 'constructor'/'toString' 这类原型键被当成合法阶段
STAGE_MAIN.concat(STAGE_EXIT).forEach(s => { STAGE_SET[s] = 1; });
const STAGE_ORDER = STAGE_MAIN.concat(STAGE_EXIT).concat(['(未标注)']);
// 历史「意向阶段」旧值 → SOP 阶段（迁移用，同时兜底后续误写）。
//   旧名留在这里兜底（迁移脚本会自动改写表内旧值），历史数据和用户口误都还能落回正式值，不会被当非法值拒掉。
const STAGE_ALIAS = Object.assign(Object.create(null), { '兴趣': '需求挖掘', '已诊断': '产品演示', '申请智算试用': '产品演示', '成交': '成交签约', '签约': '成交签约', '试用': '产品演示', '预约演示': '产品演示', '价值传递': '产品演示', '触达': '客户触达',
  // 2026-10-08 企业级段别名（用户口误/历史备注里的叫法一律兜底归一）
  '企业版': '企业级机会', '私有化': '企业级机会', '私有化部署': '企业级机会', '企业级AI': '企业级机会',
  '企业级AI落地': '企业级机会', '智能体': '企业级机会', '企业知识库': '企业级机会',
  '决策链': '决策链摸排', '决策人': '决策链摸排', '决策角色': '决策链摸排',
  '勘察': '需求与现状勘察', '需求对接': '需求与现状勘察', '现状勘察': '需求与现状勘察',
  '方案': '方案与试点设计', '试点': '方案与试点设计', 'POC': '方案与试点设计',
  '合同': '商务推进', '法务': '商务推进', '商务': '商务推进' });
// 直接触达方式（2026-09-29 新增）：**真人联系上客户**的动作。
//   「官网申请 / 其他(建档、导入)」不算触达，只算线索进池（落「线索获取」）。
const TOUCH_METHOD_SET = Object.assign(Object.create(null), { '电话': 1, '微信': 1, '上门': 1, '短信': 1, '合同': 1 });   // 审计 A13
const isTouchMethod = (v) => TOUCH_METHOD_SET[String(v == null ? '' : v).trim()] === 1;
// 流水「类型」→ 阶段（历史回填用；**拿不准的一律不回填**，留空显示「未标注」）
//   首触 = 第一次接触 = 「客户触达」（2026-09-29 随新增第 2 段同步改口径）
const TYPE_STAGE_FILL = Object.assign(Object.create(null), { '首触': '客户触达', '试用回访': '产品演示', '老客服务': '成交签约', '放弃跟进': '推进终止' });   // 审计 A13
// 归一化：空→''；正式值→原样；旧别名→正式名；不认识的值原样返回（交 check 报出来，绝不静默吞掉）
function normStage(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (STAGE_SET[s]) return s;
  if (STAGE_ALIAS[s]) return STAGE_ALIAS[s];
  return s;
}
const stageSeq = (s) => { const i = STAGE_MAIN.indexOf(normStage(s)); return i >= 0 ? i + 1 : 0; };
const isExitStage = (s) => STAGE_EXIT.indexOf(normStage(s)) >= 0;
// 阶段推进说明（写日志时回给用户看：推进/停留/回退/跳段/终止）
function stageMoveNote(from, to) {
  const f = normStage(from), t = normStage(to);
  if (!t) return '';
  if (!f) return `SOP 起点：${t}`;
  if (f === t) return `停留在「${t}」`;
  if (isExitStage(t)) return `SOP 终止：${f} → ${t}（客户已有结果）`;
  if (isExitStage(f)) return `从出口「${f}」拉回「${t}」`;
  const a = stageSeq(f), b = stageSeq(t);
  if (b > a) {
    const skipped = STAGE_MAIN.slice(a, b - 1);
    return skipped.length ? `SOP 推进：${f} → ${t}（跳过 ${skipped.join('/')}）` : `SOP 推进：${f} → ${t}`;
  }
  return `SOP 回退：${f} → ${t}`;
}
// 2026-09-24 用户定: 「挂起」= 已接触过、但下次跟进时间不确定（有跟进意愿，只是没定日子）；
//   「挂起冷备」= 暂时不考虑跟进了。两者必须分开，别再混用。
const STATUS_SET = Object.assign(Object.create(null), { '跟进中':1, '挂起':1, '重点跟进':1, '挂起冷备':1, '已闭环':1, '待首触':1 });   // 审计 A13
// 触达状态合法值（2026-09-14: 非本人/渠道/失联 已废弃，写入口不再接受；读入历史值仍可由 check 报出来）
const TOUCH_SET = { '未触达':1, '待微信通过':1, '已加微信':1, '已触达':1 };

// 2026-10-20 用户定（m01043）：「申请加微信」只算跟进记录，**不等于加上了**。
//   以前口径是「方式含微信 → 触达状态直接=已加微信」，把"我发了申请"当成"客户通过了"，
//   于是主表显示已加微信、实际根本没通过（本次实测 17 个客户就是这种）。
//   新口径（2026-10-20 用户原话「微信加了就是加了没加就是没加，不要没加的也算到已加里面」）：
//     ① 流水正文/对方反应里明确出现 已加微信/已通过/已添加/加上了/通过好友 → 「已加微信」；
//     ② 只出现 申请加微信/请求添加/待通过/未加成功… 这类"还在申请中/没加上" → 新增第四态「待微信通过」；
//     ③ 方式含微信但正文什么都没写清（无法举证）→ 新写的一律「待微信通过」；
//        已经是「已加微信」的历史行保持不动（不替他翻旧账，要翻由他点名），check 里单列提示。
//   四态互斥：未触达 / 待微信通过 / 已触达 / 已加微信（cmdSummary 计数也按这四态）。
const WECHAT_CONFIRM_RE = /已加微信|已通过|已添加|加上了|通过好友|已同意好友|好友已通过|已加上/;
const WECHAT_PENDING_RE = /申请加微信|加微信申请|请求加微信|请求添加|申请好友|待通过|等待通过|还没通过|未通过|没通过|未加成功|没加成功|未加上|没加上/;
function deriveTouchState(custFlows, cur) {
  const list = custFlows || [];
  if (!list.length) return '未触达';
  const hasWechat = list.some(f => String(f['方式'] || '').indexOf('微信') >= 0);
  if (!hasWechat) return '已触达';
  const blob = list.map(f => String(f['沟通内容'] || '') + ' ' + String(f['对方反应'] || '')).join(' ');
  if (WECHAT_CONFIRM_RE.test(blob)) return '已加微信';
  if (WECHAT_PENDING_RE.test(blob)) return '待微信通过';
  // 无法举证：历史「已加微信」保持不动，其余一律挂在「待微信通过」等他确认
  return String(cur || '').trim() === '已加微信' ? '已加微信' : '待微信通过';
}
// 判断某条流水本身是不是"只申请、没通过"（写入口用它提示调用方）
function isWechatPendingText(txt) {
  const s = String(txt || '');
  return WECHAT_PENDING_RE.test(s) && !WECHAT_CONFIRM_RE.test(s);
}

// 客户行 -> 统一出参（2026-09-14: 从 cmdTasks 提为模块级，供 tasks/search 共用，杜绝对同一份字段两处硬编码）
function pickCust(r, slim, flowRows) {
  const res = sopResultOf(r, flowRows);   // 2026-10-08 结果层（8 值派生，见 sopResultOf）
  const base = {
    id: r['客户ID'], name: r['公司'] || r['姓名/联系人'], contact: r['姓名/联系人'], phone: r['手机'],
    level: r['客户等级'] || '未定级', status: r['跟进状态'], next: normDateStr(r['下次跟进时间']), city: r['城市'],
    note: String(r['备注'] || '').slice(0, 80),
    stage: normStage(r['意向阶段']),            // SOP 当前阶段（2026-09-29）
    stageSeq: stageSeq(r['意向阶段']),          // 漏斗序号 1-13；出口/未标注=0
    result: res.result,                        // 结果（2026-10-08）：未开始/推进中/沉默等需求/暂缓/成交签约/无法联系/推进终止/停住·无锚点
    progress: res.progress,                    // 进度标签：3/13｜成交｜出口·无法联系｜沉默·停在客户触达…
    anchor: res.anchor,                        // 停住类的复查锚点（日期或信号）
    track: sopTrackOf(r, flowRows),            // 赛道 6 轨（2026-10-08 派生）：标品漏斗/标品信任期/企业级直谈/企业级升级/培育/出口
  };
  if (slim) return base; // 精简模式(模型工具用)：省 token，不返回意向明细
  return Object.assign(base, {
    // 意向数据（2026-08-28 同步自运营总表）
    reg: normDateStr(r['注册时间']),          // 注册时间 YYYY-MM-DD
    lastLogin: normDateStr(r['最后登陆时间']), // 最后登陆 YYYY-MM-DD
    expire: normDateStr(r['到期时间']),        // 到期时间 YYYY-MM-DD
    zhisuan: Number(r['智算次数'] || 0) || 0,        // 智算次数
    zxLogin: Number(r['智写登录次数'] || 0) || 0,    // 智写登录次数
    zxRemain: Number(r['智写剩余字数'] || 0) || 0,   // 智写剩余字数
    zxUsed: Number(r['智写消耗字数'] || 0) || 0,     // 智写消耗字数
    zxDone: Number(r['智写文章生成次数'] || 0) || 0, // 智写文章生成次数
    zxBuy: Number(r['智写购买字数'] || 0) || 0,      // 智写购买字数
  });
}

// ---------- 结果层（2026-10-08 用户定：SOP 是主轴 + 每个客户都要有个结果）----------
// 结果 8 值（**全部派生、绝不落盘**，红线10）：
//   未开始 / 推进中 / 沉默等需求 / 暂缓(停在「X段」) / 成交签约 / 无法联系 / 推进终止 / 停住·无锚点(兜底黑洞)
// 用户口径：沉默是结果、阶段停住也是结果——但**手动点名**（sales_settle），且停住必须带「复查锚点」；
//   状态已经挂了却没有任何【结论】留痕 = 黑洞「停住·无锚点」，digest/brief 单列，目标清零。
const RESULT_ALL = ['未开始', '推进中', '沉默等需求', '暂缓', '成交签约', '无法联系', '推进终止', '停住·无锚点'];
const RESULT_STOP = Object.assign(Object.create(null), { '沉默等需求': 1, '暂缓': 1, '无法联系': 1, '推进终止': 1, '成交签约': 1 });   // 审计 A13
const STOP_STATUS = Object.assign(Object.create(null), { '挂起': 1, '挂起冷备': 1, '已闭环': 1 });   // 审计 A13
// 【结论】留痕格式（2026-10-08）：沟通内容 = 【结论】<结论>｜停在「<段>」｜锚点：<日期或信号>
function parseConclusion(f) {
  const t = String((f && f['沟通内容']) || '').trim();
  if (!/^【结论】/.test(t)) return null;
  const kind = (t.match(/^【结论】([^｜|]+)/) || [])[1];
  const st = (t.match(/停在「([^」]+)」/) || [])[1];
  const an = (t.match(/锚点[:：]\s*([^｜|]+)/) || [])[1];
  return { kind: kind ? kind.trim() : '', stuckAt: st ? st.trim() : '', anchor: an ? an.trim() : '' };
}
function lastConclusionOf(flowRows, id) {
  const mine = (flowRows || []).filter(f => String(f['客户ID'] || '').trim() === String(id || '').trim()
    && /^【结论】/.test(String(f['沟通内容'] || '').trim()));
  if (!mine.length) return null;
  mine.sort((a, b) => String(a['日期'] || '').localeCompare(String(b['日期'] || '')) || String(a['流水ID'] || '').localeCompare(String(b['流水ID'] || '')));
  const f = mine[mine.length - 1];
  return Object.assign({ flowId: String(f['流水ID'] || '').trim(), date: String(f['日期'] || '').slice(0, 10) }, parseConclusion(f) || {});
}
// 结论是否仍有效：结论之后该客户又有了常规跟进（= 人家又动了）→ 旧结论作废，回到常规派生
function conclusionAlive(flowRows, id, con) {
  if (!con) return false;
  return !(flowRows || []).some(f => String(f['客户ID'] || '').trim() === String(id || '').trim()
    && isFollowRecord(f)
    && (String(f['日期'] || '') > String(con.date || '')
      || (String(f['日期'] || '') === String(con.date || '') && String(f['流水ID'] || '') > String(con.flowId || ''))));
}
/**
 * 一个客户的结果与进度 —— **单一事实源**（pickCust / buildSop / cmdCheck / digest / brief 共用）
 * @param {object} row 主表行
 * @param {Array} [flowRows] 流水行；不传则识别不到【结论】与"是否已有流水"
 * @returns {{result:string, progress:string, anchor:string, stuckAt:string, nextStage:string, hasFlow:boolean, conclusion:object|null, seq:number}}
 */
function sopResultOf(row, flowRows) {
  const stage = normStage(row && row['意向阶段']);
  const status = String((row && row['跟进状态']) || '').trim();
  const id = String((row && row['客户ID']) || '').trim();
  const seq = stageSeq(stage);
  const hasFlow = (flowRows || []).some(f => String(f['客户ID'] || '').trim() === id && isFollowRecord(f));
  const conRaw = lastConclusionOf(flowRows, id);
  const con = conclusionAlive(flowRows, id, conRaw) ? conRaw : null;
  let result, progress = '', anchor = '', stuckAt = '';
  if (stage === '无法联系' || stage === '推进终止') {
    result = stage; progress = '出口·' + stage;
  } else if (stage === '成交签约') {
    result = '成交签约'; progress = '成交';
  } else if (con && RESULT_STOP[con.kind]) {
    // 2026-10-08 审计 A9：原来只认「沉默等需求/暂缓」两种结论 → 「无法联系/推进终止/成交签约」的结论
    //   若主表阶段没被改写（cmdSettle 只在阶段为空时补写、绝不回退），会把成交/出口客户误判成「停住·无锚点」。
    result = con.kind; stuckAt = con.stuckAt || stage; anchor = con.anchor;
    progress = con.kind === '暂缓' ? ('暂缓' + (stuckAt ? '·停在' + stuckAt : ''))
      : con.kind === '沉默等需求' ? ('沉默' + (stuckAt ? '·停在' + stuckAt : ''))
        : con.kind === '成交签约' ? '成交'
          : '出口·' + con.kind;
  } else if (STOP_STATUS[status]) {
    result = '停住·无锚点'; stuckAt = stage;
    progress = (seq ? seq + '/' + STAGE_MAIN.length : (stage || '未标段位')) + '·无锚点';
  } else if (seq >= 2 || (seq === 1 && hasFlow)) {
    // 已进漏斗第二段起，或「线索获取」但已有常规跟进动作 = 在推
    result = '推进中'; progress = seq + '/' + STAGE_MAIN.length;
  } else if (hasFlow) {
    result = '推进中'; progress = '未标段位';
  } else {
    // 线索已进池但从没跟过（含阶段为空）= 未开始（2026-10-08 用户要消灭的桶：每个客户都得走到有结果）
    result = '未开始'; progress = '未开始';
  }
  const nextStage = seq >= 1 && seq < STAGE_MAIN.length ? STAGE_MAIN[seq] : '';
  return { result, progress, anchor, stuckAt, nextStage, hasFlow, conclusion: con, seq };
}

// ---------- 赛道层（2026-10-08 用户总体计划：标品→企业级 双轨 + 培育轨）----------
// 6 轨**全部派生、绝不落盘**（不新增主表枚举/不新增文件）。优先级：出口 > 培育 > 企业级 > 信任期 > 标品漏斗
//   标品漏斗   : 阶段 1-7、还没成交 —— 主体盘子
//   标品信任期 : 标品已成交/已付费、还没进企业级段 —— 用标品建立的信任换企业级机会（用户路线①）
//   企业级直谈 : 阶段≥8 且从没买过标品 —— 直接私有化部署那条路（用户路线②）
//   企业级升级 : 阶段≥8 且买过标品 —— 由标品信任期升级上来的企业级单（客单价最高）
//   培育       : 已点名结论「暂缓」（价值不认可）—— 不催单，按节奏发行业简报/新功能，让他想用 AI 时最先想到我
//   出口       : 无法联系 / 推进终止（终态，不占跟进盘子）
const TRACK_ALL = ['标品漏斗', '标品信任期', '企业级直谈', '企业级升级', '培育', '出口'];
function sopTrackOf(row, flowRows) {
  const stage = normStage(row && row['意向阶段']);
  const seq = stageSeq(stage);
  if (isExitStage(stage)) return '出口';
  if (sopResultOf(row, flowRows).result === '暂缓') return '培育';
  if (seq >= STAGE_ENT_MIN) return isPayer(row) ? '企业级升级' : '企业级直谈';
  if (stage === '成交签约' || isPayer(row)) return '标品信任期';
  return '标品漏斗';
}

// ---------- 客户分类六类（2026-10-13 用户定；顶部导航按它成页、等级随它走）----------
// 六类**完整且互斥**（用户原话「全部客户都要入六类」）：任何一行客户必落一类，六类合计恒等于客户总数。
// 等级梯度（用户定 2026-10-13）：定制开发=SS（最高）> 标品成交=S > 重点跟进=A > 待定跟进=B > 挂起冷备=C（最低）；待首触=未定级。
// 全部**派生现算、绝不落盘**（红线 10）：分类不新增主表枚举、不写缓存文件；等级是分类的投影（写入口自动归一，见 syncLevelFor）。
const BUCKET_ORDER = ['custom', 'standard', 'focus', 'pending', 'cold', 'first'];
const BUCKET_DEF = {
  custom:   { key: 'custom',   label: '定制开发', level: 'SS', note: '企业级轨（阶段≥8）：定制/私有化，单独一条推进过程' },
  standard: { key: 'standard', label: '标品成交', level: 'S',  note: '标品已付费成交：每两周一次服务追踪（转成交后服务 + 续费/复购 + 转介绍）' },
  focus:    { key: 'focus',    label: '重点跟进', level: 'A',  note: '人工挑的重点盘子：**不列入今日任务**，你每天自己看这一页' },
  pending:  { key: 'pending',  label: '待定跟进', level: 'B',  note: '跟进中/挂起：距上次跟进超过一周就再跟一次' },
  cold:     { key: 'cold',     label: '挂起冷备', level: 'C',  note: '已停跟：**不再跟进**（不派活不提醒）；仅新功能上线时人工捞回' },
  first:    { key: 'first',    label: '待首触',   level: '',   note: '还没第一次触达（不定级；触达后由状态决定进哪一类）' },
};
const LEVEL_GRADIENT = { SS: 0, S: 1, A: 2, B: 3, C: 4, '': 5 };
function levelRank(lv) { const r = LEVEL_GRADIENT[String(lv == null ? '' : lv).trim()]; return r === undefined ? 5 : r; }
// 分类判定（顺序即优先级；**只认主表状态/阶段/是否付费**，不读手填等级 → 分类不会被等级污染）
function bucketOf(row, flowRows) {
  if (!row) return 'first';
  const stage = normStage(row['意向阶段']);
  if (stageSeq(stage) >= STAGE_ENT_MIN) return 'custom';       // ① 企业级 6 段 = 定制开发
  if (isPayer(row)) return 'standard';                         // ② 已付费成交（含已闭环的成交客户）
  const st = String(row['跟进状态'] || '').trim();
  if (st === '重点跟进') return 'focus';                       // ③ 人工重点盘
  if (st === '跟进中' || st === '挂起') return 'pending';       // ④ 待定跟进
  if (st === '挂起冷备' || st === '已闭环') return 'cold';      // ⑤ 已停跟（含已结束）
  if (st === '待首触' || st === '') return 'first';            // ⑥ 待首触（不定级）
  // 野状态兜底（绝不让任何客户掉出六类）：出口段 → 挂起冷备；有常规跟进流水 → 待定跟进；否则待首触
  if (isExitStage(stage)) return 'cold';
  const id = String(row['客户ID'] || '').trim();
  const hasFollow = (flowRows || []).some(f => String(f['客户ID'] || '').trim() === id && isFollowRecord(f));
  return hasFollow ? 'pending' : 'first';
}
function bucketDef(row, flowRows) { return BUCKET_DEF[bucketOf(row, flowRows)]; }
function bucketLevelOf(row, flowRows) { return bucketDef(row, flowRows).level; }
// 等级随分类同步（所有写入口统一调用，2026-10-13 用户定）：
//   等级 = 分类的投影 —— 挂起冷备=C / 待定跟进=B / 重点跟进=A / 标品成交=S / 定制开发=SS / 待首触=不定级。
//   返回 {from,to,changed} 供回执与留痕用；只在真正变了的时候写。
function syncLevelFor(row, flowRows) {
  const to = String(bucketLevelOf(row, flowRows) || '');
  const from = String((row && row['客户等级']) || '').trim();
  const changed = !!row && from !== to;
  if (changed) row['客户等级'] = to;
  return { from, to, changed };
}
// 终态（已结束）：状态已闭环 或 落在出口段（无法联系/推进终止）——只在「挂起冷备」页下沉展示，
//   不进今日任务/AI 今日策略的选题池（不复活死单）
function bucketTerminal(row) {
  const st = String((row && row['跟进状态']) || '').trim();
  return st === '已闭环' || isExitStage(normStage(row && row['意向阶段']));
}
// 六类计数（固定顺序，合计 = 客户总数；派生现算）
function bucketCounts(rows, flowRows) {
  const c = {}; BUCKET_ORDER.forEach(k => c[k] = 0);
  (rows || []).forEach(r => { c[bucketOf(r, flowRows)]++; });
  const out = {}; BUCKET_ORDER.forEach(k => out[BUCKET_DEF[k].label] = c[k]);
  return out;
}

// 今日日期（系统真实日期，格式 YYYY-MM-DD）
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ---------- 变更留痕（2026-09-29 用户拍板）----------
// 铁律: **任何客户信息的变化（录入/删除/修改/排期/字段回写）都必须同时落「客户主表」+「跟进流水」**，
//   流水是将来所有分析的数据基础，缺一条就是历史缺口。
// 区分: 留痕记录 = 沟通内容以【…】开头（【建档】【信息变更】【排期变更】【清排期】【删除】），
//   方式留空、类型=数据整理、日期=发生当天；常规跟进记录 = 其余（含沟通内容为空的历史记录）。
// 口径: 触达状态、最后跟进/静默天数、今日清单"已处理"、私享会名单**一律只认 isFollowRecord()**，
//   否则一次"改手机号"就会被当成"今天跟过了"，把客户从今日队列里静默挤掉。
const CHANGE_TAG = /^【[^】]*】/;
// 在册留痕种类（check ⑨ 校验）：2026-10-08 D2 追加「企业级」= 企业级必备信息台账
//   （决策人/预算口/资料权属/安全要求/试点范围），D3 起由 sales_enterprise 写入；D2 先落读取侧。
//   D4 追加「介绍」= 转介绍留痕（介绍人/被介绍人成对），check ⑭ 校验成对性。
const CHANGE_KINDS = Object.assign(Object.create(null), { '建档': 1, '信息变更': 1, '排期变更': 1, '清排期': 1, '删除': 1, '结论': 1, '企业级': 1, '介绍': 1, '合同': 1 });   // 审计 A13；2026-10-15 W1 追加「合同」= 合同台账留痕（check ⑨ 认它）
function isChangeRecord(f) {
  const t = String((f && f['沟通内容']) || '').trim();
  if (CHANGE_TAG.test(t)) return true;                       // 【…】开头 = 留痕（无论类型）
  // 2026-10-08 审计 A7：反向漏洞 —— 「类型=数据整理 且方式留空」但没带【标签的补录/系统留痕
  //   原来被当成常规跟进，会把静默天数重置、还会作废掉已有的【结论】（口径见标准 §14.3）。
  return String((f && f['类型']) || '').trim() === '数据整理' && !String((f && f['方式']) || '').trim();
}
function isFollowRecord(f) { return !isChangeRecord(f); }
// 流水ID防重号: 扫描全表所有流水ID，取最大序号+1（绝不与已有冲突）
function nextFlowId(flowRows) {
  let maxNum = 0;
  (flowRows || []).forEach(r => {
    // 2026-10-08 审计 A14：只认规范的 'L0007'。原来用 /(\d+)/ 抓任意数字，
    //   一条异形ID（如 'L0007-2026' 或 '2026-10-08-1'）会解析出 2026 → 之后所有流水号整段跳号。
    const m = String(r['流水ID'] || '').trim().match(/^L(\d+)$/i);
    if (m) { const n = parseInt(m[1], 10); if (n > maxNum) maxNum = n; }
  });
  return 'L' + String(maxNum + 1).padStart(4, '0');
}
// 追加一条变更留痕流水（只改内存，调用方负责 writeFlow + writeMaster 两表落盘）
function pushChangeFlow(flowRows, id, kind, detail, stage) {
  const row = {
    '流水ID': nextFlowId(flowRows), '客户ID': String(id || '').trim(), '日期': today(),
    '方式': '', '类型': '数据整理',
    '沟通内容': '【' + kind + '】' + String(detail || ''),
    '对方反应': '', '下一步动作': '', '下次跟进时间': '', '下次跟进方式': '',
    '阶段': normStage(stage) || '',
  };
  flowRows.push(row);
  return row;
}
// 主表可回写字段的前后差异（给【信息变更】留痕用：只记真正变了的字段，不把入参原样贴一遍）
const TRACKED_FIELDS = ['公司', '姓名/联系人', '手机', '客户等级', '跟进状态', '触达状态', '下次跟进时间', '下次跟进方式', '微信昵称', '城市', '意向阶段', '到期时间', '注册时间', '备注'];
function masterDiff(before, after) {
  const out = [];
  if (!before || !after) return out;
  TRACKED_FIELDS.forEach(k => {
    const a = String(before[k] == null ? '' : before[k]).trim();
    const b = String(after[k] == null ? '' : after[k]).trim();
    if (a !== b) out.push(k + '：' + (a || '空') + '→' + (b || '空'));
  });
  return out;
}
// 同一把锁内落两表（先流水后主表，与 cmdLog 同序）；失败显式回报半写，绝不假装成功
function writeBoth(m, rows, headers, fl, flowRows, flowHeaders) {
  let flowWritten = false;
  try {
    writeFlow(fl.wb, flowRows, flowHeaders);
    flowWritten = true;
    writeMaster(m.wb, rows, headers, { addDate1904: false });
  } catch (e) {
    return { ok: false, partial: flowWritten, message: `写Excel失败: ${e.message}${flowWritten ? '（流水已写入，主表未回写）' : '（两表都未写，可安全重试）'}` };
  }
  return { ok: true };
}

// ---------- 转介绍留痕（2026-10-08 D4）：【介绍】介绍人=…｜被介绍人=… ----------
// 铁律（用户口径）：转介绍必须**成对**——既写清谁介绍的，也写清介绍给谁；只写一半 = 查不清的账（check ⑭ 记 info）。
//   这是「变更留痕」（isChangeRecord=true）→ 不算触达、不翻今日清单、不影响静默天数；飞轮的转介绍环从它派生。
//   原因（总体计划 b10）：交付/扩展/转介绍**不占阶段**，靠飞轮环管理 → 需要一条能落表、能追溯的转介绍事实。
const REF_TAG = '【介绍】';
function parseReferral(f) {
  const s = String((f && f['沟通内容']) || '').trim();
  if (s.indexOf(REF_TAG) !== 0) return null;
  const body = s.slice(REF_TAG.length);
  const pick = (k) => {
    const m = body.match(new RegExp(k + '\\s*[=:：]\\s*([^｜|]+)'));
    return m ? m[1].trim() : '';
  };
  return { by: pick('介绍人'), to: pick('被介绍人'), raw: s };
}
// 全库转介绍索引（纯派生、只读）：pairs=成对记录 / half=只写一半的 / referrers=谁介绍得多 / inOf=被介绍人←介绍人
function indexReferral(flowRows, rows) {
  const pairs = [], half = [], byCount = {}, inOf = {};
  (flowRows || []).forEach(f => {
    const r = parseReferral(f);
    if (!r) return;
    const item = { flowId: f['流水ID'], id: String(f['客户ID'] || '').trim(), date: String(f['日期'] || '').slice(0, 10), by: r.by, to: r.to };
    if (!r.by || !r.to) { half.push(item); return; }
    pairs.push(item);
    byCount[r.by] = (byCount[r.by] || 0) + 1;
    inOf[r.to] = r.by;
  });
  // 名字/公司/手机 → 在册客户ID（只认在册的，方便追"被介绍人进池了没"）
  const idOf = (name) => {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return '';
    const hit = (rows || []).find(x => [x['客户ID'], x['公司'], x['姓名/联系人'], x['微信昵称'], x['手机']]
      .some(v => String(v || '').trim().toLowerCase() === n));
    return hit ? String(hit['客户ID']).trim() : '';
  };
  pairs.forEach(p => { p.byId = idOf(p.by); p.toId = idOf(p.to); });
  return {
    pairs, half, byCount, inOf, pairCount: pairs.length, halfCount: half.length,
    referrers: Object.keys(byCount).map(k => ({ name: k, count: byCount[k], id: idOf(k) })).sort((a, b) => b.count - a.count),
  };
}
// 写一笔转介绍留痕（挂在该客户名下；不改主表任何字段 → 只落流水表）
function writeReferral(a) {
  a = a || {};
  const by = String(a.by || a.referrer || '').trim();
  const to = String(a.to || a.referred || '').trim();
  if (!by || !to) return { ok: false, message: '转介绍必须成对：介绍人(by) + 被介绍人(to) 都要给（只写一半＝查不清的账）' };
  if (a.date && !isDateStr(a.date)) return { ok: false, message: `日期格式应为 YYYY-MM-DD，收到: ${a.date}` };
  return withWriteLock(() => {
    const m = readMaster();
    const rows = m.rows;
    const key = String(a.id || '').trim();
    const c = key ? rows.find(r => String(r['客户ID']).trim() === key
      || [r['客户ID'], r['公司'], r['姓名/联系人'], r['手机'], r['微信昵称']].join(' ').toLowerCase().includes(key.toLowerCase())) : null;
    if (!c) return { ok: false, message: `转介绍留痕要挂在册客户身上：给被介绍人的客户ID（id=${a.id || '(空)'} 没找到）` };
    const id = String(c['客户ID']).trim();
    const flow = readFlow();
    const date = a.date ? normDateStr(a.date) : today();
    const what = REF_TAG + '介绍人=' + by + '｜被介绍人=' + to + (a.note && String(a.note).trim() ? '｜' + String(a.note).trim() : '');
    const dup = flow.rows.find(f => String(f['客户ID']).trim() === id
      && String(f['日期'] || '').trim() === date && String(f['沟通内容'] || '').trim() === what);
    if (dup) return { ok: true, id, name: c['公司'] || c['姓名/联系人'], flowId: dup['流水ID'], duplicated: true, by, to, message: `该转介绍今天已记过（流水 ${dup['流水ID']}）` };
    const row = {
      '流水ID': nextFlowId(flow.rows), '客户ID': id, '日期': date, '方式': '', '类型': '数据整理',
      '沟通内容': what, '对方反应': '', '下一步动作': '', '下次跟进时间': '', '下次跟进方式': '',
      '阶段': normStage(c['意向阶段']) || '',
    };
    flow.rows.push(row);
    try { writeFlow(flow.wb, flow.rows, flow.headers); } catch (e) { return { ok: false, message: '转介绍留痕写入失败: ' + e.message }; }
    return {
      ok: true, id, name: c['公司'] || c['姓名/联系人'], flowId: row['流水ID'], duplicated: false, by, to,
      message: `已记转介绍：${by} → ${to}（挂在 ${id}）；被介绍人是新客户的话，让他也走建档，两条一对才算清`,
    };
  });
}
// 等级梯度（2026-10-13 用户定：SS 最高、C 最低）—— LV 只作"合法取值"表；排序一律走 levelRank()，
//   未知值给最末位 5（原来的 `LV[x] ?? 4` 会把野值悄悄当成 C 级）。
const LV = { SS:0, S:1, A:2, B:3, C:4, '':5 };
const YX = { '方案报价':0, '签约':1, '试用':2, '已诊断':3, '初步对接':4, '兴趣':5, '':6 };

// ---------- 命令: 今日任务 ----------
// 窗口天数默认7天; 三块: overdue(逾期) / today(=今天到期) / upcoming(未来win天=临期提醒)
// 排序: 等级>日期
function cmdTasks(winDays, slim) {
  const { rows } = readMaster();
  const T = today();
  const win = winDays && winDays > 0 ? winDays : 7;
  const horizon = addDays(T, win);
  const flowRows = readFlow().rows;
  const lastFlowOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim() && isFollowRecord(f))
    .sort((a, b) => String(b['日期'] || '').localeCompare(String(a['日期'] || '')))[0];
  const reasonOf = (r) => {
    const last = lastFlowOf(r['客户ID']);
    return last
      // 2026-09-29 用户定：跟进记录展示只留「日期+跟进内容」；反应/方式/类型/下一步仍在表内，只是不上面板
      ? stamp(last['日期'], String(last['沟通内容'] || '').slice(0, 60))
      : (String(r['备注'] || '').slice(0, 60));
  };
  // 历史跟进记录（该客户最近3条流水，按日期升序展示轨迹，便于判断怎么跟）
  const historyOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim())
    .sort((a, b) => String(a['日期'] || '').localeCompare(String(b['日期'] || '')))
    .slice(-3)
    .map(f => ({ date: f['日期'], method: f['方式'], type: f['类型'], what: f['沟通内容'], react: f['对方反应'], next: f['下一步动作'] }));
  const pick = (r, s) => pickCust(r, s, flowRows);   // 2026-10-08: 带上 flowRows，客户行才有结果(result/progress/anchor)
  const byLevelDate = (a, b) => {
    const la = levelRank(a.level), lb = levelRank(b.level);
    if (la !== lb) return la - lb;
    const na = String(a.next), nb = String(b.next);
    return na < nb ? -1 : na > nb ? 1 : 0;
  };
  const active = (r) => {
    const s = r['跟进状态'];
    return s === '待首触' || s === '跟进中';
  };
  // 逾期(下次<今天)
  // 2026-09-14 (t6/G1): 不再用字符串正则判日期——Excel 序列号会被判成"无日期"而静默掉出三块分区
  const overdue = rows.filter(r => {
    const nx = normDateStr(r['下次跟进时间']);
    if (!nx) return false;
    if (!active(r)) return false;
    return nx < T;
  }).map(r => Object.assign(pick(r, slim), { reason: reasonOf(r), hist: historyOf(r['客户ID']) }));
  // 今日(=今天到期)
  const todayList = rows.filter(r => {
    const nx = normDateStr(r['下次跟进时间']);
    if (nx !== T) return false;
    return active(r);
  }).map(r => Object.assign(pick(r, slim), { hist: historyOf(r['客户ID']) })).sort(byLevelDate);
  // 临期提醒(未来win天内, 不含今天)
  const upcoming = rows.filter(r => {
    const nx = normDateStr(r['下次跟进时间']);
    if (!nx) return false;
    if (!active(r)) return false;
    return nx > T && nx <= horizon;
  }).map(r => pick(r, slim)).sort(byLevelDate);
  // 大更触达(到发布日后持续挂出，直至用户反馈跟进=发布日后有新流水)
  // 2026-09-04: 大更已完成，MAJOR_DATE 设为 2026-09-07(下周一) → 大更客户自下周一起挂出，逐步跟进
  const MAJOR_DATE = '2026-09-07'; // 大更9-4完成，9-7起跟进
  // 2026-09-14 用户: 大更触达已成为过去时 → 整体下线，不再挂出任何大更客户。
  //   历史数据(流水里的"大更后提醒"文字标记)保留在表里不删；开关置 true 即可恢复。
  const MAJOR_ENABLED = false;
  const bigUpdateKw = /大更|发布|版本更新|新产品/;
  const majorIds = new Set(flowRows.filter(f => {
    const t = String(f['沟通内容'] || '') + ' ' + String(f['对方反应'] || '') + ' ' + String(f['下一步动作'] || '');
    return /后提醒|大更后|发布后|更新后/.test(t) && bigUpdateKw.test(t);
  }).map(f => String(f['客户ID']).trim()));
  const major = rows.filter(r => {
    if (!MAJOR_ENABLED) return false;          // 2026-09-14 大更触达已下线
    const id = String(r['客户ID']).trim();
    if (T < MAJOR_DATE) return false;          // 未到发布日不挂
    if (!majorIds.has(id)) return false;       // 非大更客户
    const last = lastFlowOf(id);
    if (last && String(last['日期'] || '') >= MAJOR_DATE) return false; // 已反馈跟进
    return true;
  }).map(r => {
    const id = String(r['客户ID']).trim();
    const last = lastFlowOf(id);
    return Object.assign(pick(r, slim), {
      remind: '🚀 大更触达(9-7起跟进)', note: last ? stamp(last['日期'], String(last['下一步动作'] || last['沟通内容'] || '').slice(0, 80)) : '',
      // 2026-09-10 用户要求: 客户重新出现在今日任务里时，要能看到历史跟进记录+对应日期
      //   （看板走非 slim 完整字段；模型工具走 slim 省 token，不带 hist）
      ...(slim ? {} : { hist: historyOf(id) }),
    });
  }).sort(byLevelDate);
  // ---------- 待定跟进(无排期) 2026-09-14 用户要求：补上缺失机制 ----------
  // 背景: 逾期/今日/临期三块全靠「下次跟进时间」判定，所以"跟进中 + 没定日期" = 三块都不出现，
  //       客户会永久沉底(黑户)；用户不想为此挂起冷备(冷备=等大更/不跟了，语义不符)。
  // 口径: 只收「跟进中」且无有效下次跟进时间(待首触归首访排班管；挂起/闭环本就不跟)。
  // 排序: 等级(ABCS) > 静默天数(距最后一次流水，无流水则用建档日期；越久越前)。
  // 派生现算，不写主表、不落盘(红线10)；定好日期用 log 记一次即自动离开本区。
  const silentDaysOf = (r) => {
    const last = lastFlowOf(r['客户ID']);
    const base = normDateStr((last && last['日期']) || r['建档日期']) || '';
    if (!base) return null;
    const n = dayNum(T) - dayNum(base);   // 2026-09-14 (t6/G1): 纯日历天数差，兼容序列号且不受 DST 影响
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const unscheduled = rows.filter(r => {
    const s = String(r['跟进状态'] || '').trim();
    // 2026-10-19 (用户点名某个已付费代理客户「放入标品成交」) 六分类口径收口：
    //   本区 = 「待定跟进(pending)」桶里没定日子的客户。已付费(S→标品成交)、企业级(SS→定制开发)、
    //   挂起冷备(C)、待首触 一律不进本区——否则同一个客户既挂在「标品成交」页、又被算成「待定」，
    //   两个口径互相打架（实测曾有 9 个已付费客户混进 unscheduledCount）。
    if (bucketOf(r, flowRows) !== 'pending') return false;
    // 2026-09-24 用户定: 「挂起」就是「已接触过但没定下次时间」的正式状态值 → 直接进本区。
    //   旧的「跟进中 + 无排期」口径继续兼容（历史数据/别处写入的仍能落进来，不静默消失）。
    if (s === '挂起') return !normDateStr(r['下次跟进时间']);   // 挂起=没定日子；给了日期就不再"时间不定"（不该同时出现在临期区）
    if (s !== '跟进中') return false;
    return !normDateStr(r['下次跟进时间']);   // 2026-09-14 (t6/G1): 序列号也算"有排期"，不再掉进待定区
  }).map(r => {
    const last = lastFlowOf(r['客户ID']);
    const sd = silentDaysOf(r);
    return Object.assign(pick(r, slim), {
      silentDays: sd,                                       // 静默天数(现算，不落盘)
      stale: sd !== null && sd >= PENDING_STALE_DAYS,       // 静默 >=14 天，该捞一把
      lastDate: last ? String(last['日期'] || '').slice(0, 10) : '',
      ...(slim ? {} : { hist: historyOf(r['客户ID']) }),
    });
  }).sort((a, b) => {
    const la = levelRank(a.level), lb = levelRank(b.level);
    if (la !== lb) return la - lb;
    // 2026-09-14 修复: null(未知静默)按并列处理 → 保证严格弱序（原来两侧都 null 返回 -1，顺序不可复现）
    const sa = (a.silentDays === null || a.silentDays === undefined) ? -1 : a.silentDays;
    const sb = (b.silentDays === null || b.silentDays === undefined) ? -1 : b.silentDays;
    return sb - sa;
  });
  // ---------- 锚点到期（2026-10-08 用户定：做成看板上会自己冒出来的红点）----------
  // 缺口：暂缓/沉默等需求客户的状态是「挂起冷备/挂起」/「已闭环」，而 逾期/今日到期/临期 三块都要求
  //   跟进状态 ∈ 待首触|跟进中 → **带日期锚点的停住客户三块都不显示**；buildQueue 也按审计 P1-1 不给它们发卡。
  // 口径：结论是「停住类」且锚点为 YYYY-MM-DD、距到期 ≤ANCHOR_DUE_DAYS(7) 天（含已过期）→ 本区单列。
  //   已在 逾期/今日到期/临期 出现的人不重复列（那三块本来就看得见）；信号锚点不在此列（靠 brief 盯）。
  //   派生现算，不写主表、不落盘（红线10）；客户按锚点到期先后排，同天按等级。
  const visibleIds = new Set(overdue.concat(todayList, upcoming).map(x => String(x.id || '').trim()));
  const anchorDue = rows.map(r => {
    const id = String(r['客户ID'] || '').trim();
    if (visibleIds.has(id)) return null;
    const rr = sopResultOf(r, flowRows);
    if (!RESULT_STOP[rr.result] || !isDateStr(rr.anchor)) return null;
    const dd = dayDiffStr(rr.anchor, T);
    if (dd === null || dd > ANCHOR_DUE_DAYS) return null;
    const last = lastFlowOf(r['客户ID']);
    return Object.assign(pick(r, slim), {
      result: rr.result, progress: rr.progress, anchor: rr.anchor, stuckAt: rr.stuckAt,
      inDays: dd,                          // >0 = 还有几天到期；<=0 = 已过期
      overdue: dd <= 0,
      lastDate: last ? String(last['日期'] || '').slice(0, 10) : '',
      ...(slim ? {} : { hist: historyOf(r['客户ID']) }),
    });
  }).filter(Boolean).sort((a, b) => (a.inDays - b.inDays) || (levelRank(a.level) - levelRank(b.level)));
  // ---------- 停住没锚点（2026-10-10 用户「接着做」：让看板上的红点真的有东西可亮）----------
  // 缺口：状态已经是 挂起/挂起冷备/已闭环，流水里却既没有【结论】也没有锚点 = 黑洞（"状态挂了却没说为什么"）。
  //   anchorDue 只认"有日期锚点的停住客户"，而库里 0 条【结论】→ 上面那个红点永远不会亮（不是没做，是没素材）。
  // 口径：① 只收**真跟过**的（有常规跟进流水）——从没跟过的导入客资不算黑洞，别把噪音挡在用户前面；
  //   ② 逾期/今日/临期/待定/锚点到期 已经显示的人不重复列；③ 派生现算，不写主表、不落盘（红线10）；
  //   ④ 停得越久越靠前（同天按等级）——他要的是"这些还没结账，给我一句话"。
  const visibleStop = new Set(overdue.concat(todayList, upcoming, unscheduled, anchorDue).map(x => String(x.id || '').trim()));
  // 2026-10-21 用户（m05793）：「生效了吗？为什么还在今日任务里？」
  //   这页原本收的是「状态挂了却没说为什么」的黑洞；但 2026-10-19 口径已定：挂起冷备/已闭环 = **不再跟进**
  //   （不派活、不提醒、不占首触配额）。它们停在哪个阶段、有没有留【结论】，是**数据卫生**问题，
  //   不能当成"今天要处理的黑洞"压在今日任务上、还点亮看板红点。→ cold 一律不进 stopNoAnchor，
  //   另给 coldNoAnchorCount 让账面上看得见（现算、不落盘，红线10）。
  const coldNoAnchorIds = [];
  const stopNoAnchor = rows.map(r => {
    const id = String(r['客户ID'] || '').trim();
    if (visibleStop.has(id)) return null;
    const rr = sopResultOf(r, flowRows);
    if (rr.result !== '停住·无锚点') return null;
    const last = lastFlowOf(id);
    if (!last) return null;                                   // 从没跟过 = 导入客资，不算黑洞
    // 判据用**状态**而不是分类：付费过的冷备会被 bucketOf 归到「标品成交」（钱的事优先），
    //   但状态一样是挂起冷备 = 不再跟进，照样不该被当黑洞催。
    const st = String(r['跟进状态'] || '').trim();
    if (st === '挂起冷备' || st === '已闭环') {
      // 单列留痕（不带 hist，免得体量翻倍）：账面上能查"这些冷备没留结论"，但不催、不点亮红点
      coldNoAnchorIds.push({
        id, name: String(r['公司'] || r['姓名/联系人'] || ''), status: st, stuckAt: rr.stuckAt || '',
        silentDays: silentDaysOf(r), lastDate: String(last['日期'] || '').slice(0, 10),
      });
      return null;
    }
    return Object.assign(pick(r, slim), {
      result: rr.result, progress: rr.progress, stuckAt: rr.stuckAt,
      status: String(r['跟进状态'] || '').trim(),
      silentDays: silentDaysOf(r),                          // 与"待定跟进"同口径：距最后一条流水的天数（现算）
      lastDate: String(last['日期'] || '').slice(0, 10),
      ...(slim ? {} : { hist: historyOf(id) }),
    });
  }).filter(Boolean).sort((a, b) => ((b.silentDays ?? -1) - (a.silentDays ?? -1)) || (levelRank(a.level) - levelRank(b.level)));
  // 六类选题池（2026-10-13 用户定）：今日任务里的选题**从这六类里选**；上面动作块已列出的人不重复列。
  const buckets = bucketPools(rows, flowRows, T, { per: 10, excludeIds: visibleStop });
  return { date: T, today: todayList, windowDays: win, horizon, overdueCount: overdue.length, overdue, upcoming, upcomingCount: upcoming.length, major, majorCount: major.length, unscheduledCount: unscheduled.length, pendingStaleDays: PENDING_STALE_DAYS, unscheduled, anchorDueDays: ANCHOR_DUE_DAYS, anchorDueCount: anchorDue.length, anchorDue, stopNoAnchorCount: stopNoAnchor.length, stopNoAnchor, coldNoAnchorCount: coldNoAnchorIds.length, coldNoAnchor: coldNoAnchorIds, buckets };
}
// ---------- 命令: 大更提醒 ----------
// 版本大更(发布定在本周五)后需要重新触达的客户；来自流水里明确标注"大更/发布后提醒"的决策记录
function cmdRemind() {
  // 2026-09-14 用户: 大更触达已成为过去时 → 下线，恒定返回空名单(原逻辑保留在下方，置 true 可恢复)
  const MAJOR_ENABLED = false;
  if (!MAJOR_ENABLED) return { remindDate: '', remindLabel: '大更触达已下线(2026-09-14)', count: 0, list: [] };
  const { rows } = readMaster();
  const flowRows = readFlow().rows;
  // 2026-09-04: 大更已完成，remindDate 改为 '2026-09-07'，文案同步
  const bigUpdateKw = /大更|发布|版本更新|新产品/;
  const remindFlow = flowRows.filter(f => {
    const t = String(f['沟通内容'] || '') + ' ' + String(f['对方反应'] || '') + ' ' + String(f['下一步动作'] || '');
    return /后提醒|大更后|发布后|更新后/.test(t) && bigUpdateKw.test(t);
  });
  const ids = [...new Set(remindFlow.map(f => String(f['客户ID']).trim()))];
  const out = ids.map(id => {
    const r = rows.find(x => String(x['客户ID']).trim() === id);
    const last = flowRows
      .filter(f => String(f['客户ID']).trim() === id)
      .sort((a, b) => String(b['日期'] || '').localeCompare(String(a['日期'] || '')))[0];
    return {
      id, name: r ? (r['公司'] || r['姓名/联系人']) : id, contact: r ? r['姓名/联系人'] : '',
      phone: r ? r['手机'] : '', level: r ? (r['客户等级'] || '未定级') : '未定级',
      status: r ? r['跟进状态'] : '', next: r ? r['下次跟进时间'] : '',
      remind: '大更后提醒(9-7起跟进)', note: last ? stamp(last['日期'], String(last['下一步动作'] || last['沟通内容'] || '').slice(0, 80)) : '',
    };
  });
  return { remindDate: '2026-09-07', remindLabel: '大更9-4已完成，9-7(下周一)起跟进触达', count: out.length, list: out };
}
// ---------- 命令: 首次回访排班 ----------
// 目标: 每日10个未触达客户，用户电话触达；打完用 sales_log(type=首触) 记录 -> 进流水表 -> 自动移出池
// 未触达定义(用户2026-08-24拍板): 凡是在流水表里没有任何跟进记录的客户，都算未触达(不只看官网注册)
// ---------- 命令: 首次回访排班 ----------
// 目标: 每日10个未触达客户，用户电话触达；打完用 sales_log(type=首触) 记录 -> 进流水表 -> 自动移出池
// 未触达定义(用户2026-08-24拍板): 凡是在流水表里没有任何跟进记录的客户，都算未触达(不只看官网注册)
// 2026-10-08 审计 A20：原「4维质量排序」（qualityKey/cmpQualityDesc/cmpHitsQuality → cmpPriority）
//   整链**没有任何调用方**，且里面用的正是两个被禁用维度（最后登陆时间 / 智写登录次数）→ 已整链删除。
//   现在首访排序只有一条口径：buildActionCard 的行动分（ACTION_WEIGHTS）+ 首触保底配额；
//   ruleHits 只剩展示用途（「命中 N 条」那行），不参与排序。
// 日期串 -> Excel序列(1900制)
// 2026-09-14 修复: 统一走 parseDate 兼容 Excel 序列号 / YYYY-MM-DD / YYYY/MM/DD / Date 对象
// 2026-09-14 (t6/G1 加固): 用 UTC 计算天数差 + Math.round，消除本地时区/DST 造成的 off-by-one
//   （修复前 1991-04-15、1991-09-15 等 DST 日与部分跨年组合的序列号会差 1，是同一类静默失效来源）
function dateToSerial(s) {
  let y, mo, d;
  if (s instanceof Date && !isNaN(s.getTime())) {
    // Date 对象：按本地日历日（读的人看到的就是本地日历）
    y = s.getFullYear(); mo = s.getMonth(); d = s.getDate();
  } else {
    // 字符串 / Excel 序列号：parseDate 已按 UTC 构造，取 UTC 日历日
    const dt = parseDate(s);
    if (!dt) return NaN;
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth(); d = dt.getUTCDate();
  }
  return Math.round((Date.UTC(y, mo, d) - SERIAL_EPOCH) / 86400000);
}
// 首次回访筛选命中(用户2026-08-24拍板，命中至少1条才推送，命中越多意向越高)
// 2026-09-29 用户定：**摘掉原第4条「近5天有登陆」**——最后登陆时间半个月才更新一次，用它筛选必然误判。
//   整个「最后登陆时间」维度已从行动引擎剔除（见行动引擎铁律①）。
// 2026-10-08 审计 A6：**摘掉第3条「智写登录次数>4」**。它是被明确禁用的维度（见下方行动引擎铁律：
//   `最后登陆时间` / `智写登录次数` 不得参与任何判定与话术），却仍活在 ruleHits 里影响首访名单与提示词命中数
//   —— 同一份标准里"禁用"和"在用"并存，就是单一事实源破裂。现在只管两个**可验证**的信号。
function ruleHits(c, todaySerial) {
  let h = 0;
  if (Number(c['智写消耗字数'] || 0) > 0) h++;               // 真的用过（有字数消耗）
  if (String(c['是否购买'] || '').trim() === '是') h++;      // 真的付过费
  return h;
}
// 2026-10-08 审计 A20：原 cmpHitsQuality（命中条数 > 4维质量 > 建档日期）随 qualityKey 一并删除。
// 2026-09-14 用户调整(首次回访机制): 未触达客户按优先级推送。
//   2026-10-22 复核：原「三层优先级 P2/P1/P0」（priorityRank/priorityReason）**从未被调用过**，
//   真正排序的是 buildActionCard 的行动分（见 cmdFirstCall 的 cand.sort）。已删除死代码，
//   「最近活跃」改为并进行动分（见 recentActiveOf / ACTION_WEIGHTS.recentActive）。
//   仅保留当年那两条落地事实（它们是真的、且由行动分实现）：
//     ① 有信号的客户即使 ruleHits=0 也进池；② 行动分高的可以插队到顺延客户前面。
const HOT_DAYS = 7;
// 待定跟进(无排期)静默阈值: 距最后一次流水/建档 >=14 天算「该捞一把」(2026-09-14 用户定)
const PENDING_STALE_DAYS = 14;
// 锚点到期提前量(2026-10-08 用户定: 「看板上会自己冒出来的红点」)：
//   结论「停住类」的复查锚点是日期时，到期前 7 天起就在看板单列（含已过期）；与 brief 飞轮①同窗口。
const ANCHOR_DUE_DAYS = 7;
function isPayer(c) {
  if (String(c['是否购买'] || '').trim() === '是') return true;
  return Number(c['付款总额'] || 0) > 0;
}
// 2026-09-14 用户定稿: 优先级两层
//   P2(最高) = 最后登陆时间 或 注册时间 距今 <=7 天 —— 最近活跃/刚注册，排在付费前面
//              (用户: 建档日期就是注册日期，两者同维，合并成一项)
//   P1       = 有付款(是否购买=是 或 付款总额>0)
//   P0       = 普通(仍可靠命中>=1进池)
// 2026-10-22 复核（修一处长期假象，必读）：上面这套 P2/P1/P0 写在 priorityRank / priorityReason 里，
//   **这两个函数从来没有任何调用方**——2026-09-29 行动引擎落地后，清单排序只认 buildActionCard 的 score
//   （见 cmdFirstCall 的 cand.sort → cardById.score）。也就是说：过去两年写的「最后登陆 ≤7 天会排前面」**根本没生效**，
//   文档与注释却一直当它生效（用户 2026-10-22 追问「最近活跃不就是最后登陆 + 有没有用智写吗」时才发现）。
//   处置：死代码删除，概念并进行动分 —— `recentActiveOf(r, ctx)` + buildActionCard 里的 recentActive 加分。
function byDateWithin(c, ts, keys) {
  for (const k of keys) {
    const s = c[k];
    if (s === '' || s === null || s === undefined) continue;
    const n = dateToSerial(s); // 2026-09-14: 兼容 Excel 序列号 / YYYY-MM-DD
    if (Number.isFinite(n) && n >= ts - HOT_DAYS) return true;
  }
  return false;
}
// 最近活跃（用户 2026-10-22 定，m00636）＝ 两个维度取或：
//   ① byDate：最后登陆时间 / 注册时间 / 建档日期 距今 ≤ HOT_DAYS（有没有人影）；
//   ② byUse ：**这一期有智写消耗增量**（快照差 dCost>0；快照过期 stale 时一律不算，不做“可能用过”的推断）。
// 智算没有逐次留痕（主表只有累计次数），故不进活跃判定，只做事实展示。
// 口径来源：爹原话「最近活跃的其中一个维度不就是最后登录时间和有没有用智写吗」。
function recentActiveOf(r, ctx) {
  const byDate = byDateWithin(r, dateToSerial(ctx.T), ['最后登陆时间', '注册时间', '建档日期']);
  const d = (ctx.diff || {})[String(r['客户ID'] || '').trim()] || null;
  const byUse = !!(d && !ctx.stale && Number.isFinite(d.dCost) && d.dCost > 0);
  return { byDate, byUse, on: byDate || byUse };
}
// 2026-10-08 审计 A20：cmpPriority 也是死代码（无调用方），随 qualityKey 一并删除。
// 顺延规则(用户2026-08-24拍板): 当日没反馈的自动顺延到下一日，直至反馈——名单=排期<=今天且未进流水的全部客户；
//   顺延不足10个才从未触达池补排到今天(保证每天至少10个在挂)；反馈后(进流水)自动移出
// 2026-08-28 重构(用户"每日任务"铁律): 当天清单固定，处理一个少一个、当天不补新——刷新不会永远显示10个，
//   全处理完即"今日完成"；次日才生成新清单 = 昨天未处理(顺延rollover) + 补新凑10(昨天全清则全新10个)。
//   实现: 首访任务清单.json 持久化 {date, list:[{id,scheduled,rollover}]}，当天只读不补。
// 2026-10-22 复核：上面这套「三层优先级」的落地函数 priorityRank/priorityReason 当年**从未被调用**，
//   真正排序是 buildActionCard 的行动分；「最近活跃」已作 ACTION_WEIGHTS.recentActive 并进行动分。
const FIRSTCALL_STATE = path.join(DIR, '首访任务清单.json');
function cmdFirstCall() {
  const T = today();
  const todaySerial = dateToSerial(T);
  const DAILY = 25;              // 电话清单每日总量上限（用户 2026-09-29 定："总共不超过 25 个即可"）
  const FIRST_TOUCH_QUOTA = 10;  // 其中给「首次触达」**保底 10 条**（未触达新线索不能被老客户挤掉）
  // 2026-09-29 用户定（行动引擎）：「今日清单」的选人逻辑从"纯未触达池"升级为**全量行动队列 top N**。
  //   固定清单铁律不变：当天清单固定、处理一个少一个（改为 done 标记、不删条目）、当天不补新、次日顺延。
  const ctx = buildActionContext();
  const rows = ctx.rows;
  // 「已处理」= **在该客户进入清单那天(含)之后有过流水** —— 这才是"这条还用不用打"的正确口径。
  //   2026-09-29 修：原来用 `flowed`（历史上任何流水）判 done/顺延，队列升级成"含老客户"后，
  //   老客户会被整条误标已完成（重排当天实测 10/10 全被误标、待打=0）。
  const flowSeqOf = (f) => { const m = String(f['流水ID'] || '').match(/(\d+)/); return m ? Number(m[1]) : 0; };
  const flowSeqMax = ctx.flowRows.reduce((m, f) => { const s = flowSeqOf(f); return s > m ? s : m; }, 0);
  const flowDatesOf = new Map();     // 客户ID → [有日期的跟进流水日期]
  const undatedSeqsOf = new Map();   // 客户ID → [日期为空的跟进流水序号]（写入先后靠这个认，见下面 handled 的注释）
  ctx.flowRows.forEach(f => {
    if (!isFollowRecord(f)) return;          // 2026-09-29: 【…】变更留痕 ≠ 今天跟过了，不得把客户挤出今日清单
    const id = String(f['客户ID'] || '').trim(), d = String(f['日期'] || '').slice(0, 10);
    if (!id) return;
    if (!d) {
      // 2026-10-22 用户 m00915：「跟进记录已落库，条目还在今日任务里」。
      //   根因：用户 2026-09-29 定「没明确给日期就留空、不默认今天」，于是**今天刚写的跟进也可能没有日期**；
      //   原实现把空日期流水直接丢弃 → done 判不出来 → 客户一直卡在今日任务里（实测 L1113@C-长春-2608-001）。
      //   空日期只有写入先后可认，所以先收序号，等清单状态读出来再按「清单创建时的最大流水ID」分界（见 handled）。
      if (!undatedSeqsOf.has(id)) undatedSeqsOf.set(id, []);
      undatedSeqsOf.get(id).push(flowSeqOf(f));
      return;
    }
    if (!flowDatesOf.has(id)) flowDatesOf.set(id, []);
    flowDatesOf.get(id).push(d);
  });
  const handledSince = (id, since) => {
    const ds = flowDatesOf.get(String(id).trim());
    if (!ds || !ds.length) return false;
    const s = String(since || '').slice(0, 10);
    if (!s) return true;                  // 清单里没记日期 → 保守当已处理，别重复推
    return ds.some(d => d >= s);
  };
  // 「清单创建时的最大流水ID」= 分界线：流水ID 单调递增，**序号大于它**的空日期跟进流水 = 清单建好之后写的 → 清单期内真跟过。
  //   小于等于它的空日期流水 = 老历史（录入时没填日期），一律不计 —— 否则那 13 个客户会一进清单就被永久当成"已处理"。
  //   新清单创建时把这个数写进 首访任务清单.json 的 flowSeq；老清单没有该字段 → 现算等价分界（清单日之前所有**有日期**流水的最大ID）。
  const flowSeqAnchorOf = (stateObj) => {
    const stored = Number((stateObj || {}).flowSeq);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const since = String((stateObj || {}).date || T).slice(0, 10);
    return ctx.flowRows.reduce((m, f) => {
      const d = String(f['日期'] || '').slice(0, 10);
      if (!d || d >= since) return m;
      const s = flowSeqOf(f);
      return s > m ? s : m;
    }, 0);
  };
  let flowSeqAnchor = 0;             // 读清单状态后赋值（见下面 state = stRead 之后）
  const undatedHandled = (id) => {
    const arr = undatedSeqsOf.get(String(id).trim());
    return !!arr && arr.some(s => s > flowSeqAnchor);
  };
  // done 的唯一判断口径：清单期内「有日期流水 >= 清单日」或「清单建好之后写过空日期跟进流水」
  const handled = (id, since) => handledSince(id, since) || undatedHandled(id);
  const byId = new Map(rows.map(r => [String(r['客户ID']).trim(), r]));
  const queued = buildQueue(ctx);                                        // 全量行动队列（已按行动分排序）
  const cardById = new Map(queued.map(x => [x.card.id, x.card]));
  const batchQueue = queued.filter(x => x.card.tier === 'T3');            // 长尾：走批量，不占电话额度
  // 「还在池里」= 状态不是终态/静默盘：**挂起冷备/已闭环 = 用户明确不跟了；重点跟进 = 不提醒（他每天自看）**
  //   （2026-09-18 铁律：行动引擎不推翻人工决定；要重新跟就把状态改回来）
  const stillOpen = (r) => {
    if (!r) return false;
    const s = String(r['跟进状态'] || '').trim();
    return s !== '已闭环' && s !== '挂起冷备' && s !== '重点跟进';
  };
  const eligible = (id) => {
    const key = String(id).trim();
    const r = byId.get(key), card = cardById.get(key);
    if (!r || !card) return false;                 // 没有动作卡的（已成交/出口/刚跟过）不进队列
    if (card.tier === 'T3') return false;          // 长尾走批量，不占电话额度
    return stillOpen(r);
  };
  const pool = queued.filter(x => eligible(x.card.id)).map(x => x.r);   // 电话队列池（T1 必打 / T2 该打）
  const inDaily = (it) => !!it && !!it.id && byId.has(String(it.id).trim());

  // 读状态文件（2026-09-14: 坏文件另存 .corrupt-<ts> 留证，且**拒绝重建**——保证「当天清单固定」不被重排）
  let state = { date: '', list: [] };
  const stRead = readJSONState(FIRSTCALL_STATE);
  if (stRead && stRead.__corrupt) {
    return { ok: false, today: T, list: [], scheduledToday: 0, doneToday: 0, allDone: false,
      message: '首访任务清单.json 损坏（已另存 .corrupt-<ts> 留证）。为避免违反「当天清单固定10个」，本次拒绝重建；请确认该文件内容或删除后重试。' };
  }
  if (stRead && typeof stRead === 'object') state = stRead;
  flowSeqAnchor = flowSeqAnchorOf(state);   // 无日期流水的「已处理」分界（见 handled 注释）

  // 生成今日清单（纯函数：只依赖传入的上一份清单，锁内/锁外共用同一份逻辑）
  const planDaily = (prevList) => {
    const carry = (prevList || [])
      .map(it => (it && it.id) ? { id: String(it.id).trim(), scheduled: it.scheduled } : null)
      .filter(x => x && !handled(x.id, x.scheduled) && eligible(x.id))
      .map(x => x.id);
    const carrySet = new Set(carry);
    const fresh = pool.filter(r => !carrySet.has(String(r['客户ID']).trim())).map(r => String(r['客户ID']).trim());
    // 2026-09-29 行动引擎：顺延与补新一起按「行动分」排序（原「优先推送 > 命中 > 质量」）；
    //   同等分数下顺延优先（先还昨天的债）。
    const cand = [
      ...carry.map(id => ({ id, rollover: true })),
      ...fresh.map(id => ({ id, rollover: false })),
    ];
    cand.sort((x, y) => {
      const cx = cardById.get(x.id), cy = cardById.get(y.id);
      const sx = cx ? cx.score : 0, sy = cy ? cy.score : 0;
      if (sx !== sy) return sy - sx;
      if (x.rollover !== y.rollover) return x.rollover ? -1 : 1;
      return 0;
    });
    // 2026-09-29 用户定（首触保底配额）：先取前 10 个「首次触达」，再用剩余名额按分数补老客户。
    //   首触不足 10 个时**不硬凑**，空出的名额照样给老客户（配额是"保底"，不是"独占"）。
    //   背景：老客户（到期/逾期/停滞）分数 150~163，首触只有 30~80 —— 不保底，670 个未触达线索永远排不上。
    const isFirstTouch = (id) => { const c = cardById.get(String(id).trim()); return !!c && c.action === '首触'; };
    const ft = cand.filter(x => isFirstTouch(x.id));
    const rest = cand.filter(x => !isFirstTouch(x.id));
    const ftTake = Math.min(ft.length, FIRST_TOUCH_QUOTA);
    const chosen = ft.slice(0, ftTake).concat(rest.slice(0, Math.max(0, DAILY - ftTake)));
    return chosen.slice(0, DAILY).map(x => ({
      id: x.id,
      scheduled: x.rollover
        ? ((prevList || []).find(z => z && String(z.id).trim() === x.id)?.scheduled || T)
        : T,
      rollover: x.rollover,
      // 2026-10-19 m00409：首触配额是**清单构成**的事实，排清单时就落进状态文件（ft 标记），
      //   之后不再按"当前卡片长什么样"重算 —— 否则客户状态一变（比如改成挂起冷备）配额就会凭空少一条
      ft: isFirstTouch(x.id),
    }));
  };

  // 2026-10-19 用户 m00409：每天**固定 10 个首触客户**，跟一个少一个。
  //   实现方式（关键，别再改成往 list 里塞）：**首触配额单独记在状态文件的 ft 字段**，
  //   绝不往 `list` 里塞条目 —— `list` 的「当天固定、条数恒定、处理一个少一个」是不变量
  //   （selftest 8 段直接拿它断言，塞条目会红）。
  //   规则（四条，缺一不可）：
  //     a) ft = 今天这 10 个首触的 id 列表，**当天定下来就不再换人**（跟一个少一个，不会打完又冒新的）；
  //     b) 已跟的仍留在 ft 里（面板靠 done 计数显示 10→9→8），只从"待打"里消失；
  //     c) 老清单（无 ft 字段）→ 按行动分从首触池补满 10 条并持久化；补不满就如实报 firstTouchShortfall；
  //     d) ft 里的人被改成挂起冷备/闭环 → 直接踢出（不再占名额，也不假装还在跟）。
  const ensureFirstTouch = (stateObj) => {
    const cur = Array.isArray(stateObj && stateObj.ft) ? stateObj.ft.map(x => String(x).trim()).filter(Boolean) : null;
    if (cur) {
      // 已定：只剔除"人没了/已终态/已不开放"的，不补新人（跟一个少一个）
      const keep = cur.filter(id => {
        const r = byId.get(id);
        return !!r && stillOpen(r);
      });
      return { ft: keep, added: 0, shortfall: Math.max(0, FIRST_TOUCH_QUOTA - keep.length) };
    }
    // 首次（或旧版本清单没有 ft）：先认清单里已经排好的首触，不够 10 条再从首触池补
    //   为什么要分两步：planDaily 排清单时本来就给首触留了名额（清单里自带 done 语义，清单是权威）；
    //   只有"当天清单已冻结且一条首触都没有"（老客户的顺延清单）时，才需要从池里补人 → 此时 firstTouch
    //   会是清单之外的 10 条，followUp 仍是清单全部，两者合起来 35 条，这正是用户要的「10 个首触 + 老客户跟进」。
    const listIds = (stateObj && stateObj.list || []).map(it => String(it && it.id || '').trim()).filter(Boolean);
    const picked = [];
    const seen = new Set();
    const push = (id) => {
      if (!id || seen.has(id) || picked.length >= FIRST_TOUCH_QUOTA) return;
      seen.add(id); picked.push(id);
    };
    let inListPick = 0;
    // ① 清单里已经是首触的（且还没跟过、仍开放）——直接认，不换人
    listIds.forEach((id) => {
      const r = byId.get(id), c = cardById.get(id);
      if (!r || !c || c.action !== '首触' || !stillOpen(r) || handled(id, T)) return;
      const before = picked.length;
      push(id);
      if (picked.length > before) inListPick++;
    });
    // ② 清单里凑不满 10 条 → 从首触池补（当天清单冻结成老客户时，这条是唯一出路）
    const cands = pool.filter((r) => {
      const id = String(r['客户ID']).trim();
      if (seen.has(id) || listIds.indexOf(id) >= 0) return false;
      const c = cardById.get(id);
      return !!c && c.action === '首触' && !handled(id, T);
    }).sort((a, b) => (cardById.get(String(b['客户ID']).trim()).score || 0) - (cardById.get(String(a['客户ID']).trim()).score || 0));
    cands.forEach(r => push(String(r['客户ID']).trim()));
    return { ft: picked, added: picked.length - inListPick, shortfall: Math.max(0, FIRST_TOUCH_QUOTA - picked.length), fresh: true };
  };

  let daily; // [{id, scheduled, rollover, ft}]
  let ftIds = [];       // 今天这 10 个首触（与 list 正交，见上面注释）
  let ftAdded = 0, ftShortfall = 0;
  let stateWarn = '';
  if (state.date === T) {
    // 当天：读当天清单**原样保留**；已处理的只标 done（P0-1：同日输出恒定 + 处理一个少一个），不删条目、不补新
    //   2026-10-19：首触配额走**并行的 ft 字段**兜底（不往 list 塞），老清单没有 ft 时补一次并持久化
    daily = (state.list || []).filter(inDaily);
    const ftR = ensureFirstTouch({ list: state.list, ft: state.ft });
    ftIds = ftR.ft; ftAdded = ftR.added; ftShortfall = ftR.shortfall;
    if (ftR.fresh) {
      const w = withWriteLock(() => {
        const s3 = readJSONState(FIRSTCALL_STATE);
        if (!s3 || s3.__corrupt || s3.date !== T) return { persisted: false };
        const ftR2 = ensureFirstTouch({ list: s3.list, ft: s3.ft });
        const recent2 = Object.assign({}, s3.recent || {});
        ftR2.ft.forEach(id => { recent2[id] = T; });
        Object.keys(recent2).forEach(k => { const dd = dayDiffStr(T, recent2[k]); if (dd === null || dd > 60) delete recent2[k]; });
        const okW = atomicWriteJSON({ date: T, list: s3.list || [], recent: recent2, ft: ftR2.ft, flowSeq: Math.max(Number(s3.flowSeq) || 0, flowSeqAnchor) }, FIRSTCALL_STATE);
        return { persisted: okW, ft: ftR2.ft };
      });
      if (w && w.ok === false) stateWarn = '首触配额补齐未持久化（未取得写锁）：' + w.message;
      else if (w && w.persisted === false) stateWarn = '首触配额补齐未持久化（清单当天已固定，次日重排会带上）';
      else if (w && Array.isArray(w.ft)) ftIds = w.ft;
    }
  } else {
    // 2026-09-14 加固: 次日(或首次)必须「锁内 重读→判→写」，否则并发两次各自生成清单、后写覆盖先写
    const roll = withWriteLock(() => {
      const st2 = readJSONState(FIRSTCALL_STATE);
      if (st2 && st2.__corrupt) return { daily: planDaily(state.list), persisted: false, message: '状态文件损坏' };
      const s2 = (st2 && typeof st2 === 'object') ? st2 : { date: '', list: [] };
      if (s2.date === T) return { daily: (s2.list || []).filter(inDaily), persisted: true, reused: true };
      flowSeqAnchor = flowSeqAnchorOf(s2);   // 旧清单也要有分界才判得了空日期流水（见 handled 注释）
      const planned = planDaily(s2.list);
      const ftPlanned = ensureFirstTouch({ list: planned, ft: null }).ft;
      // 冷却记录 recent：记下今天推过谁（7 天内无硬信号则降权，防同批人天天霸榜）；只留 60 天
      const recent = Object.assign({}, (s2 && s2.recent) || {});
      planned.forEach(it => { recent[it.id] = T; });
      ftPlanned.forEach(id => { recent[id] = T; });
      Object.keys(recent).forEach(k => { const dd = dayDiffStr(T, recent[k]); if (dd === null || dd > 60) delete recent[k]; });
      const wrote = atomicWriteJSON({ date: T, list: planned, recent, ft: ftPlanned, flowSeq: flowSeqMax }, FIRSTCALL_STATE);
      return { daily: planned, persisted: wrote, ft: ftPlanned };
    });
    if (roll && roll.ok === false) {
      // 取锁失败：只读生成当次清单、不落盘，并**显式告警**（绝不静默假装成功）
      daily = planDaily(state.list);
      state = { date: T, list: daily };
      ftIds = ensureFirstTouch({ list: daily, ft: null }).ft;
      stateWarn = '未取得写锁（有其他写入进行中），本次清单未持久化：' + roll.message;
    } else {
      daily = roll.daily;
      state = { date: T, list: daily };
      ftIds = Array.isArray(roll.ft) ? roll.ft : ensureFirstTouch({ list: daily, ft: null }).ft;
      if (roll.persisted === false) stateWarn = '首访任务清单.json 写入失败：清单当次可用，但未持久化（下次刷新会重算）';
    }
  }

  const todayList = daily.map((it) => {
    const r = byId.get(String(it.id).trim());
    if (!r) return null;
    const id = String(it.id).trim();
    const card = cardById.get(id) || buildActionCard(r, ctx);
    // 2026-09-29 修（重排当天实测）：`done` = **今天真跟过**，不是"曾经跟过"。
    //   原写法 `flowed.has(id)`（历史上任何流水）会把老客户整条队列标成已完成 →
    //   队列升级成"含老客户"后必然踩到（实测 10/10 全被误标 done、待打=0）。
    const done = handled(id, it.scheduled) || !stillOpen(r);   // 清单期内跟过 / 已挂起闭环 = 这条不用再打
    return {
      id: r['客户ID'], name: r['公司'] || r['姓名/联系人'], contact: r['姓名/联系人'], phone: r['手机'],
      city: r['城市'], level: r['客户等级'] || '未定级', source: r['来源'], status: r['跟进状态'],
      hits: ruleHits(r, todaySerial), scheduled: it.scheduled, rollover: !!it.rollover, done,
      // ★ 行动卡（2026-09-29 用户定：这才是智能化的核心——告诉你打给谁、干什么、为什么是今天）
      tier: card ? card.tier : '', action: card ? card.action : '', why: card ? card.why : '',
      deadline: card ? card.deadline : '', noPhone: card ? !!card.noPhone : false,
      // 客户信息展示数据（2026-08-28；2026-10-22 用户改口径：**客户信息里重点展示最后登陆 + 智写智算使用情况**）。
      //   2026-09-29 曾把「最后登陆时间」从展示里剔除（当时导出表半个月一次，怕误判）；
      //   现在平台导入（2026-10-21 起）每次都带 last 与用量，数据够新，恢复展示。
      //   边界不变：最后登陆/登录次数**只做事实展示**，不参与判定/优先级/话术（标准 13.1）。
      reg: normDateStr(r['注册时间']),
      lastLogin: normDateStr(r['最后登陆时间']),
      expire: normDateStr(r['到期时间']),
      zhisuan: numFrom(r['智算次数']),
      zxRemain: numFrom(r['智写剩余字数']),
      zxUsed: numFrom(r['智写消耗字数']),
      zxDone: numFrom(r['智写文章生成次数']),
      zxBuy: numFrom(r['智写购买字数']),
      delta: ctx.diff[id] || null,
    };
  }).filter(Boolean);

  const doneCount = todayList.filter(x => x.done).length;
  // 2026-09-29 用户定：队列在面板上**分两块**——「首次触达」（未触达新线索，保底 10 条）与「今日跟进」（老客户：到期/逾期/停滞/联售/增购…）
  // 2026-10-19 m00409 改口径：首触那 10 条来自**独立的 ft 配额**（见 ensureFirstTouch），
  //   不再从 list 里"筛"——当天清单已冻结（25 条全是老客户且都打完了）时，list 里筛不出首触，
  //   用户要的「每天 10 个首触」就永远落空。契约变成：
  //     firstTouch = 今天这 10 个首触（每条带 done，跟一个少一个；可能同时也在 list 里）
  //     followUp   = list 里**不属于**首触配额的那些（老客户：到期/逾期/停滞/联售/增购…）
  //     不变式：firstTouch ∩ followUp = ∅，且 followUp ∪ (firstTouch ∩ list) = list
  const ftSet = new Set(ftIds.map(String));
  const ftItems = ftIds.map((rawId) => {
    const id = String(rawId).trim();
    const r = byId.get(id);
    if (!r) return null;
    const card = cardById.get(id) || buildActionCard(r, ctx);
    const it = daily.find(z => String(z.id).trim() === id);
    const done = handled(id, it ? it.scheduled : T) || !stillOpen(r);
    return {
      id: r['客户ID'], name: r['公司'] || r['姓名/联系人'], contact: r['姓名/联系人'], phone: r['手机'],
      city: r['城市'], level: r['客户等级'] || '未定级', source: r['来源'], status: r['跟进状态'],
      hits: ruleHits(r, todaySerial), scheduled: it ? it.scheduled : T, rollover: it ? !!it.rollover : false, done,
      tier: card ? card.tier : 'T1', action: card ? card.action : '首触', why: card ? card.why : '',
      deadline: card ? card.deadline : '今天', noPhone: card ? !!card.noPhone : false,
      reg: normDateStr(r['注册时间']), lastLogin: normDateStr(r['最后登陆时间']), expire: normDateStr(r['到期时间']),
      zhisuan: numFrom(r['智算次数']), zxRemain: numFrom(r['智写剩余字数']), zxUsed: numFrom(r['智写消耗字数']),
      zxDone: numFrom(r['智写文章生成次数']), zxBuy: numFrom(r['智写购买字数']),
      delta: ctx.diff[id] || null,
    };
  }).filter(Boolean);
  const firstTouchList = ftItems;
  const followUpList = todayList.filter(x => !ftSet.has(String(x.id).trim()));
  // 2026-10-19 用户 m00409：首触"跟一个少一个" → 单独给 done/pending 计数（面板据此显示 10 → 9 → 8…）
  const firstTouchDone = firstTouchList.filter(x => x.done).length;
  const firstTouchPending = firstTouchList.length - firstTouchDone;
  return { today: T, daily: DAILY, list: todayList, firstTouch: firstTouchList, followUp: followUpList,
    scheduledToday: todayList.length, pendingToday: todayList.length - doneCount, wrote: 0, warning: stateWarn,
    rolloverCount: todayList.filter(x => x.rollover).length, doneToday: doneCount,
    allDone: todayList.length > 0 && doneCount === todayList.length,
    remaining: Math.max(0, pool.length - (todayList.length - doneCount)), totalPool: pool.length,
    batchCount: batchQueue.length,
    batch: batchQueue.slice(0, 20).map(x => ({ id: x.card.id, name: x.r['公司'] || x.r['姓名/联系人'], phone: x.r['手机'], why: x.card.why, score: x.card.score })),
    batchScript: BATCH_SCRIPT,
    snapshot: snapshotInfo(ctx),
    firstTouchQuota: FIRST_TOUCH_QUOTA,
    firstTouchCount: firstTouchList.length,
    firstTouchDone, firstTouchPending,
    firstTouchShortfall: ftShortfall,
    followUpCount: followUpList.length,
    firstTouchPool: pool.filter(r => { const c = cardById.get(String(r['客户ID']).trim()); return c && c.action === '首触'; }).length,
    cadence: cadenceReport(ctx),
    note: '每日任务铁律（你 2026-09-29 定，2026-10-19 m00409 补）：电话清单每日上限 ' + DAILY + ' 条，其中**首次触达保底 ' + FIRST_TOUCH_QUOTA + ' 条**（未触达新线索不许被老客户挤掉，跟一个少一个）；当天清单固定、处理一个少一个（done 标记）、当天不补新；次日=昨天未处理顺延+补新。**重点跟进不列入本队列**（你每天自己看那一页）；挂起冷备不再跟进；标品成交每 ' + STANDARD_CADENCE_DAYS + ' 天服务追踪；待定跟进超 ' + PENDING_CADENCE_DAYS + ' 天再跟。打完用 sales_log 记录，done 自动翻转' };
}
// ---------- 命令: 今日作战队列（行动引擎对外的统一口径）----------
function cmdPlan() {
  const q = cmdFirstCall();
  const ctx = buildActionContext();
  return Object.assign({}, q, { coverage: actionCoverage(ctx), snapshot: snapshotInfo(ctx), nurture: nurtureInfo(ctx), cadence: cadenceReport(ctx) });
}
// ---------- 命令: AI 每日工作台 sales_brief（2026-10-08 用户定）----------
// 三段固定结构（**不许自吹**：取不到就空着/写"无"，不编）：
//   ① 我已经做完的 = 只从**当天**的变更留痕里取（【结论】/【信息变更】/【建档】/【排期变更】/【清排期】）
//   ② 今天需要你动手的 = buildQueue 的 T1 前 3 条（必做）+ T2 前 5 条（该做），带 why/电话/话术
//   ③ 需要你点头的 1 件 = 黑洞清零 > 未定级批量补 > 快照过期 > 无需决策
// 外加：飞轮观察（锚点到期 / 到期 30·14·7 / 段位停滞 / 用量异常）+ 数据缺口。纯派生，不写盘。
function cmdBrief() {
  const T = today();
  const ctx = buildActionContext();
  const rows = ctx.rows, flowRows = ctx.flowRows;
  const byId = new Map(rows.map(r => [String(r['客户ID'] || '').trim(), r]));
  const nm = (r) => (r && (r['公司'] || r['姓名/联系人'])) || '';
  // ① 今日已办（只认当天变更留痕；今天没记就是空，绝不编"我做了…"）
  const doneToday = flowRows
    .filter(f => isChangeRecord(f) && String(f['日期'] || '').slice(0, 10) === T)
    .map(f => {
      const id = String(f['客户ID'] || '').trim();
      const r = byId.get(id);
      return { id, name: nm(r), flowId: String(f['流水ID'] || '').trim(), what: String(f['沟通内容'] || '') };
    });
  // ② 队列：T1 前 3 必做 + T2 前 5 该做
  const queued = buildQueue(ctx);
  const packTodo = (x, withHow) => {
    const r = x.r, card = x.card;
    const flows = ctx.byCust.get(String(r['客户ID']).trim()) || [];
    const last = flows.length ? flows[flows.length - 1] : null;
    const rr = sopResultOf(r, flowRows);
    const item = {
      tier: card.tier, id: String(r['客户ID']).trim(), name: nm(r), level: r['客户等级'] || '未定级',
      phone: String(r['手机'] || ''), wechat: r['微信昵称'], stage: normStage(r['意向阶段']), result: rr.result,
      action: card.action, why: card.why, deadline: card.deadline, score: card.score,
    };
    if (withHow) item.how = buildHow(card, r, last);
    else item.branch = BRANCH_HINTS[card.action] || [];
    return item;
  };
  const must = queued.filter(x => x.card.tier === 'T1').slice(0, 3).map(x => packTodo(x, true));
  const should = queued.filter(x => x.card.tier === 'T2').slice(0, 5).map(x => packTodo(x, false));
  // ③ 需要点头的 1 件 + 飞轮观察 + 数据缺口
  const results = {}; RESULT_ALL.forEach(k => { results[k] = 0; });
  const stuck = [], stopWithAnchor = [];
  const EXPIRE_BUCKETS = { 7: [], 14: [], 30: [] };
  const stall = [];
  const anomaly = { surge: [], zero: [] };
  rows.forEach(r => {
    const id = String(r['客户ID'] || '').trim();
    const rr = sopResultOf(r, flowRows);
    results[rr.result] = (results[rr.result] || 0) + 1;
    if (rr.result === '停住·无锚点') stuck.push({ id, name: nm(r), stage: rr.stuckAt, status: String(r['跟进状态'] || '') });
    // 飞轮①锚点到期：已点名沉默/暂缓、且锚点是日期且已到期或 7 天内到期 → 该拿出来重新碰
    if (RESULT_STOP[rr.result] && rr.anchor && /^\d{4}-\d{2}-\d{2}$/.test(rr.anchor)) {
      const dd = dayDiffStr(rr.anchor, T);
      if (dd !== null && dd <= 7) stopWithAnchor.push({ id, name: nm(r), result: rr.result, anchor: rr.anchor, inDays: dd });
    }
    // 飞轮②到期 30/14/7（只算还没到终态的）
    const exp = normDateStr(r['到期时间']);
    const st = String(r['跟进状态'] || '').trim();
    if (exp && st !== '已闭环') {
      const left = dayDiffStr(exp, T);
      if (left !== null && left >= 0) {
        if (left <= 7) EXPIRE_BUCKETS[7].push(id);
        if (left <= 14) EXPIRE_BUCKETS[14].push(id);
        if (left <= 30) EXPIRE_BUCKETS[30].push(id);
      }
    }
    // 飞轮③段位停滞：推进中但最近一次常规跟进（或建档）已超 21 天没动
    if (rr.result === '推进中') {
      const fl = (ctx.byCust.get(id) || []);
      const base = fl.length ? String(fl[fl.length - 1]['日期'] || '').slice(0, 10) : (normDateStr(r['建档日期']) || '');
      const dd = base ? dayDiffStr(T, base) : null;
      if (dd !== null && dd > 21) stall.push({ id, name: nm(r), stage: normStage(r['意向阶段']), silentDays: dd });
    }
    // 飞轮④用量异常（只在快照新鲜时判，过期不猜）：本期暴涨 或 归零
    if (!ctx.stale) {
      const d = ctx.diff[id];
      if (d && !d.firstSeen && d.prevCost !== null) {
        if (d.prevCost > 0 && d.dCost >= Math.max(d.prevCost, 1000)) anomaly.surge.push(id);
        else if (d.prevCost > 0 && d.dCost <= 0) anomaly.zero.push(id);
      }
    }
  });
  stall.sort((a, b) => b.silentDays - a.silentDays);
  const nrt = nurtureInfo(ctx);   // 2026-10-08 D2：培育池（结论=暂缓）——到点发轻触达，不占电话额度
  const fw = flywheelReport(rows, flowRows);   // 2026-10-08 D4：飞轮观察（瓶颈环 / 停滞环 / 转介绍账），复用已读上下文不重复读盘
  // 2026-10-19 m00409 四类跟进节奏：重点跟进每天自看（只报断点、不进今日任务）/ 标品成交每两周服务追踪 /
  //   待定跟进超一周再跟 / 挂起冷备不再跟进。复用 ctx，不重复读盘。
  const cad = cadenceReport(ctx);
  // 2026-10-08 D3：赛道盘子 + 企业级候选 + 黑洞清单（黑洞=状态已挂但没有【结论】锚点；每天清 5~10 个）
  const tracks = {}; TRACK_ALL.forEach(k => { tracks[k] = 0; });
  rows.forEach(r => { const k = sopTrackOf(r, flowRows); tracks[k] = (tracks[k] || 0) + 1; });
  const entLists = entCandidateLists(rows, flowRows);
  const blackhole = stuck.map(x => {
    const r = byId.get(x.id);
    const fl = ctx.byCust.get(x.id) || [];
    const base = fl.length ? String(fl[fl.length - 1]['日期'] || '').slice(0, 10) : (r ? (normDateStr(r['建档日期']) || '') : '');
    const silent = base ? dayDiffStr(T, base) : null;
    const paid = r ? numFrom(r['付款总额']) : 0;
    const suggest = x.status === '已闭环' ? (paid > 0 ? '成交签约' : '推进终止') : (silent !== null && silent >= 90 ? '无法联系' : '暂缓');
    return { id: x.id, name: x.name, stage: x.stage, status: x.status, silentDays: silent, suggest };
  }).sort((p, q) => (q.silentDays === null ? -1 : q.silentDays) - (p.silentDays === null ? -1 : p.silentDays));
  const unleveled = rows.filter(r => !String(r['客户等级'] || '').trim()).length;
  const noPhone = rows.filter(r => !String(r['手机'] || '').trim()).length;
  const noStage = rows.filter(r => !normStage(r['意向阶段'])).length;
  let askOne;
  if (stuck.length) {
    askOne = {
      kind: '清黑洞（停住·无锚点）', count: stuck.length, samples: stuck.slice(0, 5),
      suggests: blackhole.slice(0, 5).map(b => ({ id: b.id, suggest: b.suggest, silentDays: b.silentDays })),
      batch: '能批量点名：sales_settle(ids=[...], kind="暂缓", anchor="2026-12-01")——同一批共用一个锚点；要锚点的结论缺 anchor 会被直接拒绝',
      ask: `这 ${stuck.length} 个客户状态已经挂了/闭环了，但没有【结论】留痕说明停在哪、什么时候再拿起。每天点 5~10 个，用 sales_settle 给结论（沉默等需求/暂缓要带锚点；够不着就给无法联系；明确不做给推进终止）。`,
    };
  } else if (entLists.upgrade.length + entLists.direct.length > 0) {
    askOne = {
      kind: '企业级机会确认', count: entLists.upgrade.length + entLists.direct.length,
      samples: entLists.upgrade.slice(0, 3).concat(entLists.direct.slice(0, 2)).map(x => ({ id: x.id, name: x.name, why: x.why })),
      ask: `标品池里有 ${entLists.upgrade.length} 个已经用起来/付过费、${entLists.direct.length} 个机构型或 S·A 级客户——要不要挑几个进企业级轨？用 sales_enterprise 看某个客户"走哪条路 + 下一段三件事 + 带什么材料"，确认后自己点名段位（sales_log 传 stage=企业级机会）。`,
    };
  } else if (unleveled > 0) {
    askOne = {
      kind: '补客户等级', count: unleveled,
      ask: `还有 ${unleveled} 个客户没定级——等级直接决定每天先打谁。用 sales_log 的 level 或 sales_triage 批量建议后点头。`,
    };
  } else if (ctx.stale) {
    askOne = {
      kind: '刷运营快照', count: 1,
      ask: `运营快照过期（${ctx.age === null ? '缺快照' : ctx.age + ' 天'}），用量增量信号（暴涨/归零）已失效，行动分只能吃到期类。导一份新快照。`,
    };
  } else {
    askOne = { kind: '无需决策', count: 0, ask: '今天没有需要你点头的事，按上面的电话清单打就行。' };
  }
  return {
    ok: true, date: T,
    snapshot: snapshotInfo(ctx),
    doneToday, doneCount: doneToday.length,
    todo: { must, should },
    askOne,
    watch: {
      anchorDue: stopWithAnchor.sort((a, b) => a.inDays - b.inDays).slice(0, 8),
      anchorDueCount: stopWithAnchor.length,
      expireIn7: EXPIRE_BUCKETS[7].length, expireIn14: EXPIRE_BUCKETS[14].length, expireIn30: EXPIRE_BUCKETS[30].length,
      stall: stall.slice(0, 5), stallCount: stall.length,
      usageSurge: anomaly.surge.length, usageZero: anomaly.zero.length,
      usageSurgeTop: anomaly.surge.slice(0, 3), usageZeroTop: anomaly.zero.slice(0, 3),
      // 2026-10-08 D2 培育轨：到点该发轻触达的客户（不占电话额度，微信/短信）
      nurtureDue: nrt.due, nurturePool: nrt.pool, nurtureCadenceDays: nrt.cadenceDays, nurtureList: nrt.list,
      // 2026-10-19 m00409 四类跟进节奏（口径唯一来源见 CADENCE_DEF）
      cadence: {
        focusCadenceDays: FOCUS_CADENCE_DAYS, focusMissed: cad.focusCount, focusList: cad.focus.slice(0, 5),
        standardCadenceDays: STANDARD_CADENCE_DAYS, standardDue: cad.standardCount, standardList: cad.standard.slice(0, 5),
        pendingCadenceDays: PENDING_CADENCE_DAYS, pendingDue: cad.pendingCount, pendingList: cad.pending.slice(0, 5),
        coldCadence: 'event', coldRecallMarked: cad.recallMarked,
      },
      // 2026-10-08 D4 飞轮观察：瓶颈环 + 停滞最多的 3 环 + 转介绍账（含只写一半的）
      flywheel: fw ? {
        bottleneck: fw.bottleneck, action: fw.action, after: fw.after.map(x => ({ ring: x.ring, count: x.count })),
        referral: fw.referral, loop: fw.loop,
      } : null,
    },
    gaps: { unleveled, noPhone, noStage, stuckNoAnchor: stuck.length, resultDist: results, notStarted: results['未开始'] || 0, nurturePool: nrt.pool },
    tracks,
    entCandidates: { upgrade: entLists.upgrade.length, direct: entLists.direct.length, samples: entLists.upgrade.slice(0, 5) },
    blackhole: { count: blackhole.length, top: blackhole.slice(0, 10) },
    // 六类选题池（2026-10-13 用户定）：AI 今日策略的选题也从六类里选（每类前 5，终态不进池）
    pool: bucketPools(rows, flowRows, T, { per: 5 }),
    coverage: actionCoverage(ctx),
    // 2026-10-19 m00409：四类跟进节奏总览（与 watch.cadence 同源，别重复算）
    cadence: cad,
  };
}
// ---------- 命令: 单客户作战卡（我下一步该干什么）----------
// 2026-10-12 批次 3：给模型面用的"这户自己的身份字段"——插件侧据此把 姓名/公司/手机/微信 登记成占位符，
//   免得**自由文本**（如"上一次跟进"的沟通内容、规则版草稿）里冒出真名真公司。
//   实测抓到两处真漏点：701 陈默（在规则草稿里）、长春 李维（在上一次跟进的沟通内容里）。
const customerIdentity = (r) => ({
  姓名: (r && r['姓名/联系人']) || '',
  公司: (r && r['公司']) || '',
  手机: (r && r['手机']) || '',
  微信昵称: (r && r['微信昵称']) || '',
});

function cmdNext(idOrKw) {
  const k = String(idOrKw || '').trim();
  if (!k) return { ok: false, message: '缺少客户ID(next id)' };
  const ctx = buildActionContext();
  let c = ctx.rows.find(r => String(r['客户ID']).trim() === k);
  if (!c) {
    const lk = k.toLowerCase();
    c = ctx.rows.find(r => [r['客户ID'], r['公司'], r['姓名/联系人'], r['手机'], r['微信昵称'], r['城市']].join(' ').toLowerCase().includes(lk));
  }
  if (!c) return { ok: false, message: '未找到客户 ' + idOrKw };
  // 2026-09-29 审计修（sale-audit P1-1）：人工终态客户不派活（标准 13.4「绝不自动拉回」）
  const stNext = String(c['跟进状态'] || '').trim();
  // 2026-10-08 D2：培育池（用户点名结论「暂缓」）不派电话，但要给出轻触达卡（到点发简报 / 还有几天到点）
  const nrtNext = nurtureDueOf(c, ctx.flowRows, ctx.T, ctx.touchIdx ? (ctx.touchIdx.get(String(c['客户ID']).trim()) || '') : undefined);
  if (stNext === '已闭环' || (stNext === '挂起冷备' && !nrtNext)) {
    const idT = String(c['客户ID']).trim();
    return {
      ok: true, id: idT, name: c['公司'] || c['姓名/联系人'], level: c['客户等级'] || '未定级',
      stage: normStage(c['意向阶段']), customer: customerIdentity(c), card: null, snapshot: snapshotInfo(ctx),
      message: '该客户是「' + stNext + '」= 人工决定先不跟，行动引擎不主动派活；要重新跟就先把跟进状态改回「跟进中/待首触」',
    };
  }
  const card = buildActionCard(c, ctx);
  const id = String(c['客户ID']).trim();
  const flows = ctx.byCust.get(id) || [];
  const last = flows.length ? flows[flows.length - 1] : null;
  if (!card) {
    return { ok: true, id, name: c['公司'] || c['姓名/联系人'], stage: normStage(c['意向阶段']), customer: customerIdentity(c),
      card: null, message: '这个客户当前没有待办动作（可能刚跟过、有排期，或已到出口/成交）', snapshot: snapshotInfo(ctx) };
  }
  return {
    ok: true, id, name: c['公司'] || c['姓名/联系人'], level: c['客户等级'] || '未定级',
    stage: normStage(c['意向阶段']), stageSeq: stageSeq(c['意向阶段']), customer: customerIdentity(c), phone: c['手机'], wechat: c['微信昵称'],
    next: normDateStr(c['下次跟进时间']), status: c['跟进状态'],
    card,
    how: buildHow(card, c, last),
    branch: BRANCH_HINTS[card.action] || [],
    snapshot: snapshotInfo(ctx),
    lastFlow: last ? { date: last['日期'], type: last['类型'], what: last['沟通内容'], react: last['对方反应'] } : null,
  };
}
// 2026-09-10 用户要求: 每条跟进记录一律带上发生日期(什么时候记的=当天日期)，展示时也带
const shortDate = (d) => {
  const m = String(d || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}-${m[3]}` : '';
};
const stamp = (d, text) => {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const sd = shortDate(d);
  return sd ? `[${sd}] ${t}` : t;   // 已有日期前缀的不重复加
};
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

// ---------- 命令: 私享会邀请类客户 (2026-09-10 用户要求) ----------
// 场景: 天乐徐总这类"暂不按销售节奏跟、等私享会日期定了再拿出来邀请"的客户。
//   不带参数 → 只列名单（打标口径: 主表备注含「私享会」 或 流水里提到「私享会」）
//   带日期   → 一次性给名单里每个客户排上该日期(并自动把挂起冷备拉回跟进中)
function cmdMeeting(dateArg) {
  const { rows } = readMaster();
  const flowRows = readFlow().rows;
  const hitFlow = new Set(flowRows
    .filter(f => isFollowRecord(f) && /私享会/.test(String(f['沟通内容'] || '') + String(f['下一步动作'] || '') + String(f['对方反应'] || '')))
    .map(f => String(f['客户ID']).trim()));
  const isTarget = (r) => /私享会/.test(String(r['备注'] || '')) || hitFlow.has(String(r['客户ID']).trim());
  // 2026-10-10 用户定（「要跳过」）：已闭环/挂起冷备 是用户人工拍的「结束了/先不跟」，
  //   批量排期不许把他偷偷拉回「跟进中」——旧实现一律拉回，会把培育池/冷备客户无声复活
  //   （留下「跟进中 + 存活【结论】暂缓」这种自相矛盾的状态，培育卡还会漏进电话队列）。
  const PARKED = ['挂起冷备', '已闭环'];
  const isParked = (r) => PARKED.includes(String(r['跟进状态'] || '').trim());
  const list = rows.filter(isTarget).map(r => ({
    id: r['客户ID'], name: r['公司'] || r['姓名/联系人'], contact: r['姓名/联系人'], phone: r['手机'],
    level: r['客户等级'] || '未定级', status: r['跟进状态'], next: r['下次跟进时间'], parked: isParked(r),
    note: String(r['备注'] || '').slice(-60),
  }));
  const date = String(dateArg == null ? '' : dateArg).trim();
  if (!date) {
    return { ok: true, count: list.length, dateSet: '', list,
      note: '私享会邀请名单（只列不排期）；带日期调用(YYYY-MM-DD)可一次性排期（已闭环/挂起冷备 标 parked、不动他）' };
  }
  if (!isDateStr(date)) return { ok: false, message: `日期格式应为 YYYY-MM-DD，收到: ${date}` };
  let skipped = 0;
  const updated = withWriteLock(() => {
    const m = readMaster();
    // 2026-09-14 加固: 选择集在锁内重算（原实现用锁外快照，会覆盖别人刚改的新排期）
    const idsNow = new Set(m.rows.filter(r => /私享会/.test(String(r['备注'] || '')) || hitFlow.has(String(r['客户ID']).trim())).map(r => String(r['客户ID']).trim()));
    let n = 0;
    // 2026-09-29 用户定（两表留痕）: 批量改排期也是客户信息变化 → 每个人一条【排期变更】流水
    const fl = readFlow();
    for (const r of m.rows) {
      if (!idsNow.has(String(r['客户ID']).trim())) continue;
      if (isParked(r)) { skipped++; continue; }
      const from = normDateStr(r['下次跟进时间']);
      r['下次跟进时间'] = date;
      r['下次跟进方式'] = '微信';
      // 2026-10-13 批次5 审计 F7：状态被拉回也算客户信息变化 → 必须进留痕（原来只记排期，
      //   事后只能看到"排期被改"，看不到"状态从挂起被拉回跟进中"）
      const stFrom = String(r['跟进状态'] || '').trim();
      if (['挂起', '挂起冷备'].includes(stFrom)) r['跟进状态'] = '跟进中';
      const stNow = String(r['跟进状态'] || '').trim();
      const stNote = stFrom !== stNow ? `、状态 ${stFrom || '空'}→${stNow}` : '';
      pushChangeFlow(fl.rows, r['客户ID'], '排期变更', `批量排期到 ${date}${from ? '（原排期 ' + from + '）' : ''}${stNote}`, r['意向阶段']);
      n++;
    }
    if (n) {
      const w = writeBoth(m, m.rows, m.headers, fl, fl.rows, fl.headers);
      if (w.ok === false) return w;
    }
    return n;
  });
  if (updated && updated.ok === false) return { ok: false, message: '排期失败: ' + updated.message + '（未改任何数据，可重试）' };
  return { ok: true, count: list.length, dateSet: date, updated, skipped, list,
    note: `已把 ${updated} 个私享会邀请客户排到 ${date}${skipped ? `（跳过 ${skipped} 个挂起冷备/已闭环：状态、排期都没动）` : ''}` };
}

// ---------- 命令: 清空挂起/已闭环客户的过期残留排期 (2026-09-10 用户要求) ----------
// 背景: 挂起冷备/已闭环的客户不再进待办，但主表可能残留旧的"下次跟进时间"，
//   会让用户误以为"刚跟过怎么又到期了"。
// 口径(2026-09-10 修正): 只清「已经过期/到期」的残留日期(<=今天)；
//   未来的日期(如荣亚尔"9-30前不再主动触达")是有意安排，必须保留。
function cmdSweep() {
  // 2026-09-24 用户定: 「挂起」也是"不跟了/没定日子"，同样不该残留过期排期
  const STATUSES = ['挂起', '挂起冷备', '已闭环'];
  const T = today();
  const before = readMaster().rows
    .filter(r => STATUSES.includes(String(r['跟进状态'] || '').trim()))
    .filter(r => {
      const nx = normDateStr(r['下次跟进时间']);   // 2026-09-14 (t6/G1): 兼容序列号，别再按字符串判
      return nx && nx <= T;   // 只清过期/到期的
    })
    .map(r => ({ id: r['客户ID'], name: r['公司'] || r['姓名/联系人'], status: r['跟进状态'], next: r['下次跟进时间'] }));
  if (!before.length) return { ok: true, cleared: 0, list: [], message: '没有需要清理的过期排期' };
  // 2026-09-14 加固: 锁内重算选择集(不按锁外 ID 快照清)，并显式处理取锁失败
  const cleared = withWriteLock(() => {
    const m = readMaster();
    let n = 0;
    // 2026-09-29 用户定（两表留痕）: 清空排期同样是客户信息变化 → 每个被清的客户一条【清排期】流水
    const fl = readFlow();
    for (const r of m.rows) {
      if (!STATUSES.includes(String(r['跟进状态'] || '').trim())) continue;
      const nx = normDateStr(r['下次跟进时间']);
      if (!nx || nx > T) continue;             // 只清过期/到期的，未来排期保留
      r['下次跟进时间'] = '';
      r['下次跟进方式'] = '';
      pushChangeFlow(fl.rows, r['客户ID'], '清排期', `清空过期排期 ${nx}（状态 ${String(r['跟进状态'] || '').trim()}）`, r['意向阶段']);
      n++;
    }
    if (n) {
      const w = writeBoth(m, m.rows, m.headers, fl, fl.rows, fl.headers);
      if (w.ok === false) return w;
    }
    return n;
  });
  if (cleared && cleared.ok === false) return { ok: false, message: '清空失败: ' + cleared.message + '（未改任何数据，可重试）' };
  return { ok: true, cleared, list: before, message: `已清空 ${cleared} 个挂起/已闭环客户的过期排期(未来日期保留)` };
}

// ---------- 命令: 挂起冷备名单 (2026-09-24 用户要求：面板独立成一页) ----------
// 「挂起冷备」= 暂时不考虑跟进了（与「挂起」= 已接触过但没定日子 明确分开）。
// 只读、现算、不落盘；按 等级 > 静默天数 排序，带 hist 让用户能回看"当初为什么冷备它"。
// 注: 下面两个小工具与 cmdTasks 同口径（刻意重复 6 行，不动已经稳定的 cmdTasks 闭包）。
function cmdCold() {
  const { rows } = readMaster();
  const T = today();
  const flowRows = readFlow().rows;
  const lastFlowOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim() && isFollowRecord(f))
    .sort((a, b) => String(b['日期'] || '').localeCompare(String(a['日期'] || '')))[0];
  const historyOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim())
    .sort((a, b) => String(a['日期'] || '').localeCompare(String(b['日期'] || '')))
    .slice(-3)
    .map(f => ({ date: String(f['日期'] || '').slice(0, 10), method: f['方式'], type: f['类型'], what: String(f['沟通内容'] || ''), react: String(f['对方反应'] || ''), next: String(f['下一步动作'] || '') }));
  const silentDaysOf = (r) => {
    const last = lastFlowOf(r['客户ID']);
    const base = normDateStr((last && last['日期']) || r['建档日期']) || '';
    if (!base) return null;
    const n = dayNum(T) - dayNum(base);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  // 2026-10-13 用户定（「全部客户都要入六类」）：挂起冷备 = 已停跟池 = bucketOf()==='cold'，
  //   含两段：① 暂时不跟（可捞回）；② 已结束（已闭环 / 出口）。已结束的只在页面下沉区展示，不进今日任务/AI 选题。
  const list = rows.filter(r => bucketOf(r, flowRows) === 'cold').map(r => {
    const last = lastFlowOf(r['客户ID']);
    const sd = silentDaysOf(r);
    return Object.assign(pickCust(r, false, flowRows), {
      silentDays: sd,
      lastDate: last ? String(last['日期'] || '').slice(0, 10) : '',
      reason: last ? stamp(last['日期'], String(last['沟通内容'] || '').slice(0, 60)) : '',   // 2026-09-29: 统一为「日期+跟进内容」
      hist: historyOf(r['客户ID']),
      terminal: bucketTerminal(r),          // 已结束（已闭环/出口）→ 页面下沉区，不进选题池
    });
  }).sort((a, b) => {
    const la = levelRank(a.level), lb = levelRank(b.level);
    if (la !== lb) return la - lb;
    const sa = (a.silentDays === null || a.silentDays === undefined) ? -1 : a.silentDays;
    const sb = (b.silentDays === null || b.silentDays === undefined) ? -1 : b.silentDays;
    return sb - sa;
  });
  const active = list.filter(x => !x.terminal);
  const ended = list.filter(x => x.terminal);
  // 2026-10-19 用户 m00409：「挂起冷备：不再跟进」→ 这一池**永不派活、永不提醒**；
  //   只有带 ★/大更/新功能/捞回 备注的，等用户点名「新功能上线」才人工捞回（这里只计数，不自动挂出）。
  const RECALL_RE = RECALL_MARK_RE;   // 与 cadenceReport 共用同一个正则，口径不许分叉
  active.forEach(x => {
    const src = rows.find(r => String(r['客户ID']).trim() === String(x.id).trim()) || {};
    x.recallMarked = RECALL_RE.test(String(src['备注'] || ''));
    x.followUp = false;              // 不再跟进：任何队列/提醒都不许把这一类拉出来
  });
  const withRecall = active.filter(x => x.recallMarked).length;
  return { ok: true, date: T, count: list.length, bucket: 'cold', bucketLabel: BUCKET_DEF.cold.label, level: BUCKET_DEF.cold.level,
    activeCount: active.length, endedCount: ended.length, active, ended, recallMarked: withRecall, list,
    cadenceDays: 0, followUp: false,
    note: '挂起冷备=C 级：**不再跟进**（不派活、不提醒、不进今日任务）。上面是"暂时不跟（可捞回）"，下面是"已结束（已闭环/出口，不复活）"；带 ★ 捞回标记的（' + withRecall + ' 个）只在你点名「新功能上线」时人工捞回，引擎不会自动挂出' };
}
// ---------- 命令: 重点跟进名单（2026-09-29 用户定；2026-10-19 m00409 改口径）----------
// 用户原话（2026-09-29）：「待定跟进 和 挂起冷备之间，增加'重点跟进'。重点跟进的客户不再提醒跟进，我每天都会看。」
// 用户原话（2026-10-19 m00409）：「重点跟进：不用列入今日任务，我每天都会看。」
// 口径（现行）：**人工挑选的重点盘子** —— 不进今日任务、不进电话队列、不进逾期/到期提醒，
//   单独一页由用户每天自己看；页面给 doneToday/missedToday 断点（今天跟了几个、还剩几个），跟一个少一个。
//   移入/移出都由用户点名，走 sales_log 改 status（type=数据整理，留一条痕迹）。
function cmdFocus() {
  const { rows } = readMaster();
  const T = today();
  const flowRows = readFlow().rows;
  const lastFlowOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim() && isFollowRecord(f))
    .sort((a, b) => String(b['日期'] || '').localeCompare(String(a['日期'] || '')))[0];
  const historyOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim())
    .sort((a, b) => String(a['日期'] || '').localeCompare(String(b['日期'] || '')))
    .slice(-3)
    .map(f => ({ date: String(f['日期'] || '').slice(0, 10), method: f['方式'], type: f['类型'], what: String(f['沟通内容'] || ''), react: String(f['对方反应'] || ''), next: String(f['下一步动作'] || '') }));
  // 2026-10-13：重点跟进 = 六类里的 focus（=1 类、与等级 A 一一对应），口径只有 bucketOf 一处
  // 2026-10-19 用户 m00409：「重点跟进：不用列入今日任务，我每天都会看」→ 页面加 doneToday 断点，
  //   **不进电话队列**（buildQueue 仍然排除），note 口径跟着改。
  const list = rows.filter(r => bucketOf(r, flowRows) === 'focus').map(r => {
    const last = lastFlowOf(r['客户ID']);
    const lastDate = last ? String(last['日期'] || '').slice(0, 10) : '';
    return Object.assign(pickCust(r, false, flowRows), {
      lastDate,
      reason: last ? stamp(last['日期'], String(last['沟通内容'] || '').slice(0, 60)) : '',
      hist: historyOf(r['客户ID']),
      doneToday: lastDate === T,
      silentDays: lastDate ? dayDiffStr(T, lastDate) : null,
    });
  }).sort((a, b) => {
    // 今天还没跟的排前面（用户每天扫一眼就知道剩谁），再按等级
    if (a.doneToday !== b.doneToday) return a.doneToday ? 1 : -1;
    const la = levelRank(a.level), lb = levelRank(b.level);
    return la - lb;
  });
  const doneToday = list.filter(x => x.doneToday).length;
  return { ok: true, date: T, count: list.length, doneToday, missedToday: list.length - doneToday,
    bucket: 'focus', bucketLabel: BUCKET_DEF.focus.label, level: BUCKET_DEF.focus.level, list,
    cadenceDays: FOCUS_CADENCE_DAYS,
    note: '重点跟进=A 级：人工挑的重点盘子，**不列入今日任务**（你每天自己看这一页）；今天还没跟的排前面，跟一个少一个；移入/移出跟我说一句即可（走 sales_log 改 status=重点跟进 / 跟进中）' };
}

// ---------- 六分类名单页 + 选题池（2026-10-13 用户定：六类成页、导航按它重排）----------
// 只读、现算、不落盘（红线 10）。分类口径只有 bucketOf() 一处 —— 页面、选题池、统计全部共用，绝不各写一套过滤。
// bucketPage：把某一类的客户拉出来（带静默天数/最近跟进/历史轨迹/是否终态），排序交给 sortBucketList。
function bucketPage(rows, flowRows, key, T) {
  const lastFlowOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim() && isFollowRecord(f))
    .sort((a, b) => String(b['日期'] || '').localeCompare(String(a['日期'] || '')))[0];
  const historyOf = (id) => flowRows
    .filter(f => String(f['客户ID']).trim() === String(id).trim())
    .sort((a, b) => String(a['日期'] || '').localeCompare(String(b['日期'] || '')))
    .slice(-3)
    .map(f => ({ date: String(f['日期'] || '').slice(0, 10), method: f['方式'], type: f['类型'], what: String(f['沟通内容'] || ''), react: String(f['对方反应'] || ''), next: String(f['下一步动作'] || '') }));
  const silentDaysOf = (r) => {
    const last = lastFlowOf(r['客户ID']);
    const base = normDateStr((last && last['日期']) || r['建档日期']) || '';
    if (!base) return null;
    const n = dayNum(T) - dayNum(base);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const def = BUCKET_DEF[key];
  const list = rows.filter(r => bucketOf(r, flowRows) === key).map(r => {
    const last = lastFlowOf(r['客户ID']);
    return Object.assign(pickCust(r, false, flowRows), {
      bucket: key, bucketLabel: def.label, bucketLevel: def.level,
      silentDays: silentDaysOf(r),
      lastDate: last ? String(last['日期'] || '').slice(0, 10) : '',
      reason: last ? stamp(last['日期'], String(last['沟通内容'] || '').slice(0, 60)) : '',
      hist: historyOf(r['客户ID']),
      paid: numFrom(r['付款总额']),
      terminal: bucketTerminal(r),
    });
  });
  return { def, list };
}
// 分类内排序（每类关心的东西不一样）：
//   待首触   → 能打的先（有手机号）+ 越新越靠前
//   标品成交 → 到期日由近到远（要续费/复购的先冒头）
//   其余     → 有排期的先（逾期在前）→ 静默久的先 → 等级高的先
function sortBucketList(list, key) {
  const byId = (a, b) => String(a.id || '').localeCompare(String(b.id || ''));
  if (key === 'first') {
    return list.sort((a, b) => (Number(!!String(b.phone || '').trim()) - Number(!!String(a.phone || '').trim()))
      || String(b.reg || '').localeCompare(String(a.reg || '')) || byId(a, b));
  }
  if (key === 'standard') {
    return list.sort((a, b) => {
      const ea = a.expire || '9999-12-31', eb = b.expire || '9999-12-31';
      return (ea < eb ? -1 : ea > eb ? 1 : 0) || (Number(b.paid || 0) - Number(a.paid || 0)) || byId(a, b);
    });
  }
  return list.sort((a, b) => {
    const na = a.next || '', nb = b.next || '';
    if (!!na !== !!nb) return na ? -1 : 1;
    if (na && nb && na !== nb) return na < nb ? -1 : 1;
    const sa = (a.silentDays === null || a.silentDays === undefined) ? -1 : a.silentDays;
    const sb = (b.silentDays === null || b.silentDays === undefined) ? -1 : b.silentDays;
    if (sa !== sb) return sb - sa;
    const la = levelRank(a.level), lb = levelRank(b.level);
    if (la !== lb) return la - lb;
    return byId(a, b);
  });
}
// 标品成交页（S 级）：已付费成交客户 —— 转成交后服务 + 续费/复购 + 转介绍
// 2026-10-19 用户 m00409：「标品成交：每两周进行一次服务追踪」→ 每行带 svcDays/nextSvcDue/svcDue，
//   到点(≥14 天)的排前面（服务追踪优先于单纯按到期日排）。
function cmdStandard() {
  const { rows } = readMaster();
  const T = today();
  const flowRows = readFlow().rows;
  const p = bucketPage(rows, flowRows, 'standard', T);
  const touchIdx = indexLastTouch(flowRows);
  const byId = new Map(rows.map(r => [String(r['客户ID'] || '').trim(), r]));
  p.list.forEach(x => {
    const r = byId.get(String(x.id || '').trim()) || {};
    const nd = cadenceDueOf(r, flowRows, T, 'standard', touchIdx.get(String(x.id || '').trim()) || '');
    x.svcDays = nd ? nd.days : null;
    x.svcBase = nd ? nd.base : '';
    x.nextSvcDue = nd ? nd.nextDue : '';
    x.svcDue = !!(nd && nd.due);
    x.cadenceDays = STANDARD_CADENCE_DAYS;
  });
  const list = sortBucketList(p.list, 'standard');
  // 到点该做服务追踪的排前面（同组内仍按到期日/付款额）
  list.sort((a, b) => (Number(!!b.svcDue) - Number(!!a.svcDue)));
  const left = (d) => (d ? dayDiffStr(d, T) : null);
  const expiring30 = list.filter(x => { const n = left(x.expire); return n !== null && n >= 0 && n <= 30; }).length;
  const expired = list.filter(x => { const n = left(x.expire); return n !== null && n < 0; }).length;
  const svcDueCount = list.filter(x => x.svcDue).length;
  return { ok: true, date: T, bucket: 'standard', bucketLabel: p.def.label, level: p.def.level,
    count: list.length,
    // 2026-10-22 用户：金额只展示两位小数（万元）。库里仍以元为单位，累加后先按分四舍五入，
    //   否则浮点累加会得出 73296.49999999999 这种尾巴（用户截图上就是这个）。
    paidSum: Math.round(list.reduce((s, x) => s + Number(x.paid || 0), 0) * 100) / 100,
    expiring30, expired,
    serviceCadenceDays: STANDARD_CADENCE_DAYS, svcDueCount, svcOkCount: list.length - svcDueCount, list,
    note: '标品成交=S 级：已付费成交客户（转成交后服务 + 续费/复购 + 转介绍）；**每 ' + STANDARD_CADENCE_DAYS + ' 天做一次服务追踪**，到点的排最前面（' + svcDueCount + ' 个到点）；同组内按到期时间由近到远排' };
}
// 定制开发页（SS 级，最高）：已进企业级轨（阶段≥8）的定制/私有化客户
function cmdCustom() {
  const { rows } = readMaster();
  const T = today();
  const flowRows = readFlow().rows;
  const p = bucketPage(rows, flowRows, 'custom', T);
  const list = sortBucketList(p.list, 'custom');
  const byStage = {};
  STAGE_ENT.forEach(s => { byStage[s] = list.filter(x => x.stage === s).length; });
  return { ok: true, date: T, bucket: 'custom', bucketLabel: p.def.label, level: p.def.level, count: list.length, byStage, list,
    note: '定制开发=SS 级（最高）：已进企业级轨（阶段≥8）的定制/私有化客户；一段只推一件事，进度看该客户的 SOP 时间轴' };
}
// 待首触页（未定级）：还没第一次触达的客资 —— 大盘 600+，只列前 N（有手机号、越新越靠前），省得一次渲染几百行
const FIRST_BUCKET_LIMIT = 200;
function cmdFirst(limit) {
  const { rows } = readMaster();
  const T = today();
  const flowRows = readFlow().rows;
  const p = bucketPage(rows, flowRows, 'first', T);
  const all = sortBucketList(p.list, 'first');
  const cap = Number(limit) > 0 ? Number(limit) : FIRST_BUCKET_LIMIT;
  const list = all.slice(0, cap).map(x => { const o = Object.assign({}, x); delete o.hist; return o; });
  const withPhone = all.filter(x => String(x.phone || '').trim()).length;
  return { ok: true, date: T, bucket: 'first', bucketLabel: p.def.label, level: p.def.level,
    count: all.length, listed: list.length, truncated: all.length > list.length, withPhone, list,
    note: `待首触=未定级：还没第一次触达的客资（共 ${all.length} 个，其中有手机号 ${withPhone} 个）。本页按"有手机号优先、越新越靠前"列前 ${cap} 个；真正打电话走今日任务里的首访配额` };
}
// 待定跟进页（B 级）：跟进中/挂起 —— 还没进终态、也没进重点盘的"跟进轨"（六类必须齐全，跟进中的客户落这里）
// 2026-10-19 用户 m00409：「待定跟进：距离上一次跟进超过一周则再次跟进」→ 每行带 overdueDays/due，
//   超 7 天的排最前面（跟一个少一个），note 口径跟着改。
function cmdPending() {
  const { rows } = readMaster();
  const T = today();
  const flowRows = readFlow().rows;
  const p = bucketPage(rows, flowRows, 'pending', T);
  const touchIdx = indexLastTouch(flowRows);
  const byId = new Map(rows.map(r => [String(r['客户ID'] || '').trim(), r]));
  p.list.forEach(x => {
    const r = byId.get(String(x.id || '').trim()) || {};
    const nd = cadenceDueOf(r, flowRows, T, 'pending', touchIdx.get(String(x.id || '').trim()) || '');
    x.pendDays = nd ? nd.days : null;
    x.pendBase = nd ? nd.base : '';
    x.due = !!(nd && nd.due);
    x.nextDue = nd ? nd.nextDue : '';
    x.anchor = nd ? nd.anchor : '';
    x.cadenceDays = PENDING_CADENCE_DAYS;
  });
  const list = sortBucketList(p.list, 'pending');
  // 超过一周该再跟的排最前面（跟一个少一个）
  list.sort((a, b) => (Number(!!b.due) - Number(!!a.due)));
  const noDate = list.filter(x => !String(x.next || '').trim()).length;
  const dueCount = list.filter(x => x.due).length;
  return { ok: true, date: T, bucket: 'pending', bucketLabel: p.def.label, level: p.def.level,
    count: list.length, noDate, dueCount, cadenceDays: PENDING_CADENCE_DAYS, list,
    note: '待定跟进=B 级：跟进中/挂起（还没进终态、也没进重点盘）。**距上次跟进超过 ' + PENDING_CADENCE_DAYS + ' 天就再跟一次**，到点的排最前面（' + dueCount + ' 个到点）；没定日子的按静默最久优先（把日子定下来就自动回跟进中）' };
}
// 六类选题池（2026-10-13 用户定：今日任务 / AI 今日策略的选题**从这六类里选**）——
//   每类按分类内排序取前 N；终态（已闭环/出口）不进池；已在动作块里显示过的（excludeIds）不重复列。
function bucketPools(rows, flowRows, T, opts) {
  const per = (opts && opts.per) || 10;
  const exclude = (opts && opts.excludeIds) || new Set();
  const keys = (opts && opts.keys) || BUCKET_ORDER;
  return keys.map(k => {
    const def = BUCKET_DEF[k];
    const all = bucketPage(rows, flowRows, k, T).list;
    const live = all.filter(x => !x.terminal && !exclude.has(String(x.id || '').trim()));
    const top = sortBucketList(live, k).slice(0, per).map(x => { const o = Object.assign({}, x); delete o.hist; return o; });
    return { key: k, label: def.label, level: def.level, count: all.length, liveCount: live.length, top, note: def.note };
  });
}

// ---------- 命令: 六分类等级一次性对齐（2026-10-13 用户定：等级随分类走）----------
// 为什么要有这条：等级列现在是分类的投影（写入口 syncLevelFor 自动归一），但存量数据里还有「分类=C、等级空」
//   「分类=待首触、等级=B」这类历史错位 → check ⑮ 一直报红、页面排序也会打架。
// 口径：**只动客户等级**，一笔一笔按【信息变更】留痕落流水表（可追溯），不碰状态/阶段/排期/触达。
//   走标准第七节的写入口（withWriteLock + 表头断言 + 原子写 + 变更日志），绝不手改 xlsx（铁律 2/17）。
// 安全默认：不传 run:true 就是 dryRun（只读预演，不写盘）。
function cmdAlignLevels(a) {
  a = a || {};
  const doWrite = a.run === true || a.run === 'true';
  const T = (a.date && isDateStr(a.date)) ? a.date : today();
  const collect = () => {
    const m = readMaster();
    const fl = readFlow();
    const drift = [];
    m.rows.forEach(r => {
      const want = String(bucketLevelOf(r, fl.rows) || '').trim();
      const now = String(r['客户等级'] || '').trim();
      if (now === want) return;
      const b = bucketOf(r, fl.rows);
      drift.push({ row: r, id: String(r['客户ID'] || '').trim(), bucket: b, bucketLabel: BUCKET_DEF[b].label, from: now, to: want });
    });
    return { m, fl, drift };
  };
  const byBucketOf = (drift) => { const o = {}; BUCKET_ORDER.forEach(k => { o[BUCKET_DEF[k].label] = drift.filter(d => d.bucket === k).length; }); return o; };
  if (!doWrite) {
    const { drift } = collect();
    return { ok: true, dryRun: true, date: T, count: drift.length, byBucket: byBucketOf(drift),
      list: drift.slice(0, 80).map(d => `${d.id}(${d.from || '未定级'}→${d.to || '未定级'})`),
      note: '只读预演（dryRun）：未写盘。真要执行传 {run:true}，会逐条写【信息变更】留痕进流水表' };
  }
  return withWriteLock(() => {
    const { m, fl, drift } = collect();
    if (!drift.length) return { ok: true, date: T, count: 0, message: '等级与分类已一致，无需对齐' };
    drift.forEach(d => {
      d.row['客户等级'] = d.to;
      pushChangeFlow(fl.rows, d.id, '信息变更', `等级对齐｜${d.from || '未定级'}→${d.to || '未定级'}（分类：${d.bucketLabel}）`, '');
    });
    const w = writeBoth(m, m.rows, m.headers, fl, fl.rows, fl.headers);
    if (!w.ok) return w;
    return { ok: true, date: T, count: drift.length, byBucket: byBucketOf(drift),
      message: `六分类等级对齐 ${drift.length} 个（等级随分类走；每条已落【信息变更】留痕）` };
  });
}

// ---------- 命令: 新增客户 (2026-09-10 用户要求) ----------
// 用户口述"新增客户"时建档：只写主表一行、不写流水（尚未触达 → 触达状态=未触达）。
// 客户ID规则: 有城市 → C-<城市>-<YYMM>-<序号>；无城市 → C-未知-<YYMM>-<序号>；序号=同前缀最大值+1(3位)。
// 2026-09-14 修复: 手机号严格校验 11 位（原来只判非空）；序号超 999 显式报错，不再生成 4 位 ID。
function cmdAdd(a) {
  a = a || {};
  const phone = String(a.phone || '').replace(/[\s-]/g, '').trim();
  if (!phone) return { ok: false, message: '缺少手机号(phone)' };
  if (!/^1\d{10}$/.test(phone)) return { ok: false, message: `手机号格式不合法: ${a.phone}（应为 1 开头 11 位）` };
  return withWriteLock(() => {
    const m = readMaster();
    const dup = m.rows.find(r => String(r['手机'] || '').replace(/[\s-]/g, '').trim() === phone);
    if (dup) {
      // 2026-09-29 用户定（两表留痕）: 录入必须同时落主表+流水。若上次"主表已写、留痕未写"（半写），
      //   重跑 add 会被手机号防重挡住 → 这里识别出"缺建档留痕"并补齐，而不是直接拒绝（幂等可重跑）。
      const dupId = String(dup['客户ID'] || '').trim();
      const fl0 = readFlow();
      const hasTrace = fl0.rows.some(f => String(f['客户ID'] || '').trim() === dupId && /^【建档】/.test(String(f['沟通内容'] || '').trim()));
      if (!hasTrace) {
        pushChangeFlow(fl0.rows, dupId, '建档', `补齐建档留痕｜${dup['公司'] || '无公司'}｜${dup['姓名/联系人'] || '未填姓名'}｜${phone}`, normStage(dup['意向阶段']) || '线索获取');
        try { writeFlow(fl0.wb, fl0.rows, fl0.headers); } catch (e) { return { ok: false, message: '补齐建档留痕失败: ' + e.message }; }
        return { ok: true, id: dupId, name: dup['姓名/联系人'] || '', phone, message: `客户已存在（${dupId}），本次补齐了建档留痕（未重复建行）` };
      }
      return { ok: false, message: `手机号已存在，无需新增: ${dupId} ${dup['公司'] || dup['姓名/联系人']}` };
    }
    const idn = a.id !== undefined && a.id !== null && String(a.id).trim() !== '' ? String(a.id).trim() : '';
    const d = new Date();
    const ym = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const city = String(a.city || '').trim();
    const prefix = `C-${city || '未知'}-${ym}-`;
    const id = idn || (() => {
      let max = 0;
      for (const r of m.rows) {
        const cid = String(r['客户ID'] || '').trim();
        if (!cid.startsWith(prefix)) continue;
        const n = parseInt(cid.slice(prefix.length), 10);
        if (n > max) max = n;
      }
      return prefix + String(max + 1).padStart(3, '0'); // 注: 若同月已到 999 会生成 4 位，下方显式拦截
    })();
    if (idn && m.rows.some(r => String(r['客户ID'] || '').trim() === id)) return { ok: false, message: `客户ID冲突(显式指定): ${id}` };
    if (!idn && id.length - prefix.length > 3) return { ok: false, message: `本月同城市序号已满 999（${id}），需扩位或换城市前缀，请你定` };
    const row = {};
    for (const h of m.headers) row[h] = '';
    const set = (k, v) => { if (m.headers.includes(k)) row[k] = v; };
    set('客户ID', id);
    set('建档日期', today());
    set('建档类型', String(a.bizType || '个人'));
    set('公司', String(a.company || ''));
    set('姓名/联系人', String(a.name || ''));
    set('手机', phone);
    set('微信昵称', String(a.wechat || ''));
    set('城市', city || '未知');
    set('来源', String(a.source || ''));
    set('客户等级', String(a.level || ''));
    set('跟进状态', String(a.status || '待首触'));
    set('触达状态', '未触达');
    set('意向阶段', '线索获取');   // 2026-09-29: 建档=线索进池，新客户立刻落在 SOP 第 1 段（待销售第一次触达）
    set('责任人', String(a.owner || '李昂'));
    set('备注', a.note ? stamp(today(), a.note) : '');
    m.rows.push(row);
    // 2026-09-29 用户定（两表留痕）: 录入也要同步落流水——新客户的来路（谁/哪天/什么公司）是数据史的第一条。
    //   顺序刻意是"先主表后流水"：万一流水写失败，也不会留下"孤儿流水"（客户ID 在主表里不存在 → check 报红）。
    const fl = readFlow();
    // 2026-10-13 用户定：等级跟着分类走 —— 新建客户也归一到分类等级（待首触=不定级；给了 status=重点跟进 就是 A）
    const lvSync = syncLevelFor(row, fl.rows);
    const levelSynced = lvSync.changed ? `${lvSync.from || '未定级'}→${lvSync.to || '未定级'}` : '';
    pushChangeFlow(fl.rows, id, '建档',
      `新增客户｜${a.company || '无公司'}｜${a.name || '未填姓名'}｜${phone}${city ? '｜' + city : ''}${a.source ? '｜来源:' + a.source : ''}`,
      '线索获取');
    try {
      writeMaster(m.wb, m.rows, m.headers);
      writeFlow(fl.wb, fl.rows, fl.headers);
    } catch (e) {
      return { ok: false, partial: true, id, message: `客户已写入主表，但流水留痕写失败: ${e.message}；重跑本命令会自动补齐留痕（幂等）` };
    }
    return { ok: true, id, name: a.name || '', phone, levelSynced, flowId: fl.rows[fl.rows.length - 1]['流水ID'], message: `已新增客户 ${id}（${a.name || '未填姓名'} ${phone}），并写入建档留痕${levelSynced ? `；等级随分类归一 ${levelSynced}` : ''}` };
  });
}

// ---------- 命令: 删除客户/流水（2026-10-13 批次5 审计 P0-1 收口；只经 CLI/dispatch，不新增 HTTP 路由/模型工具）----------
// 用户铁律（标准 §14.1）：「一次客户信息变化 = 主表改动 + 一条流水留痕，两表同时落」——**删除也是变化**。
//   收口前：CHANGE_KINDS 里登记着「删除」，却**没有任何生成者** → 删行只能靠 scripts/remove-*.cjs 直写流水，
//   事后查不出删了谁/删了什么/谁删的（唯一痕迹是 backup/ 里一个 xlsx）。
// 现在：先按目标快照生成【删除】墓碑留痕，再删目标行；墓碑永远不删，check ③ 认得它、不再算孤儿。
//   · 客户级 a.id（可带 a.purgeFlows=true）：删主表该客户行；**默认保留**该客户存量流水（可后查接续），
//     purgeFlows=true 才连存量流水一起清掉（只留墓碑）。墓碑快照含 姓名/手机/状态/阶段/付费/流水条数/末次日期。
//   · 流水级 a.id + a.flowId：只删指定流水，墓碑记 流水ID/日期/内容截断。
// 幂等：同客户+同日+同墓碑内容 已存在 → 不重复记账，只补齐未完成的那一步（半写重跑安全，与 cmdAdd 同口径）。
function cmdDelete(a) {
  a = a || {};
  const id = String(a.id || '').trim();
  if (!id) return { ok: false, message: '缺 id（客户ID）；客户级删除只给 id，流水级再加 flowId' };
  if (a.date && !isDateStr(a.date)) return { ok: false, message: `日期格式应为 YYYY-MM-DD，收到: ${a.date}` };
  const flowId = String(a.flowId || a.flow || '').trim();
  const reason = String(a.reason || a.note || '').trim();
  return withWriteLock(() => {
    const m = readMaster();
    const rows = m.rows;
    const fl = readFlow();
    const date = a.date ? normDateStr(a.date) : today();
    const tombOf = (what) => fl.rows.find(f => String(f['客户ID']).trim() === id
      && String(f['日期'] || '').trim() === date && String(f['沟通内容'] || '').trim() === what);

    // ---- 模式②: 删一条流水 ----
    if (flowId) {
      const idx = fl.rows.findIndex(f => String(f['流水ID'] || '').trim() === flowId && String(f['客户ID'] || '').trim() === id);
      const target = idx >= 0 ? fl.rows[idx] : null;
      if (target && /^【删除】/.test(String(target['沟通内容'] || '').trim())) {
        return { ok: false, message: `拒绝删除【删除】墓碑本身（${flowId}）——删除记录必须可后查` };
      }
      const tDate = target ? (String(target['日期'] || '').trim() || '空') : '空';
      const tWhat = target ? (String(target['沟通内容'] || '').trim().slice(0, 40) || '空') : '（目标已不存在）';
      const detail = `删除流水｜${flowId}｜日期 ${tDate}｜内容 ${tWhat}${reason ? '｜原因 ' + reason : ''}`;
      const what = '【删除】' + detail;
      const dup = tombOf(what);
      const tomb = dup ? null : pushChangeFlow(fl.rows, id, '删除', detail, target ? target['阶段'] : '');
      if (target) fl.rows.splice(fl.rows.indexOf(target), 1);
      try { writeFlow(fl.wb, fl.rows, fl.headers); }
      catch (e) { return { ok: false, partial: false, message: `写Excel失败: ${e.message}（墓碑与删除在同一次原子写里，未改任何数据，可安全重试）` }; }
      return { ok: true, mode: 'flow', id, flowId, deletedId: target ? flowId : '',
        tombFlowId: tomb ? tomb['流水ID'] : (dup ? dup['流水ID'] : ''), duplicated: !!dup, deleted: !!target,
        message: target
          ? `已删除流水 ${flowId}，并落【删除】墓碑可后查（${tomb ? tomb['流水ID'] : dup['流水ID']}）`
          : `流水 ${flowId} 已不存在${dup ? `（墓碑 ${dup['流水ID']} 已在）` : ''}，本次未改数据` };
    }

    // ---- 模式①: 删一个客户（主表行）----
    const c = rows.find(r => String(r['客户ID']).trim() === id);
    if (!c) return { ok: false, message: `未找到客户 ${id}（不猜、不删；删除留痕也无处可挂）` };
    const mine = fl.rows.filter(f => String(f['客户ID']).trim() === id);
    const lastDate = mine.map(f => String(f['日期'] || '').trim()).filter(Boolean).sort().pop() || '';
    const detail = `删除客户｜${id}｜${String(c['公司'] || c['姓名/联系人'] || '无名称').trim()}`
      + `｜手机 ${String(c['手机'] || '').trim() || '空'}`
      + `｜状态 ${String(c['跟进状态'] || '').trim() || '空'}`
      + `｜阶段 ${String(c['意向阶段'] || '').trim() || '空'}`
      + `｜付费 ${fmtMoneyWan(c['付款总额'])}`
      + `｜存量流水 ${mine.length} 条(常规 ${mine.filter(isFollowRecord).length})｜末次 ${lastDate || '无'}`
      + `${reason ? '｜原因 ' + reason : ''}`;
    const what = '【删除】' + detail;
    const dup = tombOf(what);
    const tomb = dup ? null : pushChangeFlow(fl.rows, id, '删除', detail, c['意向阶段']);
    let purged = 0;
    if (a.purgeFlows === true) {
      for (let i = fl.rows.length - 1; i >= 0; i--) {
        const f = fl.rows[i];
        if (f !== tomb && String(f['客户ID'] || '').trim() === id) { fl.rows.splice(i, 1); purged++; }
      }
    }
    const mi = rows.indexOf(c);
    if (mi >= 0) rows.splice(mi, 1);
    const w = writeBoth(m, rows, m.headers, fl, fl.rows, fl.headers);
    if (!w.ok) return { ok: false, partial: w.partial, id, flowId: tomb ? tomb['流水ID'] : '', message: w.message + '（客户级删除重跑幂等：命中已有墓碑则只补未完成的那一步）' };
    return { ok: true, mode: 'customer', id, deleted: true, name: c['公司'] || c['姓名/联系人'] || '',
      tombFlowId: tomb ? tomb['流水ID'] : (dup ? dup['流水ID'] : ''), duplicated: !!dup,
      purgedFlows: purged, keptFlows: a.purgeFlows === true ? 0 : mine.length,
      message: `已删除客户 ${id}（${c['公司'] || c['姓名/联系人'] || '无名称'}），并落【删除】墓碑`
        + `${tomb ? ' ' + tomb['流水ID'] : (dup ? ' ' + dup['流水ID'] + '(已存在)' : '')}`
        + `${purged ? `；同时清掉存量流水 ${purged} 条` : `；存量流水 ${mine.length} 条保留可后查（purgeFlows=true 可清）`}` };
  });
}

// ---------- SOP 时间轴（2026-09-29 用户定：每个客户一条完整 SOP）----------
// 结构: 7 段标品漏斗 + 6 段企业级轨（合计 13 段）+ 2 个出口段 + 未标注段。
//   2026-10-08 审计 A19：这里原写「6 段漏斗」（阶段已扩到 13 段），是注释漂移，已更正。
// 「每个客户都要有个结果」→ result 必给（8 值，单一事实源 sopResultOf；见《销售数据标准》§15.2）。
// 说明: 纯派生现算，不落盘（红线10）；换阶段用 log 传 stage，记录自动落到新阶段之下。
// 2026-10-28（用户 m03369「时间排序，时间靠后的放下面才是正常逻辑」）：
//   客户时间轴按时间**升序**（老的在上、新的在下）。日期为空的流水（用户 2026-09-29 口径：没给日期就留空）
//   不能一律甩到最前——否则「今天刚跟的」会跑到 10-19 上面。规则：
//   ① 先按流水ID排（ID 单调递增 = 落库顺序）；② 空日期借「上一条有日期的流水」的日期定位，
//   开头那几条没有上一条，就借「后面第一条有日期的」；③ 最后按（定位到的日期, 流水ID）稳定排序。
function orderFlowsByTime(rows) {
  const list = (rows || []).slice();
  const seqOf = (f) => { const m = String(f['流水ID'] || '').match(/(\d+)/); return m ? Number(m[1]) : 0 };
  list.sort((a, b) => seqOf(a) - seqOf(b));
  const resolved = new Map();
  let carry = '';
  for (const f of list) {
    const d = String(f['日期'] || '').slice(0, 10);
    if (d) carry = d;
    resolved.set(f, { d: d || carry, seq: seqOf(f) });
  }
  let back = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i];
    const r = resolved.get(f);
    const d = String(f['日期'] || '').slice(0, 10);
    if (d) back = d;
    else if (!r.d) r.d = back;   // 开头几条空日期：借后面第一条有日期的
  }
  list.sort((a, b) => {
    const ra = resolved.get(a), rb = resolved.get(b);
    return String(ra.d || '').localeCompare(String(rb.d || '')) || ra.seq - rb.seq;
  });
  return list;
}

function buildSop(c, flowRows) {
  const cid = String((c && c['客户ID']) || '').trim();
  // 2026-10-28（用户 m03270「不要把过程信息放在面板里，面板里只展示结果」）：
  //   SOP 时间轴只放**跟进结果**（isFollowRecord）。【信息变更】/【删除】墓碑这类过程留痕
  //   仍留在流水表可后查（条数走 changes 带出，面板不渲染）。
  const all = orderFlowsByTime((flowRows || [])
    .filter(f => String(f['客户ID'] || '').trim() === cid));
  const mine = all.filter(isFollowRecord);
  const rec = (f) => ({
    id: f['流水ID'], date: String(f['日期'] || '').slice(0, 10), method: f['方式'], type: f['类型'],
    stage: normStage(f['阶段']), what: String(f['沟通内容'] || ''), react: String(f['对方反应'] || ''),
    next: String(f['下一步动作'] || ''), nextDate: normDateStr(f['下次跟进时间']), nextMethod: f['下次跟进方式'],
  });
  const current = normStage(c && c['意向阶段']);
  const stages = STAGE_MAIN.map((s, i) => {
    const rs = mine.filter(f => normStage(f['阶段']) === s).map(rec);
    return { stage: s, seq: i + 1, count: rs.length, records: rs, done: rs.length > 0, current: current === s, exit: false };
  });
  const exits = STAGE_EXIT.map(s => {
    const rs = mine.filter(f => normStage(f['阶段']) === s).map(rec);
    return { stage: s, seq: 0, count: rs.length, records: rs, done: rs.length > 0, current: current === s, exit: true };
  });
  const unlabeled = mine.filter(f => !STAGE_SET[normStage(f['阶段'])]).map(rec);
  const seq = stageSeq(current);
  const reached = stages.filter(x => x.done).map(x => x.stage);
  const r7 = sopResultOf(c, flowRows);   // 2026-10-08 结果轴（8 值，单一事实源）——result 与全库口径统一（原来自己算一套）
  const result = r7.result;
  const nextStage = seq >= 1 && seq < STAGE_MAIN.length ? STAGE_MAIN[seq] : '';
  const missing = stages.filter(x => !x.done && x.seq < (seq || 99)).map(x => x.stage);
  return {
    current, seq, progress: seq ? seq + '/' + STAGE_MAIN.length : (isExitStage(current) ? '出口·' + current : '未进入漏斗'),
    result, resultLabel: r7.progress, anchor: r7.anchor, stuckAt: r7.stuckAt, conclusion: r7.conclusion,
    nextStage, reached, missing, total: mine.length, changes: all.length - mine.length, stages, exits, unlabeled,
    note: result === '成交签约' ? '已成交；成交后的服务/续费记录仍挂在本阶段之下'
      : result === '停住·无锚点' ? '已挂起/冷备但没写【结论】复查锚点 → 黑洞，请点名给个结论（sales_settle）'
        : RESULT_STOP[result] ? '已点名结论：' + result + (r7.stuckAt ? '（停在「' + r7.stuckAt + '」）' : '') + (r7.anchor ? '，复查锚点：' + r7.anchor : '')
          : isExitStage(current) ? '该客户已有结论（' + current + '），不再占跟进盘子'
            : (current ? '围绕「' + current + '」推进' + (nextStage ? '，下一段是「' + nextStage + '」' : '')
              : '尚未纳入 SOP（当前阶段为空）'),
  };
}
// ---------- 命令: 客户 SOP 时间轴 ----------
function cmdSop(id) {
  const { rows } = readMaster();
  const k = String(id || '').trim();
  let c = rows.find(r => String(r['客户ID']).trim() === k);
  if (!c && k) {
    const lk = k.toLowerCase();
    c = rows.find(r => [r['客户ID'], r['公司'], r['姓名/联系人'], r['手机'], r['微信昵称'], r['城市']].join(' ').toLowerCase().includes(lk));
  }
  if (!c) return { ok: false, found: false, message: `未找到客户 ${id}` };
  const sop = buildSop(c, readFlow().rows);
  return {
    ok: true, found: true, id: c['客户ID'], name: c['公司'] || c['姓名/联系人'],
    level: c['客户等级'] || '未定级', status: c['跟进状态'], touch: c['触达状态'],
    next: normDateStr(c['下次跟进时间']), sop,
  };
}
// ---------- 命令: 客户全景 ----------
function cmdView(id) {
  const { rows } = readMaster();
  const k = String(id || '').trim();
  // 先按客户ID精确匹配；找不到再走身份解析（2026-10-22 用户 m01260：不再"取第一条"——同名多条会静默选错）
  let c = rows.find(r => String(r['客户ID']).trim() === k);
  let candidates = [];
  let viaResolve = false;
  let matchScore = 0;
  if (!c && k) {
    const rr = resolveRows(k, rows);
    if (!rr.length) {
      return {
        found: false, ambiguous: false, query: k,
        message: `未找到客户 ${k}（客户表里没有匹配；别猜，如实说没查到）`,
      };
    }
    const top = rr[0];
    const sec = rr[1];
    const ambiguous = !!sec && top.score < sec.score * 1.4;
    const candOf = (x) => ({
      id: x.r['客户ID'], name: x.r['公司'] || x.r['姓名/联系人'], contact: x.r['姓名/联系人'],
      level: x.r['客户等级'] || '未定级', stage: normStage(x.r['意向阶段']), status: x.r['跟进状态'],
      score: Math.round(x.score), matched: x.matched,
    });
    if (ambiguous) {
      return {
        found: false, ambiguous: true, query: k, count: rr.length,
        message: `「${k}」匹配到 ${rr.length} 个客户，别猜——按客户ID区分（或要手机号/公司全称）`,
        candidates: rr.slice(0, 6).map(candOf),
      };
    }
    c = top.r;
    viaResolve = true;
    matchScore = Math.round(top.score);
    candidates = rr.slice(1, 4).map(candOf);   // 唯一时也把"次接近的"带上，便于模型判断有没有认错
  }
  if (!c) return { found: false, message: `未找到客户 ${k}` };
  const cid = String(c['客户ID']).trim();
  const flowAll = readFlow().rows.filter(r => String(r['客户ID']).trim() === cid);
  // 2026-10-28（用户 m03270）：面板/档案/模型看到的流水清单只放**跟进结果**；
  //   【信息变更】/【删除】墓碑属过程留痕，只在库里可后查（条数走 changeCount）。
  const flow = orderFlowsByTime(flowAll.filter(isFollowRecord));
  const contactWb = X.readFile(MASTER);
  const contacts = contactWb.Sheets['联系人'] ? X.utils.sheet_to_json(contactWb.Sheets['联系人'], { defval: '' }).filter(r => String(r['客户ID']).trim() === cid) : [];
  const profile = {
    id: c['客户ID'], orig: c['原编号'], type: c['建档类型'], company: c['公司'],
    name: c['姓名/联系人'], phone: c['手机'], wechat: c['微信昵称'], city: c['城市'],
    source: c['来源'], level: c['客户等级'], touch: c['触达状态'], status: c['跟进状态'],
    intent: c['意向阶段'], stage: normStage(c['意向阶段']), next: c['下次跟进时间'], nextMethod: c['下次跟进方式'],
    bought: c['是否购买'], paid: c['付款总额'], note: c['备注'], owner: c['责任人'],
    // 客户信息展示（2026-10-22 用户）：**最后登陆时间 + 智写智算使用情况是重点**。
    //   与行数据（todayList/ftItems/pickCust）同一口径：只做事实展示，不参与判定/优先级/话术（标准 13.1）。
    reg: normDateStr(c['注册时间']),
    lastLogin: normDateStr(c['最后登陆时间']),
    expire: normDateStr(c['到期时间']),
    usage: {
      zhisuan: numFrom(c['智算次数']),       // 智算次数
      zxLogin: numFrom(c['智写登录次数']),   // 智写登录次数（只展示，禁入判定/话术）
      zxRemain: numFrom(c['智写剩余字数']),  // 智写剩余字数
      zxUsed: numFrom(c['智写消耗字数']),    // 智写消耗字数
      zxDone: numFrom(c['智写文章生成次数']), // 智写文章生成次数
      zxBuy: numFrom(c['智写购买字数']),     // 智写购买字数
    },
  };
  return { found: true, profile, contacts, flowCount: flow.length, changeCount: flowAll.length - flow.length, sop: buildSop(c, flowAll),
    // 2026-10-22：模糊命中时带上"次接近的候选"，让模型自己判断有没有认错人（不再静默选第一条）
    matchedBy: viaResolve ? 'resolve' : 'id', matchScore, candidates,
    flow: flow.map(f => ({ id: f['流水ID'], date: f['日期'], method: f['方式'], type: f['类型'], stage: normStage(f['阶段']), what: f['沟通内容'], react: f['对方反应'], next: f['下一步动作'], nextDate: f['下次跟进时间'] })) };
}

// ---------- 命令: 记录跟进 ----------
// 参数: id, 日期, 方式, 类型, 沟通内容, 对方反应, 下一步动作, 下次跟进时间, 下次跟进方式
// 写前校验: 客户存在 + 必填 + 日期格式 + 枚举合法；流水ID防重号(扫描全表最大序号)；写锁防并发。
// 写库差异预览（2026-10-21 夜，侧栏 AI 协议 v2 的地基）：
//   dryRun 走的是**同一条** cmdLog/cmdSettle 代码路径，只在校验/归一/差异全算完之后跳过落盘。
//   这样「预览里能写」＝「真写就能成」，不会出现两套校验各说各话（原计划抽 planLog 纯函数，
//   但那样得把 220 行校验复制一遍或大改结构，风险远大于收益 → 改为原地 dryRun，零复制）。
const PREVIEW_FIELDS = [['跟进状态', 'status'], ['意向阶段', 'stage'], ['下次跟进时间', 'next'],
  ['下次跟进方式', 'nextMethod'], ['客户等级', 'level'], ['触达状态', 'touch']];
function previewFieldsOf(row) {
  const o = {};
  PREVIEW_FIELDS.forEach(([k, alias]) => {
    const v = String((row || {})[k] == null ? '' : row[k]);
    o[alias] = k === '意向阶段' ? normStage(v) : v;
  });
  return o;
}

// 2026-10-29（用户 m03421 截图：AI 出的写卡「方式：会议」，点了「✅ 确认写入」才报「方式不合法: 会议」）：
//   模型爱写口语词（会议/面谈/视频会议/演示/首访）。这类词**在写库校验之前**归一到库里的枚举，
//   归一得动就记一条 fixed 回给插件（卡片上显示「插件替你改了方式」），归不动才报错。
//   原则不变：只做**同义改词**，不改用户的意思，也不猜（会议→上门是因为面对面开会=上门拜访；
//   视频/线上会议没有「上门」实体，按通话算电话）。
const METHOD_ALIAS = Object.assign(Object.create(null), {
  '会议': '上门', '面谈': '上门', '当面': '上门', '拜访': '上门', '到访': '上门', '上门沟通': '上门', '上门拜访': '上门', '现场': '上门',
  '打电话': '电话', '通话': '电话', '电话沟通': '电话', '电话联系': '电话', '电话回访': '电话', '视频会议': '电话', '线上会议': '电话', '视频': '电话', '视频通话': '电话',
  '发微信': '微信', '微信沟通': '微信', '微信联系': '微信', '微信拜访': '微信', '私信': '微信',
  '发短信': '短信', '短信通知': '短信', '短信沟通': '短信',
  '邮件': '官网申请', '邮件沟通': '官网申请', '线上申请': '官网申请', '官网': '官网申请', '后台申请': '官网申请', '官网留言': '官网申请',
});
const TYPE_ALIAS = Object.assign(Object.create(null), {
  '演示': '试用回访', '产品演示': '试用回访', '上门演示': '试用回访', '试用': '试用回访', '试用跟进': '试用回访',
  '跟进': '高意向跟进', '常规跟进': '高意向跟进', '电话跟进': '高意向跟进', '需求沟通': '高意向跟进', '报价': '高意向跟进',
  '商务': '高意向跟进', '签约': '高意向跟进', '成交': '高意向跟进', '方案': '高意向跟进',
  '首访': '首触', '首次触达': '首触', '第一次联系': '首触', '初访': '首触',
  '老客户维护': '老客服务', '续费': '老客服务', '续约': '老客服务', '服务': '老客服务', '回访': '老客服务',
  '反馈': '客户反馈', '投诉': '客户反馈', '不满意': '客户反馈',
  '数据': '数据整理', '整理': '数据整理', '策略': '策略调整', '放弃': '放弃跟进', '不跟了': '放弃跟进',
});
// 2026-10-29（用户 m03535「跟进记录不对应 sop」）：
//   现场：客户停在「需求挖掘」，10-29 上午真做了产品演示，记录却按规则④挂在客户**当前**阶段
//   → 面板上「需求挖掘」多一条、「产品演示」空着、当前阶段也不动 —— 看着就像记错了客户。
//   现在按**内容**判这条跟进实际发生在哪一段：只往前走（不回退），命中哪段落哪段，主表当前阶段跟着推。
//   判不准（没有阶段特征词）就返回空，仍旧落在当前阶段 —— 宁可不动，也不猜。
const STAGE_HINTS = [
  ['私有化签约', /私有化签约/],
  ['成交签约', /签约|签合同|签了合同|合同已签|已成交|成交|打了款|打了首款|已付款|付了首付|首付款|尾款/],
  ['方案报价', /报价|报了价|价格表|给了价|招标|投标|标书|合同条款|商务条款|年度框架/],
  ['产品演示', /演示|产品讲解|讲产品|POC|试点演示|上线演示|看了系统|试用了系统/],
  ['异议处理', /异议|嫌贵|太贵|贵了|顾虑|不放心|质疑|竞品|犹豫|投诉|不满意|拒绝了/],
  ['需求挖掘', /需求|痛点|想解决|想更新|调研|要什么|场景|新系统|卡在/],
  ['企业级机会', /企业级|私有化|私有部署|私有云|算力|一体机|内网部署|智能体平台/],
  ['决策链摸排', /决策链|拍板|决策人|老板|领导|审批流程|预算/],
  ['需求与现状勘察', /勘察|现状|资料归集|家底|流程梳理|资料权属/],
  ['方案与试点设计', /试点方案|试点设计|方案设计|POC方案/],
  ['商务推进', /商务推进|用印|法务|采购流程|招采/],
];
const STAGE_HINT_NEG = /未成交|没成交|不成交|暂不签|不签|没签约|不打算签|不做了|推进终止/;
function inferStageOfFollow(a) {
  const txt = [a && a.what, a && a.react, a && a.nextAction]
    .map((x) => String(x == null ? '' : x)).join(' ');
  if (!txt.trim()) return '';
  const neg = STAGE_HINT_NEG.test(txt);
  let best = '';
  let bestSeq = 0;
  for (const [stage, re] of STAGE_HINTS) {
    if (neg && /签约/.test(stage)) continue;   // 「暂不签/没成交」别被当成已成交
    if (!re.test(txt)) continue;
    const sq = stageSeq(stage);
    if (sq > bestSeq) { best = stage; bestSeq = sq; }
  }
  return best;
}
function normalizeFollowArgs(a) {
  const out = Object.assign({}, a || {});
  const fixed = [];
  const mRaw = String(out.method == null ? '' : out.method).trim();
  if (mRaw && !METHOD_SET[mRaw]) {
    let hit = METHOD_ALIAS[mRaw];
    if (!hit) {
      const base = mRaw.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '').trim();
      hit = METHOD_ALIAS[base] || '';
    }
    if (hit && METHOD_SET[hit]) {
      out.method = hit;
      fixed.push(`方式「${mRaw}」→「${hit}」`);
    }
  }
  const tRaw = String(out.type == null ? '' : out.type).trim();
  if (tRaw && !TYPE_SET[tRaw]) {
    const hit = TYPE_ALIAS[tRaw];
    if (hit && TYPE_SET[hit]) {
      out.type = hit;
      fixed.push(`类型「${tRaw}」→「${hit}」`);
    }
  }
  return { args: out, fixed };
}
function cmdLog(a) {
  a = a || {};
  // 2026-10-29：归一前的原始 type/what 先留一份——「按内容落段」要按**人写的东西**判，
  //   不能拿归一后可能补出来的默认值（没写类型会被补成数据整理，那样每条都被当台账、一律不推段）。
  const aRawLog = { type: a.type, what: a.what };
  const dryRun = a.__dryRun === true;   // 只预览不落盘（logplan 命令用）
  // 2026-10-29（用户 m03421）：先归一「方式/类型」的口语词，再做枚举校验（归一结果回给插件写卡）
  let fixedLog = [];
  {
    const nrm = normalizeFollowArgs(a);
    if (nrm.fixed.length) { a = nrm.args; fixedLog = nrm.fixed; }
  }
  // 2026-09-14: "待定/择机"哨兵在**库层**也认（原来只有插件层认，直接用 CLI/b64 传"待定"会被日期校验拒掉）
  if (typeof a.nextDate === 'string' && /^(待定|不定|暂无|无日期|无|null|none|clear|-)$/i.test(a.nextDate.trim())) {
    a = Object.assign({}, a, { nextDate: '', clearNext: true });
  }
  // 1) 必填校验
  if (!a.id) return { ok: false, message: '缺少客户ID(id)' };
  // 2) 日期格式校验
  if (a.date && !isDateStr(a.date)) return { ok: false, message: `日期格式应为 YYYY-MM-DD，收到: ${a.date}` };
  if (a.nextDate && !isDateStr(a.nextDate)) return { ok: false, message: `下次跟进时间格式应为 YYYY-MM-DD，收到: ${a.nextDate}` };
  // 3) 枚举合法性校验
  // 2026-10-29：文案补上「其他」（METHOD_SET 本来就收，旧文案漏了它，害人以为只有六种）
  if (a.method && !METHOD_SET[a.method]) return { ok: false, message: `方式不合法: ${a.method}（应为 ${Object.keys(METHOD_SET).join('/')}）` };
  // 2026-10-21 夜（m05977）：模型老把「跟进状态」当「类型」写进来（type:'挂起冷备'）。
  //   报错时把两个枚举都列出来、并直接指路，比只说「不合法」更容易让它一次改对。
  if (a.type && !TYPE_SET[a.type]) {
    if (STATUS_SET[a.type] || /挂起|闭环|重点跟进|首触|跟进中/.test(a.type)) {
      return { ok: false, message: `类型不合法: ${a.type}——这是「跟进状态」不是「类型」。状态请放 status 字段；类型只能是 ${Object.keys(TYPE_SET).join('/')}` };
    }
    return { ok: false, message: `类型不合法: ${a.type}（只能是 ${Object.keys(TYPE_SET).join('/')}）` };
  }
  if (a.status && !STATUS_SET[a.status]) return { ok: false, message: `跟进状态不合法: ${a.status}（应为 跟进中/挂起/挂起冷备/已闭环/待首触）` };
  if (a.touch && !TOUCH_SET[a.touch]) return { ok: false, message: `触达状态不合法: ${a.touch}` };
  // 2026-10-08 加固：**类型=数据整理 且方式留空 = 变更留痕**（isChangeRecord 口径），内容必须带【种类】标签；
  //   否则会落成一条"内容没有【】的留痕"→ check ⑨ 报「变更留痕格式异常: 未知留痕种类「」」
  //   （某次实测踩到：想补客户性质信息，却把 what 塞进数据整理）。信息类内容请按 SOP 阶段落常规记录。
  const effType = String(a.type || '数据整理').trim();
  if (effType === '数据整理' && !String(a.method || '').trim() && String(a.what || '').trim() && !CHANGE_TAG.test(String(a.what).trim())) {
    return { ok: false, message: '类型=数据整理 且未填方式 = 变更留痕，沟通内容必须以【' + Object.keys(CHANGE_KINDS).join('/') + '】开头；若是普通业务/信息记录，请把类型改为 老客服务/客户反馈/高意向跟进 等常规类型，或补上方式(电话/微信/…)。' };
  }
  // 2026-09-14 修复: level 之前绕过任何校验直接写主表等级（枚举校验缺失）
  if (a.level && a.level !== '\u0000CLEAR' && !(a.level in LV)) return { ok: false, message: `客户等级不合法: ${a.level}（应为 SS/S/A/B/C 或空；2026-10-13 起等级跟着分类走）` };
  // 2026-09-29 SOP 阶段校验（旧别名按 STAGE_ALIAS 归一，不算错）
  if (a.stage !== undefined && a.stage !== null && String(a.stage).trim() !== '' && !STAGE_SET[String(a.stage).trim()] && !STAGE_ALIAS[String(a.stage).trim()]) {
    return { ok: false, message: `阶段不合法: ${a.stage}（应为 ${STAGE_MAIN.join('/')}，或出口 ${STAGE_EXIT.join('/')}）` };
  }
  // 2026-09-14: 手机回写（用户要求 sales_log 能写手机，别再手改 xlsx）
  const phoneIn = a.phone === null || a.phone === undefined ? '' : String(a.phone).replace(/[\s-]/g, '').replace(/\.0$/, '').trim();
  if (a.phone !== null && a.phone !== undefined && String(a.phone).trim() !== '' && !/^1\d{10}$/.test(phoneIn)) {
    return { ok: false, message: `手机号格式不合法: ${a.phone}（应为 1 开头 11 位）` };
  }
  // 日期口径归一（Excel 序列号/斜杠/中文日期 → YYYY-MM-DD），非空但无法识别则报错
  const normField = (k) => {
    const v = a[k];
    if (v === null || v === undefined || String(v).trim() === '') return { empty: true };
    const nv = normDateStr(v);
    if (!nv) return { bad: true, raw: v };
    return { v: nv };
  };

  return withWriteLock(() => {
    const m = readMaster();
    const rows = m.rows, headers = m.headers;
    const c = rows.find(r => String(r['客户ID']).trim() === a.id);
    if (!c) return { ok: false, message: `未找到客户 ${a.id}` };
    const beforeRow = Object.assign({}, c);   // 2026-09-29: 供【信息变更】留痕做前后差异
    // 2026-09-29 SOP 阶段归属（13 段双轨 + 2 出口；用户定"每一次跟进都要把客户往下一段推"；2026-10-08 审计 A19 更正段数）：
    //   ① 显式传 stage  → 这次跟进把客户**推进/回退**到该阶段（回写主表当前阶段）；显式永远优先
    //   ② 当前阶段为空  → 待首触/首触客户自动入池：直接触达方式→「客户触达」，否则→「线索获取」
    //   ③ 当前阶段=线索获取 且 本次是直接触达方式 → **自动推进到「客户触达」**（第一次打通/加上微信）
    //   ④ 其它          → 该条落在客户当前阶段之下（停留），主表当前阶段不动
    //   注：要"电话没打通、仍留在线索获取"，显式传 stage='线索获取' 即可（显式优先）
    const stageIn = a.stage === undefined || a.stage === null ? '' : normStage(a.stage);
    const stageFrom = normStage(c['意向阶段']);
    const touchNow = isTouchMethod(a.method);
    const isStartish = String(c['跟进状态'] || '').trim() === '待首触' || String(a.type || '').trim() === '首触';
    let autoStage = '';
    if (stageIn) autoStage = '';
    else if (!stageFrom && isStartish) autoStage = touchNow ? '客户触达' : '线索获取';
    else if (stageFrom === '线索获取' && touchNow) autoStage = '客户触达';
    // 2026-10-29（用户 m03535「跟进记录不对应 sop」）：上面四条规则里，④「其它 → 落在客户当前阶段」
    //   会把「真做了产品演示」的记录压在「需求挖掘」下，产品演示段永远空着。这里补一条：
    //   按**内容**判这条跟进实际走到哪一段（演示/报价/签约/异议…），比当前位置靠后就落那一段、主表跟着推；
    //   判不出特征词就返回空 → 仍旧停当前阶段（不猜）。
    let inferStage = '';
    // 只对「真跟进」判段：数据整理 / 策略调整（企业级台账、【信息变更】这类）不是拜访进展，
    //   一句话里带「决策人/预算」就去推段位，会把客户平白推走（8n 企业级那批用例就是这么被推上去的）。
    const inferEligible = (() => {
      const t = String(aRawLog.type == null ? '' : aRawLog.type).trim();
      const w = String(aRawLog.what == null ? '' : aRawLog.what).trim() || String((a && a.what) || '').trim();
      if (t === '数据整理' || t === '策略调整') return false;
      if (/^【/.test(w)) return false;
      return true;
    })();
    if (!stageIn && inferEligible) {
      const cand = inferStageOfFollow(a);
      const baseStage = autoStage || stageFrom;
      if (cand && !isExitStage(stageFrom) && stageSeq(cand) > stageSeq(baseStage)) inferStage = cand;
    }
    const flowStage = stageIn || inferStage || autoStage || stageFrom;
    const seqNow = stageSeq(flowStage);
    const nextStage = seqNow >= 1 && seqNow < STAGE_MAIN.length ? STAGE_MAIN[seqNow] : '';
    const moveNote = stageMoveNote(stageFrom, flowStage) + (autoStage ? '（自动落段：本次' + String(a.method || '—') + '）' : '')
      + (inferStage ? '（按内容落段：这次是' + inferStage + '的事）' : '');
    // 全表手机防重（2026-09-14 要求：一个手机号只对应一个客户，避免恢复/录入造出重复手机）
    if (phoneIn) {
      const dup = rows.find(r => String(r['手机'] || '').replace(/[\s-]/g, '').replace(/\.0$/, '').trim() === phoneIn);
      if (dup && String(dup['客户ID']).trim() !== String(a.id).trim()) {
        return { ok: false, message: `手机号已属别的客户，拒绝回写: ${phoneIn} → ${dup['客户ID']} ${dup['公司'] || dup['姓名/联系人']}` };
      }
    }
    const flow = readFlow();
    // 2026-10-10 用户拍板（"按你的意见来"）：**堵住"状态挂了却没说 why"的源头**。
    //   背景：原来这里下面是 `if (a.status) c['跟进状态'] = a.status;` 零门槛，而复查锚点只存在【结论】流水里
    //   （只有 cmdSettle 会写，见 1916 行附近），sales_log 的工具 schema 里**根本没有 anchor 字段**
    //   → 用 sales_log 把状态改成 挂起/挂起冷备/已闭环 = **物理上必然**造出「停住·无锚点」黑洞
    //   （sopResultOf 446-448 的判定口径；实测库里已积 39 个、【结论】留痕 0 行 → 看板锚点红点恒不亮）。
    //   规则：三种"停住/终态"状态必须有据。两个例外放行——
    //     ① 该客户已有**存活结论**（conclusionAlive）= 幂等重写，不新增黑洞；
    //     ② 本次把阶段推到**出口**（无法联系/推进终止）= sopResultOf 434-435 出口优先，本身带结论语义；
    //        阶段=成交签约 同理（sopResultOf 436-437 直接给「成交签约」结果，不是黑洞），一并放行。
    //   要"点名给结论"请走 sales_settle（它对要锚点的结论缺 anchor 会直接拒，见 1856-1858）。
    if (a.status && ['挂起', '挂起冷备', '已闭环'].includes(String(a.status).trim())) {
      const idNow = String(c['客户ID']).trim();
      const conRaw = lastConclusionOf(flow.rows, idNow);
      const hasCon = !!conclusionAlive(flow.rows, idNow, conRaw);
      const stgNow = stageIn || stageFrom;
      const toTerminal = STAGE_EXIT.includes(stgNow) || stgNow === '成交签约';
      if (!hasCon && !toTerminal) {
        return { ok: false, message: '拒绝改状态：' + a.status + ' 属于"停住/终态"，必须先有据（结论或出口阶段）。'
          + '下一步二选一：① 点名结论走 sales_settle(id=' + a.id + ', kind='
          + (a.status === '挂起' ? '沉默等需求' : a.status === '挂起冷备' ? '暂缓' : '无法联系|推进终止|成交签约')
          + ', anchor=日期或信号)；② 或在本次 sales_log 里同时传 stage=无法联系 / 推进终止。'
          + '没有锚点的停住 = 黑洞，系统不接受。' };
      }
    }
    // 流水ID防重号: nextFlowId() 扫全表最大序号+1（绝不与已有冲突）
    const newRow = {
      '流水ID': nextFlowId(flow.rows),
      '客户ID': a.id,
      // 2026-09-29 用户定：**没明确给日期就留空**，不再默认今天
      //   （原话「以后我没明确写日期的都空着，可以向我确认，我要没回答就是不需要写」）
      '日期': a.date !== undefined && a.date !== null && String(a.date).trim() !== '' ? normDateStr(a.date) : '',
      '方式': a.method || '',
      '类型': a.type || '数据整理',
      '沟通内容': a.what || '',
      '对方反应': a.react || '',
      '下一步动作': a.nextAction || '',
      '下次跟进时间': a.nextDate ? normDateStr(a.nextDate) : '',
      '下次跟进方式': a.nextMethod || '',
      '阶段': flowStage,
    };
    // 2026-09-14 幂等(加固 P0): 同客户+同日+同沟通内容 已存在 → 不重复写流水（半写重跑 / 模型重发 / 人工补跑都安全），
    //   仍然执行主表回写，把上次"流水已写、主表未回写"的半写补齐。去重口径与《销售数据标准》第四节一致。
    const dupFlow = String(newRow['沟通内容'] || '').trim()
      ? flow.rows.find(f => String(f['客户ID']).trim() === String(newRow['客户ID']).trim()
        && String(f['日期'] || '').trim() === String(newRow['日期']).trim()
        && String(f['沟通内容'] || '').trim() === String(newRow['沟通内容']).trim())
      : null;
    const isDup = !!dupFlow;
    if (isDup) newRow['流水ID'] = dupFlow['流水ID'];
    else flow.rows.push(newRow);
    // 回写主表（日期一律归一后再落：2026-10-21 体检 P0 —— 读侧按 normDateStr 解析，写侧不归一会静默掉队）
    if (a.nextDate) c['下次跟进时间'] = normDateStr(a.nextDate);
    if (a.nextMethod) c['下次跟进方式'] = a.nextMethod;
    // 2026-09-10 用户要求: 支持清空排期(如天乐徐总这类"等私享会日期再拿出来"的客户，别再显示到期)
    // 2026-09-14 修复: 显式传空串/null 也要清空（此前只处理有值或 clearNext=true，空串会留旧排期=假逾期）
    // 2026-09-14 加固(P0): 只有「显式要求清空」才清排期。
    //   缺省(未传 nextDate 键) = 本次不动排期；传 null 或显式空串 = 清空(转待定)。
    //   原实现把"未传"也当空串 → 每次不带日期的跟进都静默抹掉排期(工具描述还写着相反的话)。
    const nextProvided = Object.prototype.hasOwnProperty.call(a, 'nextDate') && a.nextDate !== undefined;
    const nextEmptyProvided = nextProvided && String(a.nextDate == null ? '' : a.nextDate).trim() === '';
    if (a.clearNext === true || a.nextDate === null || nextEmptyProvided) { c['下次跟进时间'] = ''; c['下次跟进方式'] = ''; }
    if (a.status) c['跟进状态'] = a.status;
    // 2026-09-29 SOP 阶段推进：显式传 stage 或自动判定命中才动主表当前阶段（都没有 = 停在本阶段，别乱推）
    if (stageIn) c['意向阶段'] = stageIn;
    // 2026-10-29（m03535）：按内容落段优先于「首次触达自动落客户触达」——两者同时命中时，
    //   流水落在哪一段，主表就得跟着落到哪一段（否则流水在产品演示、主表还写客户触达，又对不上）。
    else if (inferStage) c['意向阶段'] = inferStage;
    else if (autoStage) c['意向阶段'] = autoStage;   // 首次入池（线索获取/客户触达）或 线索获取→客户触达 自动推进
    // 2026-09-24: 「挂起」= 已接触过但没定日子。一旦这次给了下次跟进时间，它就不再是"时间不定" →
    //   自动回「跟进中」（与 cmdMeeting 排期拉回同口径）。显式传了 status 就尊重显式值，不抢。
    if (!a.status && String(c['跟进状态'] || '').trim() === '挂起' && c['下次跟进时间']) c['跟进状态'] = '跟进中';
    if (a.level === '\u0000CLEAR') c['客户等级'] = '';   // 2026-09-14: 显式清空等级(未定级)
    else if (a.level) c['客户等级'] = a.level;
    // 2026-10-13 用户定：等级跟着分类走 —— 写入口统一归一（状态/阶段一变，等级自动跟上；与分类对不上以分类为准）
    const lvSync = syncLevelFor(c, flow.rows);
    const levelSynced = lvSync.changed ? `${lvSync.from || '未定级'}→${lvSync.to || '未定级'}` : '';
    // 2026-09-10 新增: 用户跟进时给出的名字/公司 = 主表 姓名/联系人、公司(原名如"匿名注册/xj"直接替换)
    if (a.name) c['姓名/联系人'] = a.name;
    if (a.company) c['公司'] = a.company;
    // 2026-09-14 新增: 手机/城市/微信昵称/到期时间/注册时间 回写（此前只能手改 xlsx = 反复踩 8-28/9-08 错位事故）
    if (phoneIn) c['手机'] = phoneIn;
    if (a.city !== undefined && a.city !== null && String(a.city).trim() !== '') c['城市'] = String(a.city).trim();
    if (a.wechat !== undefined && a.wechat !== null && String(a.wechat).trim() !== '') c['微信昵称'] = String(a.wechat).trim();
    for (const [argKey, sheetKey] of [['expire', '到期时间'], ['reg', '注册时间']]) {
      const nd = normField(argKey);
      if (nd.bad) return { ok: false, message: `${sheetKey}格式无法识别: ${nd.raw}（应为 YYYY-MM-DD 或 Excel 序列号）` };
      if (nd.v && headers.includes(sheetKey)) c[sheetKey] = nd.v;
    }
    // 备注: 追加一段
    const oldNote = String(c['备注'] || '').trim();
    // 2026-09-10 用户要求: 备注自动带日期(记录当天)；已带 [M-D] 前缀的原样保留
    const noteRaw = String(a.note || '').trim();
    const stampedNote = !noteRaw ? '' : (/^\[\d{1,2}-\d{1,2}\]/.test(noteRaw) ? noteRaw : stamp(a.date || today(), noteRaw));
    const addNote = stampedNote ? (oldNote ? oldNote + '；' + stampedNote : stampedNote) : oldNote;
    c['备注'] = addNote;
    // 触达状态按流水自动重算（新口径见 deriveTouchState：申请加微信 ≠ 已加微信）
    //   2026-09-29: **【…】变更留痕不算触达证据**（改手机号/改状态不等于接触过客户）
    const custFlows = flow.rows.filter(f => String(f['客户ID']).trim() === a.id && isFollowRecord(f));
    c['触达状态'] = deriveTouchState(custFlows, c['触达状态']);
    // 2026-10-13 批次5 审计 F4/F5（旧实现只在"没写 what"时才 masterDiff → 顺手改的手机/等级/状态/排期/备注
    //   全都没有 before→after，事后查不出改了啥、谁在什么时候改的）：
    //   ① masterDiff **无条件**算，且挪到触达状态重算**之后**（触达状态也是主表字段，它的派生变化同样要留痕）；
    //   ② 没写 what → 差异写进本条流水（原口径）；有 what → 差异**另落一条独立【信息变更】**，
    //      不污染跟进内容、也不会被当成常规跟进（isChangeRecord 认【…】开头：不重置静默/不翻已处理/不算触达）；
    //   ③ 留痕日期为空则取 today()（原来继承 a.date 的空串，标准 §14.3 要求"日期=发生当天"）；
    //   ④ 既没写 what、字段也没净变化、且本条流水本身会被认成留痕（类型=数据整理+方式空）→
    //      拒绝写空内容留痕行（原来会 push 一条 沟通内容='' 的留痕 → check ⑨ 判"未知留痕种类「」"报红），
    //      整条跟进作废不落盘（什么都没发生，写它只会污染流水表）；带方式(如电话)的空内容记录仍按常规跟进落。
    const fieldDiffs = masterDiff(beforeRow, c);
    const changeDate = String(newRow['日期'] || '').trim() || today();
    let extraChangeFlow = null;   // 有 what 时另落的独立【信息变更】留痕（必须与主表同一次锁内落盘）
    if (!String(newRow['沟通内容'] || '').trim() && !fieldDiffs.length && isChangeRecord(newRow)) {
      if (!isDup) flow.rows.pop();   // 撤掉刚 push 的空内容行（它就是本条，尚未落盘）
      return { ok: true, id: a.id, flowId: '', noChange: true,
        message: `本次既没有沟通内容、主表字段也无任何差异，未写流水也未改主表: ${a.id}` };
    }
    if (!String(newRow['沟通内容'] || '').trim()) {
      if (fieldDiffs.length) { newRow['沟通内容'] = '【信息变更】' + fieldDiffs.join('；'); newRow['日期'] = changeDate; }
    } else if (fieldDiffs.length) {
      const tr = pushChangeFlow(flow.rows, a.id, '信息变更', fieldDiffs.join('；'), flowStage);
      tr['日期'] = changeDate;   // 与本次跟进同日（没给日期则今天）
      extraChangeFlow = tr;
    }
    // 2026-10-21 夜：dryRun 到此为止——校验/归一/幂等/差异都算完了，只差落盘。原样回预览。
    if (dryRun) {
      return {
        ok: true, dryRun: true, id: String(a.id),
        name: String(c['公司'] || c['姓名/联系人'] || ''),
        duplicated: isDup,
        preview: {
          before: previewFieldsOf(beforeRow), after: previewFieldsOf(c),
          diff: fieldDiffs.slice(),
          flow: {
            id: newRow['流水ID'], date: newRow['日期'] || '', method: newRow['方式'] || '',
            type: newRow['类型'] || '', what: newRow['沟通内容'] || '', react: newRow['对方反应'] || '',
            nextAction: newRow['下一步动作'] || '', nextDate: newRow['下次跟进时间'] || '', stage: newRow['阶段'] || '',
          },
          extraFlow: extraChangeFlow ? { id: extraChangeFlow['流水ID'], what: extraChangeFlow['沟通内容'] || '', date: extraChangeFlow['日期'] || '' } : null,
          stageFrom, stage: flowStage, stageNote: moveNote, nextStage, autoAdvanced: !!autoStage, levelSynced,
          // 2026-10-29（m03535）：预演也要能看出「按内容落段」推了哪一段，插件/自测都靠这个字段
          stageInferred: inferStage ? (stageFrom ? stageFrom + '→' + inferStage : '→' + inferStage) : '',
        },
        fixed: fixedLog.slice(), args: a,
        message: '只预览，未写盘（主表、流水表都没动）',
      };
    }
    // 2026-09-14 修复: 原来分两次独立原子写(流水先落、主表后落)，主表写失败时流水已落=静默半写；
    //   且 `writeMaster(readMaster().wb, ...)` 是多余重读（拿的是旧 wb）。改为 m.wb + 失败显式回报。
    let flowWritten = false;
    try {
      // 2026-10-13 批次5：命中幂等(isDup)但**又落了独立【信息变更】留痕**时也必须落流水 ——
      //   否则这条新增留痕只留在内存里（主表已改、留痕丢失 = 静默缺口）。
      if (!isDup || extraChangeFlow) { writeFlow(flow.wb, flow.rows, flow.headers); flowWritten = true; }
      writeMaster(m.wb, rows, headers, { addDate1904: false });
    } catch (e) {
      return { ok: false, partial: flowWritten, flowId: flowWritten ? newRow['流水ID'] : '', message: `写Excel失败: ${e.message}${flowWritten ? '（流水已写入，主表未回写；重跑同一条记录即可补齐——已做幂等去重不会重复记账）' : '（两表都未写，可安全重试）'}` };
    }
    // 2026-09-29 行动引擎：回执里直接给"下一张作战卡"（记完这一通，下一步该干什么）
    let nextCard = null;
    try { nextCard = buildActionCard(c, buildActionContext(rows, flow.rows)); } catch (e) { nextCard = null; }
    const stageInferred = inferStage ? (stageFrom ? stageFrom + '→' + inferStage : '→' + inferStage) : '';
    if (isDup) return { ok: true, flowId: newRow['流水ID'], duplicated: true, changeFlowId: extraChangeFlow ? extraChangeFlow['流水ID'] : '', stage: flowStage, stageFrom, stageNote: moveNote, nextStage, autoAdvanced: !!autoStage, stageInferred, levelSynced, nextCard, fixed: fixedLog.slice(), message: `该跟进已存在(流水 ${newRow['流水ID']})，本次只补主表回写，未重复记账${levelSynced ? `；等级随分类归一 ${levelSynced}` : ''}${fixedLog.length ? `；方式/类型已归一（${fixedLog.join('；')}）` : ''}${stageInferred ? `；按内容落段 ${stageInferred}` : ''}` };
    // 2026-10-28（用户 m03270「面板里只展示结果」）：回执不再播报「字段变更另落【信息变更】L####」这类过程信息；
    //   变更留痕仍在库里（id 走 changeFlowId 字段），只是不往面板上摆。
    return { ok: true, flowId: newRow['流水ID'], changeFlowId: extraChangeFlow ? extraChangeFlow['流水ID'] : '', stage: flowStage, stageFrom, stageNote: moveNote, nextStage, autoAdvanced: !!autoStage, stageInferred, levelSynced, nextCard, fixed: fixedLog.slice(), message: `已记录 ${a.id} 跟进，流水 ${newRow['流水ID']}${levelSynced ? `；等级随分类归一 ${levelSynced}` : ''}${fixedLog.length ? `；方式/类型已归一（${fixedLog.join('；')}）` : ''}${stageInferred ? `；按内容落段 ${stageInferred}` : ''}` };
  });
}

// ---------- 命令: 点名结论 sales_settle（结果层的唯一写入口，2026-10-08 用户定）----------
// 用户口径：沉默、阶段停住都算结果，但**必须手动点名**（不做关键词自动判定），且停住必须带「复查锚点」。
// 落点 = 一条【结论】留痕（复用变更留痕机制：不新增主表枚举、不新增状态文件，两表同写）：
//   沟通内容 = 【结论】<结论>｜停在「<段>」｜锚点：<日期或信号>     类型=数据整理、方式留空、日期=发生当天
// 状态映射：沉默等需求→挂起；暂缓/无法联系→挂起冷备；成交签约/推进终止→已闭环
// 阶段映射：成交签约/无法联系/推进终止 → 写对应 SOP 出口；沉默/暂缓 → 停在「X段」（主表阶段为空时才补写，不回退）
// 锚点：沉默等需求/暂缓 **必须给**（无锚点的停住就是黑洞）；三个终态结论可不给（关系已了，无需复查）
const SETTLE_KINDS = Object.assign(Object.create(null), {
  '沉默等需求': { status: '挂起', stage: '', needAnchor: true, label: '沉默（没需求时不搭理，等信号）' },
  '暂缓': { status: '挂起冷备', stage: '', needAnchor: true, label: '暂缓（这一阶段先跟不动了）' },
  '无法联系': { status: '挂起冷备', stage: '无法联系', needAnchor: false, label: '无法联系（电话/微信都够不着）' },
  '推进终止': { status: '已闭环', stage: '推进终止', needAnchor: false, label: '推进终止（明确不做/已换人/竞争丢了）' },
  '成交签约': { status: '已闭环', stage: '成交签约', needAnchor: false, label: '成交签约（成交，转成交后服务）' },
});
function cmdSettle(a) {
  a = a || {};
  const dryRun = a.__dryRun === true;   // 只预览不落盘（settleplan 命令用）
  // 批量模式（D3 黑洞清零）：ids=[...] + 同一 kind/anchor → 逐个点名（每个客户仍走同一套校验与幂等）
  if (Array.isArray(a.ids) && a.ids.length) {
    const ids = Array.from(new Set(a.ids.map(x => String(x || '').trim()).filter(Boolean))).slice(0, 50);
    const done = [], failed = [];
    ids.forEach(x => {
      const r = cmdSettle(Object.assign({}, a, { ids: null, id: x }));
      if (r.ok) done.push({ id: x, name: r.name, flowId: r.flowId, duplicated: !!r.duplicated, result: r.result });
      else failed.push({ id: x, message: r.message });
    });
    return {
      ok: failed.length === 0, batch: true, kind: String(a.kind || '').trim(), count: ids.length, done, failed,
      message: `批量点名「${String(a.kind || '').trim()}」：成功 ${done.length} / 失败 ${failed.length}`
        + (failed.length ? '（失败多是客户不存在或该结论要锚点没给锚点）' : ''),
    };
  }
  if (!a.id) return { ok: false, message: '缺少客户ID(id)' };
  const kind = String(a.kind || '').trim();
  const spec = SETTLE_KINDS[kind];
  if (!spec) return { ok: false, message: `结论不合法: ${a.kind || '(空)'}（应为 ${Object.keys(SETTLE_KINDS).join(' / ')}）` };
  const anchor = String(a.anchor || '').trim();
  if (spec.needAnchor && !anchor) {
    return { ok: false, message: `「${kind}」必须给复查锚点(anchor)：日期(YYYY-MM-DD)或一个信号（如"客户新项目立项/明年3月预算"）。没有锚点的停住=黑洞，不接受` };
  }
  const stuckRaw = a.stuckAt === undefined || a.stuckAt === null ? '' : String(a.stuckAt).trim();
  const stuckIn = stuckRaw ? normStage(stuckRaw) : '';
  // 严格校验（2026-10-08 自查踩坑）：normStage() 对**未知值原样返回**，只判 `!stuckIn` 会把"野段位"
  //   当成合法值写进流水的「阶段」列（check 的非法阶段校验会真报红）→ 必须查 STAGE_SET 表。
  if (stuckRaw && !STAGE_SET[stuckIn]) return { ok: false, message: `停在的阶段不合法: ${stuckRaw}（应为 ${STAGE_MAIN.join('/')}）` };
  if (a.date && !isDateStr(a.date)) return { ok: false, message: `日期格式应为 YYYY-MM-DD，收到: ${a.date}` };

  return withWriteLock(() => {
    const m = readMaster();
    const rows = m.rows, headers = m.headers;
    const id = String(a.id).trim();
    const c = rows.find(r => String(r['客户ID']).trim() === id);
    if (!c) return { ok: false, message: `未找到客户 ${a.id}` };
    const flow = readFlow();
    const date = a.date ? normDateStr(a.date) : today();
    const stageNow = normStage(c['意向阶段']);
    const beforeRow = Object.assign({}, c);   // dryRun 预览用（2026-10-21 夜）
    const stuckAt = spec.stage ? '' : (stuckIn || stageNow);
    const parts = ['【结论】' + kind];
    if (stuckAt) parts.push('停在「' + stuckAt + '」');
    if (anchor) parts.push('锚点：' + anchor);
    if (a.note && String(a.note).trim()) parts.push(String(a.note).trim());
    const what = parts.join('｜');
    // 幂等：同客户+同日+同内容已存在 → 只补主表回写，不重复记账（与 cmdLog 同口径，半写重跑安全）
    const dup = flow.rows.find(f => String(f['客户ID']).trim() === id
      && String(f['日期'] || '').trim() === date && String(f['沟通内容'] || '').trim() === what);
    let newRow = dup;
    if (!dup) {
      newRow = {
        '流水ID': nextFlowId(flow.rows), '客户ID': id, '日期': date, '方式': '', '类型': '数据整理',
        '沟通内容': what, '对方反应': '', '下一步动作': '', '下次跟进时间': '', '下次跟进方式': '',
        '阶段': spec.stage || stuckAt || '',
      };
      flow.rows.push(newRow);
    }
    // ---- 回写主表 ----
    c['跟进状态'] = spec.status;
    if (spec.stage) c['意向阶段'] = spec.stage;
    else if (stuckIn && !stageNow) c['意向阶段'] = stuckIn;   // 只在主表阶段为空时补写，绝不回退已标阶段
    // 复查锚点是日期 → 写进排期（到期当天自动回今日队列/飞轮观察）；只是信号 → 清排期（待定，靠 brief 盯）
    const anchorDate = anchor && isDateStr(anchor) ? normDateStr(anchor) : '';
    if (spec.needAnchor) {
      c['下次跟进时间'] = anchorDate || '';
      if (!anchorDate) c['下次跟进方式'] = '';
    }
    if (a.note && String(a.note).trim()) {
      const nr = String(a.note).trim(), on = String(c['备注'] || '').trim();
      c['备注'] = on ? on + '；' + stamp(date, nr) : stamp(date, nr);
    }
    // 触达状态照旧只认常规流水（【结论】是变更留痕，不算触达证据）
    const custFlows = flow.rows.filter(f => String(f['客户ID']).trim() === id && isFollowRecord(f));
    c['触达状态'] = deriveTouchState(custFlows, c['触达状态']);
    // 2026-10-13 用户定：等级跟着分类走（点名结论会改状态/阶段 → 等级同步归一）
    const lvSync = syncLevelFor(c, flow.rows);
    const levelSynced = lvSync.changed ? `${lvSync.from || '未定级'}→${lvSync.to || '未定级'}` : '';
    // 2026-10-21 夜：dryRun 到此为止——结论/锚点/阶段/幂等全算完，只差落盘。
    if (dryRun) {
      return {
        ok: true, dryRun: true, id, name: String(c['公司'] || c['姓名/联系人'] || ''), kind, duplicated: !!dup,
        preview: {
          before: previewFieldsOf(beforeRow), after: previewFieldsOf(c),
          diff: masterDiff(beforeRow, c), flowId: newRow['流水ID'], what,
          date, status: spec.status, stage: String(c['意向阶段'] || ''), stuckAt, anchor,
          next: String(c['下次跟进时间'] || ''), levelSynced,
        },
        message: '只预览，未写盘（主表、流水表都没动）',
      };
    }
    const w = writeBoth(m, rows, headers, flow, flow.rows, flow.headers);
    if (!w.ok) return { ok: false, partial: w.partial, flowId: w.partial ? newRow['流水ID'] : '', message: w.message };
    const res = sopResultOf(c, flow.rows);
    return {
      ok: true, id, name: c['公司'] || c['姓名/联系人'], flowId: newRow['流水ID'], duplicated: !!dup,
      kind, status: spec.status, stage: String(c['意向阶段'] || ''), stuckAt, anchor, levelSynced,
      next: String(c['下次跟进时间'] || ''), result: res.result, resultLabel: res.progress,
      message: (dup ? `该结论今天已记过（流水 ${newRow['流水ID']}），本次只补主表回写` : `已点名 ${id} 结论：${kind}` + (stuckAt ? `（停在「${stuckAt}」）` : '') + (anchor ? `，复查锚点：${anchor}` : ''))
        + (levelSynced ? `；等级随分类归一 ${levelSynced}` : '')
        + `；现状=结果 ${res.result}` + (res.progress ? `（${res.progress}）` : ''),
    };
  });
}

// ---------- 命令: 企业级推进 sales_enterprise（D3；只给建议 + 台账写入，绝不自动改阶段）----------
// 三种模式（按入参自动选）：① 单个客户推进建议 {id}；② 候选盘点 {pool:true}；③ 写台账 {id, facts:{...}}
function isLikelyConsult(r) { return ENT_CONSULT_RE.test(String(r['公司'] || '')); }
// 候选盘点（纯派生、只读）：升级候选（标品已付费/有消耗）+ 直谈候选（机构型 / S·A 级 / 用量够）
//   判据只用真实字段（付款总额/智写消耗字数/智写文章生成次数/客户等级），机构类型只作提示，不当作结论。
function entCandidateLists(rows, flowRows) {
  const entIdx = indexEnterprise(flowRows);
  const upgrade = [], direct = [];
  rows.forEach(r => {
    const st = String(r['跟进状态'] || '').trim();
    if (st === '已闭环' || st === '挂起冷备') return;
    const stage = normStage(r['意向阶段']);
    if (isExitStage(stage)) return;
    if (stageSeq(stage) >= STAGE_ENT_MIN) return;               // 已在企业级轨，不重复盘点
    const cost = numFrom(r['智写消耗字数']), art = numFrom(r['智写文章生成次数']), paid = numFrom(r['付款总额']);
    const healthy = cost >= ENT_OPP_MIN_COST || art >= ENT_OPP_MIN_ART;
    const id = String(r['客户ID'] || '').trim();
    const ef = entIdx.get(id);
    if (ef && ef.filled) return;                                // 已记过台账的不用再盘点
    const consultHint = isLikelyConsult(r);
    const lvl = String(r['客户等级'] || '').trim();
    const base = { id, name: r['公司'] || r['姓名/联系人'], level: lvl || '未定级', stage: stage || '（未标段位）', cost, art, paid, consultHint };
    if (paid > 0 || cost > 0) {
      upgrade.push(Object.assign({}, base, {
        why: (paid > 0 ? `已付费 ${paid} 元` : '') + (paid > 0 && cost > 0 ? ' + ' : '')
          + (cost > 0 ? `已消耗 ${fmtW(cost)}字` : '') + '，标品已经用起来了 → 谈"企业级落地"',
      }));
    } else if (healthy || consultHint || /^[SA]$/.test(lvl)) {
      direct.push(Object.assign({}, base, {
        why: (healthy ? `用量够（${fmtW(cost)}字/${art}篇）` : '')
          + (consultHint ? (healthy ? ' + ' : '') + '机构型客户（公司名像咨询/设计院）' : '')
          + (/^[SA]$/.test(lvl) ? ((healthy || consultHint) ? ' + ' : '') + `等级 ${lvl}` : '') + ' → 直接谈企业级价值',
      }));
    }
  });
  upgrade.sort((x, y) => (y.paid + y.cost) - (x.paid + x.cost));
  direct.sort((x, y) => (y.cost + y.art * 1000) - (x.cost + x.art * 1000));
  return { upgrade, direct };
}
// 模式三：写企业级台账（【企业级】k=v｜k=v，只落流水表——主表没有对应列，不新增列；合并旧台账，同键覆盖）
function writeEnterpriseLedger(a) {
  const factsIn = a.facts || {};
  const keys = Object.keys(factsIn).map(k => String(k).trim()).filter(k => String(factsIn[k] == null ? '' : factsIn[k]).trim() !== '');
  const bad = keys.filter(k => ENT_FACTS.indexOf(k) < 0);
  if (bad.length) return { ok: false, message: `企业级信息项只认 ${ENT_FACTS.join('/')}；不认识: ${bad.join('/')}（新增信息项要先改标准，别随手造字段）` };
  if (!keys.length) return { ok: false, message: `facts 至少要给一项非空的（${ENT_FACTS.join('/')}）` };
  if (a.date && !isDateStr(a.date)) return { ok: false, message: `日期格式应为 YYYY-MM-DD，收到: ${a.date}` };
  return withWriteLock(() => {
    const m = readMaster();
    const rows = m.rows, headers = m.headers;
    const id = String(a.id || '').trim();
    const c = rows.find(r => String(r['客户ID']).trim() === id);
    if (!c) return { ok: false, message: `未找到客户 ${a.id}` };
    const flow = readFlow();
    const date = a.date ? normDateStr(a.date) : today();
    const old = entFactsOf(flow.rows, id);
    const merged = Object.assign({}, old.facts || {});
    keys.forEach(k => { merged[k] = String(factsIn[k]).trim(); });
    const what = ENT_TAG + ENT_FACTS.filter(k => merged[k]).map(k => k + '=' + merged[k]).join('｜');
    const dup = flow.rows.find(f => String(f['客户ID']).trim() === id
      && String(f['日期'] || '').trim() === date && String(f['沟通内容'] || '').trim() === what);
    let newRow = dup;
    if (!dup) {
      newRow = {
        '流水ID': nextFlowId(flow.rows), '客户ID': id, '日期': date, '方式': '', '类型': '数据整理',
        '沟通内容': what, '对方反应': '', '下一步动作': '', '下次跟进时间': '', '下次跟进方式': '',
        '阶段': normStage(c['意向阶段']) || '',
      };
      flow.rows.push(newRow);
    }
    // 2026-10-13 批次5 审计 F14：本函数**只改流水、不动主表任何字段**，原来却走 writeBoth →
    //   每次记台账都把 31 列主表整表重写一遍（多一次 971KB 级原子写 + rename 窗口），
    //   也与标准 §14.2「企业级只写流水、不动主表」的字面口径不符 → 改为单写流水。
    try {
      writeFlow(flow.wb, flow.rows, flow.headers);
    } catch (e) {
      return { ok: false, partial: false, flowId: '', message: `写Excel失败: ${e.message}（未改主表，可安全重试）` };
    }
    const missing = ENT_FACTS.filter(k => !merged[k]);
    return {
      ok: true, id, name: c['公司'] || c['姓名/联系人'], flowId: newRow['流水ID'], duplicated: !!dup,
      recorded: keys, facts: merged, missing, complete: missing.length === 0,
      message: (dup ? `该台账今天已记过（流水 ${newRow['流水ID']}）` : `已记 ${id} 企业级台账：${keys.join('/')}`)
        + (missing.length ? `；还缺 ${missing.join('/')}` : '；⚠️ 对照五件套已齐（但别把客户信息用于任何外部渠道）'),
    };
  });
}
function cmdEnterprise(a) {
  a = a || {};
  if (a.facts && typeof a.facts === 'object') return writeEnterpriseLedger(a);
  const ctx = buildActionContext();
  const rows = ctx.rows, flowRows = ctx.flowRows;
  const entIdx = ctx.entIdx || indexEnterprise(flowRows);
  const limit = Math.max(1, Math.min(50, Number(a.limit) || 20));
  // 模式二：候选盘点（只给建议；判据=真实用量/付费/等级，机构类型只做排序提示）
  if (a.pool || a.mode === 'pool' || !a.id) {
    const lists = entCandidateLists(rows, flowRows);
    const upgrade = lists.upgrade, direct = lists.direct;
    return {
      ok: true, mode: 'pool', date: today(),
      scanned: rows.length,
      counts: { upgrade: upgrade.length, direct: direct.length },
      upgrade: upgrade.slice(0, limit), direct: direct.slice(0, limit),
      message: `企业级候选：升级 ${upgrade.length} 个（已付费/有消耗，标品已用起来）+ 直谈 ${direct.length} 个（机构型或 S/A 级）`
        + `；候选只给建议，**要进企业级轨请自己点名段位**（sales_log 传 stage=企业级机会，或先聊一次再说）`,
    };
  }
  // 模式一：单客户推进建议
  const k = String(a.id).trim();
  const c = rows.find(r => String(r['客户ID']).trim() === k)
    || rows.find(r => [r['客户ID'], r['公司'], r['姓名/联系人'], r['手机'], r['微信昵称']].join(' ').toLowerCase().includes(k.toLowerCase()));
  if (!c) return { ok: false, message: '未找到客户 ' + a.id };
  const id = String(c['客户ID']).trim();
  const stage = normStage(c['意向阶段']);
  const seqE = stageSeq(stage);
  const inEnt = seqE >= STAGE_ENT_MIN;
  const rr = sopResultOf(c, flowRows);
  const cost = numFrom(c['智写消耗字数']), art = numFrom(c['智写文章生成次数']), paid = numFrom(c['付款总额']);
  const healthy = cost >= ENT_OPP_MIN_COST || art >= ENT_OPP_MIN_ART;
  const ef = entIdx.get(id) || entFactsOf(flowRows, id);
  const facts = ef.facts || {}, missing = ENT_FACTS.filter(x => !facts[x]);
  const nextStage = inEnt ? (ENT_STAGE_SCENE[stage] || '企业级机会') : '企业级机会';
  const scene = inEnt ? (ENT_STAGE_SCENE[stage] || '企业级推进') : '企业级机会';
  const flows = ctx.byCust.get(id) || [];
  const last = flows.length ? flows[flows.length - 1] : null;
  const tip = pickTipByScene(scene, new Set());
  const script = buildFollowScript(scene, tip, last, c);
  const route = inEnt ? `已在企业级轨（段位：${stage}）`
    : (paid > 0 || cost > 0 ? '升级：标品已用/已付费 → 谈企业级落地'
      : (isLikelyConsult(c) ? '直谈：机构型客户（公司名像咨询/设计院）→ 先谈企业级价值'
        : '先标品：还没有用量证据，先让他把标品用起来'));
  return {
    ok: true, mode: 'client', id, name: c['公司'] || c['姓名/联系人'], level: c['客户等级'] || '未定级',
    track: sopTrackOf(c, flowRows), route, stage: stage || '（未标段位）', result: rr.result,
    nextStage, next3: ENT_NEXT3[nextStage] || ENT_NEXT3['企业级机会'], material: ENT_MATERIALS[nextStage] || '',
    evidence: { 付款总额: paid, 智写消耗字数: cost, 智写文章生成次数: art, 到期时间: normDateStr(c['到期时间']) || '', 用量够企业级谈资: healthy },
    ledger: { facts, missing, filled: ENT_FACTS.length - missing.length, hasAny: Object.keys(facts).length > 0, lastDate: ef.date || '' },
    // 素材文件（话术要点来源；**不含客户信息**）
    sourceFile: '营销资料库/企业级落地要点.md',
    script,
  };
}

// ---------- 命令: 飞轮管理 sales_flywheel（2026-10-08 D4）----------
// 飞轮 = 13 段环（标品 7 + 企业级 6）+ 2 个**不占阶段**的售后环（成交后服务 / 转介绍与复购）。
//   ring.count    = 现在停在这一环的客户数（主表当前段位）
//   ring.reached  = 累计到过这一环的客户数（主表段位 与 流水中出现过的段位 取最大 —— 走到过就算）
//   ring.convRate = 上一环 → 本环 的转化率（本环 reached / 上一环 reached）
//   ring.stalled  = 停在这一环、静默超过该环阈值（STALL_DAYS）的客户数 → 这就是"该推一把的人"
// 全部派生自两表，绝不新增列/状态文件；转介绍环来自【介绍】留痕（writeReferral）。
const FW_DEFAULT_STALL = 30;   // 成交签约这类长周期/售后段没有停滞阈值时兜底
// 每一环"该做的一件事"（停滞时给可执行动作；企业级环用 ENT_NEXT3 的第一条）
const STD_NEXT_DO = {
  '线索获取': '首触：今天挑 10 个新线索打电话（sales_plan 的"首次触达"队列）',
  '客户触达': '没加上微信的先加微信；打不通的换时段再打一轮，别让线索停在"没接触"',
  '需求挖掘': '问清"现在这块怎么做、哪一步最费时间"，把需求落成一句话',
  '产品演示': '约一次演示或试用回访，让他真的用一次——用起来才算数',
  '异议处理': '把异议原话记下来，给一条可验证的答复，顺手约下一次',
  '方案报价': '报价后 3 天内确认"收到没、卡在哪一条"，别等',
  '成交签约': '把合同/付款节点往前推一步；成交后转「成交后服务」池养续费与扩展',
};
function flywheelReport(preRows, preFlowRows) {
  const ctx = buildActionContext(preRows, preFlowRows);
  const rows = ctx.rows || [], flowRows = ctx.flowRows || [], T = ctx.T || today();
  const touchIdx = ctx.touchIdx || indexLastTouch(flowRows);
  const ref = indexReferral(flowRows, rows);
  const idOf = (r) => String((r && r['客户ID']) || '').trim();
  // 每个客户的"到过的最深一段"（主表当前段位 vs 流水里出现过的段位，取大）
  const maxSeq = new Map(), byCust = new Map();
  rows.forEach(r => {
    const id = idOf(r);
    maxSeq.set(id, stageSeq(normStage(r['意向阶段'])));
    byCust.set(id, []);
  });
  flowRows.forEach(f => {
    const id = String(f['客户ID'] || '').trim();
    if (!byCust.has(id)) return;                        // 孤儿流水不算（check 会单独报）
    byCust.get(id).push(f);
  });
  rows.forEach(r => {
    const id = idOf(r);
    (byCust.get(id) || []).forEach(f => { const s = stageSeq(normStage(f['阶段'])); if (s > maxSeq.get(id)) maxSeq.set(id, s); });
  });
  const silentOf = (r) => {
    const last = String(touchIdx.get(idOf(r)) || '');
    const d = last ? dayDiffStr(T, last) : null;
    return d === null ? 9999 : d;                       // 从没常规跟过 = 无限静默
  };
  const rings = STAGE_MAIN.map((s, i) => {
    const seq = i + 1;
    const here = rows.filter(r => normStage(r['意向阶段']) === s);
    const reached = rows.filter(r => (maxSeq.get(idOf(r)) || 0) >= seq);
    // 2026-10-08 审计 A12：reached 是"走到过就算"的**上界**（跳段客户会把中间每一环都算一次），
    //   convRate 因此可能虚高。口径本身是用户定的（累计到过），不推翻；这里额外给一个
    //   `observed` = **主表最终段位就停在这一环**的客户数，让跳段看得见（观察用，不参与转化率）。
    const observed = rows.filter(r => (maxSeq.get(idOf(r)) || 0) === seq).length;
    const sil = here.map(silentOf);
    const limit = STALL_DAYS[s] || FW_DEFAULT_STALL;
    const stalled = here.filter((r, j) => sil[j] >= limit);
    return {
      ring: s, seq, scope: seq <= STAGE_STD.length ? '标品' : '企业级',
      count: here.length, reached: reached.length, observed,
      stalled: stalled.length, stalledIds: stalled.slice(0, 3).map(idOf),
      avgSilent: sil.length ? Math.round(sil.reduce((a, b) => a + Math.min(b, 365), 0) / sil.length) : 0,
      limit,
    };
  });
  rings.forEach((r, i) => {
    const prev = rings[i - 1];
    r.convRate = i === 0 ? 100 : (prev.reached ? Math.round(r.reached / prev.reached * 100) : 0);
    r.do = r.stalled ? (ENT_NEXT3[r.ring] || [])[0] || STD_NEXT_DO[r.ring] || '把卡在这一环的客户挑 3 个，今天各推一步' : '';
  });
  const payers = rows.filter(r => isPayer(r));
  // 不在 13 环里的两类（出口/未标段位）必须显式报出来 —— 否则"环合计 ≠ 客户数"就成了藏人的地方
  const exitN = rows.filter(r => isExitStage(normStage(r['意向阶段']))).length;
  const noStageN = rows.filter(r => !STAGE_SET[normStage(r['意向阶段'])]).length;
  const refIds = new Set();
  ref.pairs.forEach(p => { if (p.byId) refIds.add(p.byId); if (p.toId) refIds.add(p.toId); });
  const closedWin = rows.filter(r => String(r['跟进状态'] || '').trim() === '已闭环' && normStage(r['意向阶段']) === '成交签约');
  const after = [
    { ring: '成交后服务', count: payers.length, basis: '已付费客户（付款总额>0）——交付/扩展/续费池', ids: payers.slice(0, 3).map(idOf) },
    { ring: '转介绍与复购', count: refIds.size, basis: '有【介绍】留痕关系的在册客户（介绍人∪被介绍人）', ids: Array.from(refIds).slice(0, 3) },
  ];
  // 瓶颈环 = 有实际人流、但往下漏得最狠的一环（reached=0 的空环不算瓶颈，那叫"还没走到"）
  const cand = rings.filter(r => r.seq > 1 && r.reached > 0 && rings[r.seq - 2].reached > 0);
  const bottleneck = cand.slice().sort((a, b) => a.convRate - b.convRate)[0] || null;
  const action = rings.filter(r => r.stalled > 0).sort((a, b) => b.stalled - a.stalled).slice(0, 3)
    .map(r => ({ ring: r.ring, stalled: r.stalled, ids: r.stalledIds, do: r.do }));
  return {
    ok: true, date: T,
    rings, after,
    bottleneck: bottleneck ? {
      ring: bottleneck.ring, convRate: bottleneck.convRate, reached: bottleneck.reached,
      lost: rings[bottleneck.seq - 2].reached - bottleneck.reached,
      do: bottleneck.do || '把上一环的客户先推一步：一轮只解决一个卡点',
    } : null,
    action,
    referral: { pairs: ref.pairCount, half: ref.halfCount, referrers: ref.referrers.slice(0, 5), share: rows.length ? Math.round(refIds.size / rows.length * 1000) / 10 : 0 },
    loop: {
      master: rows.length, payers: payers.length, closedWin: closedWin.length,
      endReached: rings[rings.length - 1].reached,
      ringsSum: rings.reduce((a, r) => a + r.count, 0),
      offRings: { exit: exitN, noStage: noStageN },   // 环外两类：出口（无法联系/推进终止）+ 没标段位
      message: `飞轮：进池 ${rows.length} → 走到末环（私有化签约）${rings[rings.length - 1].reached} → 成交后服务池 ${payers.length} → 转介绍关系 ${refIds.size}`
        + `；环内 ${rings.reduce((a, r) => a + r.count, 0)} + 出口 ${exitN} + 未标段位 ${noStageN} = ${rows.length}`,
    },
  };
}
function cmdFlywheel(a) {
  a = a || {};
  // 模式二：记一笔转介绍留痕（{referral:true,id,by,to,note,date}，或直接给 by/to）
  if (a.referral || a.by || a.to) return writeReferral(a);
  const rep = flywheelReport();
  // 模式三：只看某一环（{ring:'方案报价'}）
  if (a.ring) {
    const r = rep.rings.find(x => x.ring === String(a.ring).trim());
    if (!r) return { ok: false, message: `环名不合法: ${a.ring}（应为 ${STAGE_MAIN.join('/')}）` };
    return { ok: true, date: rep.date, ring: r, message: `「${r.ring}」现在 ${r.count} 个（累计到过 ${r.reached}），停滞 ${r.stalled} 个、平均静默 ${r.avgSilent} 天（阈值 ${r.limit} 天）${r.do ? '；该做：' + r.do : ''}` };
  }
  return rep;
}

// ---------- 命令: 周战役 sales_campaign（D5，2026-10-08 用户总体计划）----------
// 一周三批、各 20 条（用户口径：电话 20 + 微信 20 + 培育轻触达 20），三批**互不占额度**：
//   ① 电话批 = buildQueue 里 T1/T2 且手机号合法 → 真打电话（占电话额度）
//   ② 微信批 = T3 批量触达 / 无手机号 → 微信·短信长尾（**不占电话额度**）
//   ③ 培育批 = 培育池（【结论】=暂缓）到点优先，不足才提前一次（标 ahead:true）—— 不催单、不占电话额度
// **纯派生、绝不写盘**：落实后按条走 sales_log 记账（回执照给 log 示例）。
// 铁律：培育池客户绝不进电话队列（不变量 #27）；三批合计超过日额度也不许合并成一批。
const CAMPAIGN_QUOTA = { phone: 20, wechat: 20, nurture: 20 };
function campaignReport(a, preCtx) {
  a = a || {};
  const cap = (v, d) => (Number(v) > 0 ? Math.min(50, Math.floor(Number(v))) : d);
  const quota = { phone: cap(a.phone, CAMPAIGN_QUOTA.phone), wechat: cap(a.wechat, CAMPAIGN_QUOTA.wechat), nurture: cap(a.nurture, CAMPAIGN_QUOTA.nurture) };
  const ctx = preCtx || buildActionContext();
  const rows = ctx.rows, flowRows = ctx.flowRows;
  const nm = (r) => (r && (r['公司'] || r['姓名/联系人'])) || '';
  const hasPhone = (r) => /^1\d{10}$/.test(String((r && r['手机']) || '').trim());
  const pack = (x) => {
    const r = x.r, card = x.card;
    const id = String(r['客户ID'] || '').trim();
    const flows = ctx.byCust.get(id) || [];
    return {
      id, name: nm(r), level: r['客户等级'] || '未定级', stage: normStage(r['意向阶段']),
      result: sopResultOf(r, flowRows).result, phone: String(r['手机'] || ''), wechat: r['微信昵称'] || '',
      tier: card.tier, action: card.action, why: card.why, scene: card.scene || '',
      script: buildHow(card, r, flows.length ? flows[flows.length - 1] : null),
    };
  };
  const queued = buildQueue(ctx);
  const phoneList = queued.filter(x => x.card && x.card.tier !== 'T3' && hasPhone(x.r)).slice(0, quota.phone).map(pack);
  const wechatList = queued.filter(x => x.card && (x.card.tier === 'T3' || !hasPhone(x.r))).slice(0, quota.wechat).map(pack);
  const pool = nurtureList(ctx, { all: true });
  const packNrt = (x) => ({
    id: x.id, name: x.name, level: x.level, channel: x.channel, scene: x.scene, due: x.due, ahead: !x.due,
    anchor: x.anchor, stuckAt: x.stuckAt, days: x.days, nextDue: x.nextDue, why: x.why, script: x.script,
  });
  const nrtOut = pool.slice().sort((x, y) => (y.due ? 1 : 0) - (x.due ? 1 : 0) || (y.days === null ? -1 : y.days) - (x.days === null ? -1 : x.days) || String(x.id).localeCompare(String(y.id))).slice(0, quota.nurture).map(packNrt);
  return {
    ok: true, mode: 'campaign', date: ctx.T, from: datePlusDays(ctx.T, -6), to: ctx.T, quota,
    phone: { channel: '电话', quota: quota.phone, count: phoneList.length, list: phoneList },
    wechat: { channel: '微信/短信', quota: quota.wechat, count: wechatList.length, list: wechatList },
    nurture: { channel: '微信/短信(轻触达)', quota: quota.nurture, count: nrtOut.length, list: nrtOut, pool: pool.length, due: pool.filter(x => x.due).length },
    log: {
      phone: "sales_log({id:'<客户ID>', method:'电话', type:'首触', what:'<聊了什么>', react:'<对方反应>', nextAction:'<下一步>', nextDate:'YYYY-MM-DD'})",
      wechat: "sales_log({id:'<客户ID>', method:'微信', type:'老客服务', what:'<批量触达说了什么>', ... })",
      nurture: "sales_log({id:'<客户ID>', method:'微信', type:'老客服务', what:'发行业简报/新功能', ... })",
    },
    rules: [
      `电话批 ≤ ${quota.phone} 条、微信批 ≤ ${quota.wechat} 条（不占电话额度）、培育批 ≤ ${quota.nurture} 条（轻触达、不催单）`,
      '培育池客户绝不进电话队列（不变量 #27）；培育批到点才发，不足才提前一次并标 ahead',
      '本命令纯派生不写盘；每条落实后必须 sales_log 记账（两表留痕，不变量 #21）',
    ],
  };
}
function cmdCampaign(a) {
  const rep = campaignReport(a || {});
  return Object.assign(rep, {
    message: `周战役（${rep.from} → ${rep.to}）：电话 ${rep.phone.count}/${rep.phone.quota} 条 + 微信 ${rep.wechat.count}/${rep.wechat.quota} 条 + 培育轻触达 ${rep.nurture.count}/${rep.nurture.quota} 条（培育池共 ${rep.nurture.pool} 个、到点 ${rep.nurture.due} 个）；三批互不占额度，落实后按条 sales_log 记账`,
  });
}

// ---------- 命令: 周复盘 sales_digest（D5，2026-10-08）----------
// 用户口径「AI 替我干数据整理」：把"这段时间到底发生了什么"从两张表里**现算**出来
// （不编、不缓存、不改盘）。窗口 = [from, to] 闭区间，days 默认 7（含今天）。
function digestReport(a, preCtx) {
  a = a || {};
  const days = Math.min(90, Math.max(1, Math.floor(Number(a.days) || 7)));
  const ctx = preCtx || buildActionContext();
  const rows = ctx.rows, flowRows = ctx.flowRows;
  const T = normDateStr(a.date) || ctx.T;
  const from = datePlusDays(T, -(days - 1));
  const d10 = (v) => normDateStr(v) || String(v || '').slice(0, 10);   // 统一走 normDateStr：Excel 序列号/8 位数字型日期都归一
  const inWin = (v) => { const s = d10(v); return s.length === 10 && s >= from && s <= T; };
  const nm = (r) => (r && (r['公司'] || r['姓名/联系人'])) || '';
  const byId = new Map(rows.map(r => [String(r['客户ID'] || '').trim(), r]));
  const cnt = (list, keyFn) => { const o = {}; list.forEach(f => { const k = keyFn(f); o[k] = (o[k] || 0) + 1; }); return o; };
  const follows = flowRows.filter(f => isFollowRecord(f) && inWin(f['日期']));
  const changes = flowRows.filter(f => isChangeRecord(f) && inWin(f['日期']));
  const newCustomers = rows.filter(r => inWin(normDateStr(r['建档日期'])));
  const touched = new Set(follows.map(f => String(f['客户ID'] || '').trim()).filter(Boolean));   // 真碰过的客户（常规跟进才算）
  // 段位推进 = 窗口内到过的最深段 > 窗口前到过的最深段（"到过就算"，与飞轮同口径）
  const before = new Map(), inwin = new Map(), when = new Map();
  flowRows.filter(isFollowRecord).forEach(f => {
    const id = String(f['客户ID'] || '').trim();
    const seq = stageSeq(f['阶段']);
    if (!id || !seq) return;
    const d = d10(f['日期']);
    if (!inWin(f['日期'])) { if (d && d < from && seq > (before.get(id) || 0)) before.set(id, seq); return; }
    if (seq > (inwin.get(id) || 0)) { inwin.set(id, seq); when.set(id, d); }
  });
  const stageName = (seq) => (seq > 0 ? STAGE_MAIN[seq - 1] : '(未标注)');
  const advanced = [];
  inwin.forEach((seq, id) => {
    const b = before.get(id) || 0;
    if (seq > b) advanced.push({ id, name: nm(byId.get(id)), from: stageName(b), to: stageName(seq), date: when.get(id) || '' });
  });
  advanced.sort((x, y) => String(y.date).localeCompare(String(x.date)) || String(x.id).localeCompare(String(y.id)));
  // 结论（【结论】留痕）/ 转介绍（【介绍】成对）
  const cByKind = {}, conclList = [];
  changes.forEach(f => {
    const c = parseConclusion(f);
    if (!c) return;
    cByKind[c.kind] = (cByKind[c.kind] || 0) + 1;
    const id = String(f['客户ID'] || '').trim();
    conclList.push({ id, name: nm(byId.get(id)), kind: c.kind, stuckAt: c.stuckAt, anchor: c.anchor, date: d10(f['日期']) });
  });
  const refIdx = indexReferral(flowRows, rows);
  const refWin = changes.filter(f => String(f['沟通内容'] || '').indexOf(REF_TAG) === 0 && inWin(f['日期'])).length;
  // 结果分布（八桶）+ 黑洞（现在）+ 本周清掉的黑洞（结论落在停住类/出口类）
  const results = {}; RESULT_ALL.forEach(k => { results[k] = 0; });
  const blackhole = [];
  rows.forEach(r => {
    const rr = sopResultOf(r, flowRows);
    results[rr.result] = (results[rr.result] || 0) + 1;
    if (rr.result === '停住·无锚点') blackhole.push({ id: String(r['客户ID'] || '').trim(), name: nm(r), stage: rr.stuckAt, status: String(r['跟进状态'] || '') });
  });
  // 2026-10-08 审计 A11：原口径 = 窗口内所有"停住类"结论之和 → **重复点名会重复计入**（同一客户先后写两条
  //   【结论】，第二次点名时他早就不是黑洞了），"清掉的黑洞"因此虚高。现在只认**该客户的第一条【结论】**
  //   （先扫全表定出每人的首条结论日期，再挑窗口内且等于首条的那些；同一客户只计一次）。
  const firstConcl = new Map();
  flowRows.forEach(f => {
    if (!parseConclusion(f)) return;
    const id = String(f['客户ID'] || '').trim();
    const d = d10(f['日期']);
    if (!id || !d) return;
    const cur = firstConcl.get(id);
    if (cur === undefined || d < cur) firstConcl.set(id, d);
  });
  const clearedIds = new Set();
  changes.forEach(f => {
    const c = parseConclusion(f);
    if (!c || ['沉默等需求', '暂缓', '无法联系', '推进终止'].indexOf(c.kind) < 0) return;
    const id = String(f['客户ID'] || '').trim();
    if (!id || clearedIds.has(id)) return;
    if (firstConcl.get(id) === d10(f['日期'])) clearedIds.add(id);
  });
  const clearedBlackhole = clearedIds.size;
  const fw = flywheelReport(rows, flowRows);
  const nrt = nurtureInfo(ctx);
  const next = campaignReport({}, ctx);
  return {
    ok: true, mode: 'digest', date: T, from, to: T, days,
    totals: {
      customers: rows.length, flowRows: flowRows.length, newCustomers: newCustomers.length,
      followUps: follows.length, changeRecords: changes.length, touched: touched.size, referralRecords: refWin,
    },
    followByType: cnt(follows, f => String(f['类型'] || '(未填)').trim() || '(未填)'),
    followByMethod: cnt(follows, f => String(f['方式'] || '(未填)').trim() || '(未填)'),
    advanced: { count: advanced.length, list: advanced.slice(0, 20) },
    conclusions: { count: conclList.length, byKind: cByKind, list: conclList.slice(0, 20), clearedBlackhole },
    results,
    blackhole: { now: blackhole.length, top: blackhole.slice(0, 10) },
    referral: { pairs: refIdx.pairs, half: refIdx.half, thisWeek: refWin, top: refIdx.referrers.slice(0, 5) },
    funnel: { bottleneck: fw.bottleneck, action: fw.action, after: fw.after, loop: fw.loop },
    nurture: { pool: nrt.pool, due: nrt.due, cadenceDays: nrt.cadenceDays },
    nextWeek: { phone: next.phone.count, wechat: next.wechat.count, nurture: next.nurture.count, quota: next.quota, firstThree: next.phone.list.slice(0, 3) },
  };
}
function cmdDigest(a) {
  const rep = digestReport(a || {});
  return Object.assign(rep, {
    message: `周复盘（${rep.from} → ${rep.to}）：新增客户 ${rep.totals.newCustomers}、常规跟进 ${rep.totals.followUps} 条（碰到 ${rep.totals.touched} 个客户）、推进段位 ${rep.advanced.count} 个、结论 ${rep.conclusions.count} 条（清黑洞 ${rep.conclusions.clearedBlackhole}）；现在黑洞 ${rep.blackhole.now} 个、培育池 ${rep.nurture.pool} 个（到点 ${rep.nurture.due}）；下周战役：电话 ${rep.nextWeek.phone} + 微信 ${rep.nextWeek.wechat} + 培育 ${rep.nextWeek.nurture}（先打前 3 个：${rep.nextWeek.firstThree.map(x => x.name || x.id).join('、') || '无'}）`,
  });
}

// ---------- 命令: 数据体检 (只读，不改数据) ----------
// 用途: 检测主表/流水表字段错位、孤儿流水、无流水客户、触达状态与流水不一致等异常。
// 触发场景: 任何"客户列表/分区突然变空"、"手动改过 xlsx"、"怀疑数据丢失"时先跑一遍，
//   输出 ok:true 并列出问题；有错位/结构异常时 ok:false。
function cmdCheck() {
  const master = readMaster();
  const flow = readFlow();
  const problems = []; // 真问题 → 决定 ok
  const info = [];     // 正常业务态 → 不决定 ok（如"未触达客户没有流水"）
  // MST/FLT/CT 已提升到模块级表头契约（单一事实源，避免新增字段漏改一处）

  // ① 表头字段是否齐全（缺字段=字段错位或结构损坏）
  const mh = master.headers || [];
  const fh = flow.headers || [];
  MST.forEach(k => { if (!mh.includes(k)) problems.push(`主表缺字段: ${k}`); });
  FLT.forEach(k => { if (!fh.includes(k)) problems.push(`流水表缺字段: ${k}`); });

  // ② 行级脏检查：某行关键字段为空的异常
  const blankRow = (r, keys) => keys.some(k => !String(r[k] || '').trim());
  let mb = 0, fb = 0;
  master.rows.forEach(r => { if (blankRow(r, ['客户ID'])) mb++; });
  flow.rows.forEach(r => { if (blankRow(r, ['流水ID','客户ID'])) fb++; });
  if (mb) problems.push(`主表有 ${mb} 行缺客户ID`);
  if (fb) problems.push(`流水表有 ${fb} 行缺流水ID或客户ID`);

  // ③ 孤儿流水：流水里有但主表没有
  // 2026-10-13 批次5 审计 P0-1：删除收口后，被删客户会留下【删除】墓碑（主表已无此人 = 天然"孤儿"）。
  //   墓碑本身就声明"这个客户是已知删除的" → 该ID的流水不算孤儿，只进 info；**没有墓碑的孤儿照旧报红**（闸门不放宽）。
  const mIds = new Set(master.rows.map(r => String(r['客户ID']).trim()).filter(Boolean));
  const fIds = new Set(flow.rows.map(r => String(r['客户ID']).trim()).filter(Boolean));
  const tombIds = new Set(flow.rows
    .filter(f => /^【删除】/.test(String(f['沟通内容'] || '').trim()))
    .map(f => String(f['客户ID']).trim()).filter(Boolean));
  const orphanAll = [...fIds].filter(id => !mIds.has(id));
  const orphan = orphanAll.filter(id => !tombIds.has(id));          // 真孤儿 → problems
  const orphanTomb = orphanAll.filter(id => tombIds.has(id));       // 已删除客户留存流水/墓碑 → info
  if (orphan.length) problems.push(`孤儿流水(主表无此客户): ${orphan.slice(0,8).join(',')}${orphan.length>8?'…':''} (${orphan.length}个)`);
  if (orphanTomb.length) info.push(`已删除客户留存流水 ${orphanTomb.length} 个客户ID（有【删除】墓碑，可后查；不计孤儿）: ${orphanTomb.slice(0,8).join(',')}${orphanTomb.length>8?'…':''}`);

  // ④ 主表客户无任何流水 —— 2026-09-14 (t6/G2) 按跟进状态拆两桶：
  //    a) 状态「待首触」或空 + 0 流水 → 正常业务态（还没被触达过），进 info，不置 ok:false
  //       挂起冷备/已闭环 本就不要求流水，同样只进 info（措辞注明）。
  //       （避免回到"check 恒红 = 没人看"的老毛病）
  //    b) 状态「跟进中」+ 0 流水 → 异常信号：该有流水却没有，疑似历史丢流水 → 进 warnings，
  //       措辞绝不写"正常"；ok 仍为 true（这是既成事实，不该让体检永久变红），但信号显式可见，报给用户定夺。
  const noFlowAll = [...mIds].filter(id => !fIds.has(id));
  const statusOf = new Map(master.rows.map(r => [String(r['客户ID']).trim(), String(r['跟进状态'] || '').trim()]));
  const noFlowUntouched = noFlowAll.filter(id => { const s = statusOf.get(id); return s === '待首触' || s === ''; });
  // 2026-09-23: 2026-09-18 口径允许「只补身份/排期、未直接接触 → 不落流水」，这类客户必然表现为
  //   跟进中 + 0 流水，若仍按"疑似历史丢流水"报，看板会永久挂一条假警告、把真丢流水淹掉。
  //   口径: 备注里注明了「未直接接触」的属正常态 → info；其余（没说清为什么没流水）照旧进 warnings。
  const noteOf = new Map(master.rows.map(r => [String(r['客户ID']).trim(), String(r['备注'] || '')]));
  const noContactNoFlow = (id) => noteOf.get(id).indexOf('未直接接触') >= 0;
  // 2026-09-24: 「挂起」= 已接触过但没定时间 → 与「跟进中」同口径，都该有流水，0 流水同样可疑
  const noFlowInProgress = noFlowAll.filter(id => { const s = statusOf.get(id); return s === '跟进中' || s === '挂起'; });
  const noFlowInProgressByDesign = noFlowInProgress.filter(noContactNoFlow);
  const noFlowInProgressSuspect = noFlowInProgress.filter(id => !noContactNoFlow(id));
  const noFlowCold = noFlowAll.filter(id => { const s = statusOf.get(id); return s === '挂起冷备' || s === '已闭环'; });
  if (noFlowUntouched.length) info.push(`待首触/空状态客户尚无流水(正常未触达态): ${noFlowUntouched.slice(0,8).join(',')}${noFlowUntouched.length>8?'…':''} (${noFlowUntouched.length}个)`);
  if (noFlowCold.length) info.push(`挂起冷备/已闭环且无流水(该状态本就不要求流水): ${noFlowCold.slice(0,8).join(',')}${noFlowCold.length>8?'…':''} (${noFlowCold.length}个)`);
  if (noFlowInProgressByDesign.length) info.push(`跟进中/挂起但0流水·已注明未直接接触(按 9-18 口径只补身份/排期，正常态): ${noFlowInProgressByDesign.slice(0,8).join(',')}${noFlowInProgressByDesign.length>8?'…':''} (${noFlowInProgressByDesign.length}个)`);
  const warnings = [];
  if (noFlowInProgressSuspect.length) warnings.push(`跟进中/挂起但0流水(该有流水却没有，疑似历史丢流水): ${noFlowInProgressSuspect.slice(0,8).join(',')}${noFlowInProgressSuspect.length>8?'…':''} (${noFlowInProgressSuspect.length}个)`);

  // ⑤ 触达状态与流水不一致（2026-10-20 新口径：申请加微信 ≠ 已加微信，见 deriveTouchState）
  const wechat = new Set();
  const fFollowIds = new Set();
  const flowsById = new Map();
  flow.rows.forEach(f => {
    if (!isFollowRecord(f)) return;      // 2026-09-29: 【…】变更留痕不算触达证据
    const id = String(f['客户ID']).trim();
    fFollowIds.add(id);
    if (!flowsById.has(id)) flowsById.set(id, []);
    flowsById.get(id).push(f);
    if (String(f['方式'] || '').indexOf('微信') >= 0) wechat.add(id);
  });
  let touchDiff = [], touchCount = 0, wechatPending = [];
  master.rows.forEach(r => {
    const id = String(r['客户ID']).trim();
    const expect = wechat.has(id) ? deriveTouchState(flowsById.get(id) || [], r['触达状态']) : (fFollowIds.has(id) ? '已触达' : '未触达');
    const actual = String(r['触达状态'] || '').trim();
    // 历史「已加微信」但流水里只有"申请/待通过/无法举证"：不再判红（不替用户翻旧账），单独列为待他确认的提示
    if (actual === '已加微信' && expect === '待微信通过') { wechatPending.push(id); return; }
    if (actual !== expect) { touchDiff.push(`${id}:表=${actual||'空'}→应为${expect}`); touchCount++; }
  });
  if (touchCount) problems.push(`触达状态与流水不符: ${touchDiff.slice(0,5).join('; ')}${touchDiff.length>5?'…':''} (${touchCount}个)`);
  if (wechatPending.length) warnings.push(`主表=已加微信但流水只写到"申请/待通过/没写清"（新口径应为「待微信通过」，等你点名再改）: ${wechatPending.slice(0,8).join(',')}${wechatPending.length>8?'…':''} (${wechatPending.length}个)`);

  // ⑥ SOP 阶段合法性（2026-09-29）: 主表当前阶段 / 流水阶段 只能是「13 段 + 2 出口」或空（2026-10-08 审计 A19 更正段数）。
  //    旧别名(兴趣/已诊断/申请智算试用/成交/签约/试用/预约演示/价值传递/触达)也算问题——迁移后必须干净，留着就是漏迁。
  const stageBadM = [], stageBadF = [];
  master.rows.forEach(r => {
    const raw = String(r['意向阶段'] == null ? '' : r['意向阶段']).trim();
    if (raw && !STAGE_SET[raw]) stageBadM.push(String(r['客户ID']).trim() + ':' + raw);
  });
  flow.rows.forEach(f => {
    const raw = String(f['阶段'] == null ? '' : f['阶段']).trim();
    if (raw && !STAGE_SET[raw]) stageBadF.push(String(f['流水ID']).trim() + ':' + raw);
  });
  if (stageBadM.length) problems.push(`主表「意向阶段」有非法/未迁移值(${stageBadM.length}个): ${stageBadM.slice(0,6).join('; ')}${stageBadM.length>6?'…':''}`);
  if (stageBadF.length) problems.push(`流水「阶段」有非法值(${stageBadF.length}个): ${stageBadF.slice(0,6).join('; ')}${stageBadF.length>6?'…':''}`);
  const stageUnlabeled = flow.rows.filter(f => !STAGE_SET[String(f['阶段'] == null ? '' : f['阶段']).trim()]).length;
  if (stageUnlabeled) info.push(`流水未标注 SOP 阶段(历史数据/尚未纳入 SOP，正常态): ${stageUnlabeled} 条 / 共 ${flow.rows.length} 条`);
  // ⑥·b 阶段与流水一致性（2026-09-29 新增）: 走到「客户触达」及以后的客户，必须至少有一条流水。
  //   「意向阶段」是当前阶段、「流水」是事实；只有阶段没有流水 = 状态与事实脱节（漏斗统计虚增）。
  const stageNoFlow = [];
  master.rows.forEach(r => {
    const s = normStage(r['意向阶段']);
    if (stageSeq(s) >= 2 && !fIds.has(String(r['客户ID']).trim())) stageNoFlow.push(String(r['客户ID']).trim() + ':' + s);
  });
  if (stageNoFlow.length) problems.push(`阶段已过「客户触达」但无任何流水(状态与事实脱节): ${stageNoFlow.slice(0,5).join('; ')}${stageNoFlow.length>5?'…':''} (${stageNoFlow.length}个)`);

  // ⑦ 归属完整性（2026-09-29 新增不变量 #20）: 每个客户必须有归属，**不许悬空**
  //   归属桶 = 今日队列/批量池/待定区/已排期/出口/挂起冷备/已闭环/成交；悬空 = 系统不知道该拿他怎么办
  const ctxA = buildActionContext();
  const cov = actionCoverage(ctxA);
  if (cov.unassignedCount) problems.push(`客户无归属(系统不知道该拿他怎么办): ${cov.unassigned.slice(0,5).join('; ')}${cov.unassignedCount>5?'…':''} (${cov.unassignedCount}个)`);
  // 用量快照新鲜度：**只作 info 不报红**（15 天导一次表是常态，报红会把 doctor「全绿」铁律常态打破）
  const sInfo = snapshotInfo(ctxA);
  info.push(`用量快照: ${sInfo.label}｜行动池 ${cov.buckets['电话池']} / 批量池 ${cov.buckets['批量池']} / 待定区 ${cov.buckets['待定区']}`);

  // ⑧ 联系人子表（2026-09-14 新增）: 子表是否存在 + 孤儿联系人（客户ID 不在主表）
  //    本次"18 条孤儿联系人静默丢失"就是因为 check 完全不看联系人 sheet 才漏掉的
  let contactRows = 0, orphanContacts = [], contactSheet = false;
  const cwb = master.wb;
  if (cwb.Sheets['联系人']) {
    contactSheet = true;
    const CT_ = X.utils.sheet_to_json(cwb.Sheets['联系人'], { defval: '' });
    contactRows = CT_.length;
    const ch = Object.keys(CT_[0] || {});
    CT.forEach(k => { if (ch.length && !ch.includes(k)) problems.push(`联系人表缺字段: ${k}`); });
    const seen = new Set();
    CT_.forEach(c => {
      const id = String(c['客户ID']).trim();
      if (!id || mIds.has(id)) return;
      if (seen.has(id)) return;
      seen.add(id); orphanContacts.push(id);
    });
    if (orphanContacts.length) problems.push(`孤儿联系人(主表无此客户): ${orphanContacts.slice(0,8).join(',')}${orphanContacts.length>8?'…':''} (${orphanContacts.length}个)`);
  } else {
    problems.push('缺「联系人」子表（2026-09-14 恢复的联系人无家可归；整本重建工作簿时被丢过）');
  }

  // ⑨ 变更留痕（2026-09-29 用户定）: 客户信息任何变化都要在主表+流水表同步留痕。
  //   【…】开头的留痕必须 类型=数据整理、种类在册；业务口径靠 isFollowRecord() 区分（触达/静默/今日清单都不计它）。
  const changeRows = flow.rows.filter(isChangeRecord);
  const badChange = [];
  changeRows.forEach(f => {
    const tag = String(f['沟通内容'] || '').trim().match(CHANGE_TAG);
    const kind = tag ? tag[0].slice(1, -1) : '';
    const lid = String(f['流水ID'] || '').trim();
    if (!CHANGE_KINDS[kind]) badChange.push(lid + ':未知留痕种类「' + kind + '」');
    else if (String(f['类型'] || '').trim() !== '数据整理') badChange.push(lid + ':留痕的「类型」列应为数据整理');
  });
  if (badChange.length) problems.push(`变更留痕格式异常(${badChange.length}条): ${badChange.slice(0,5).join('; ')}${badChange.length>5?'…':''}`);
  if (changeRows.length) info.push(`变更留痕 ${changeRows.length} 条（建档/信息变更/排期变更/清排期，与跟进流水同表存放；不计入触达与静默口径）`);

  // ⑩ 结果零悬空（2026-10-08 用户定）：每个客户恒有一个结果（8 值派生，单一事实源 sopResultOf）。
  //    出现不在册的结果名 = 代码 bug，直接报红。
  const results = {}; RESULT_ALL.forEach(k => { results[k] = 0; });
  const badResult = [], stuckNoAnchor = [];
  master.rows.forEach(r => {
    const rr = sopResultOf(r, flow.rows);
    results[rr.result] = (results[rr.result] || 0) + 1;
    if (RESULT_ALL.indexOf(rr.result) < 0) badResult.push(String(r['客户ID'] || '').trim() + ':' + rr.result);
    if (rr.result === '停住·无锚点') stuckNoAnchor.push(String(r['客户ID'] || '').trim() + (rr.stuckAt ? '(' + rr.stuckAt + ')' : ''));
  });
  if (badResult.length) problems.push(`结果值不在册(${badResult.length}个): ${badResult.slice(0,5).join('; ')}${badResult.length>5?'…':''}`);
  // ⑪ 停住必带锚点（2026-10-08）：状态已经挂了却没有【结论】锚点 = 黑洞。
  //    2026-10-08 审计 A2：原来**只进 info** —— 不变量「停住必带锚点」被违反 130/850，check 照样 ok=true，
  //    等于这条不变量没有任何验收力（A 档「工程化」的核心缺口）。现在**同时进 warnings**（仍不报红：
  //    存量必须由用户分批点名清理，见 sales_settle/sales_triage），数量进返回值 `stuckNoAnchor`，
  //    由 gate.cjs 用基线卡住「只准变少、不准变多」。
  if (stuckNoAnchor.length) {
    warnings.push(`停住·无锚点 ${stuckNoAnchor.length} 个（状态挂了但没写【结论】复查锚点；存量待点名清理）`);
    info.push(`停住·无锚点明细（前8）: ${stuckNoAnchor.slice(0, 8).join(',')}${stuckNoAnchor.length > 8 ? '…' : ''}`);
  }

  // ⑫ 赛道零悬空（2026-10-08 总体计划）：6 轨派生，合计恒等于客户数；出现不在册轨道 = 代码 bug，报红。
  const tracks = {}; TRACK_ALL.forEach(k => { tracks[k] = 0; });
  master.rows.forEach(r => { const k = sopTrackOf(r, flow.rows); tracks[k] = (tracks[k] || 0) + 1; });
  const trackSum = TRACK_ALL.reduce((a, k) => a + tracks[k], 0);
  if (trackSum !== master.rows.length) problems.push(`赛道零悬空失败: 6 轨合计 ${trackSum} ≠ 客户数 ${master.rows.length}`);

  // ⑬ 企业级段不许裸奔（D3，2026-10-08 总体计划）：进了企业级 6 段的客户，必须有下一步排期或【结论】锚点。
  //    当前企业级段 0 客户 → 记 info 不报红；真有客户进段后立刻点名（= 不变量 #26 的落地检查）。
  const entBare = [];
  master.rows.forEach(r => {
    if (String(r['跟进状态'] || '').trim() === '已闭环') return;
    const stage = normStage(r['意向阶段']);
    if (stageSeq(stage) < STAGE_ENT_MIN) return;
    const rr = sopResultOf(r, flow.rows);
    const next = normDateStr(r['下次跟进时间']);
    if (!next && !rr.anchor) entBare.push(String(r['客户ID'] || '').trim() + '(' + stage + ')');
  });
  if (entBare.length) info.push(`企业级段缺下一步/锚点 ${entBare.length} 个（进企业级轨的客户必须有排期或【结论】锚点）: ${entBare.slice(0, 8).join(',')}${entBare.length > 8 ? '…' : ''}`);

  // ⑭ 转介绍必须成对（D4，2026-10-08）：【介绍】只有介绍人没有被介绍人（或反之）= 查不清的账。
  //    记 info 不报红（历史留痕可补）；飞轮的转介绍环只认成对的记录（indexReferral）。
  const refIdx = indexReferral(flow.rows, master.rows);
  if (refIdx.halfCount) info.push(`转介绍只写了一半 ${refIdx.halfCount} 条（【介绍】要同时有 介绍人 和 被介绍人）: ${refIdx.half.slice(0, 5).map(x => x.flowId + '@' + x.id).join(',')}${refIdx.halfCount > 5 ? '…' : ''}`);

  // ⑮ 六分类完备性 + 等级梯度一致（2026-10-13 用户定：六类**完整且互斥**、等级随分类走）
  //    六类合计必须恒等于客户数（有客户掉出分类 = 分类代码有洞）；等级与分类不一致 = 页面数字会打架，报红。
  const bucketCnt = {}; BUCKET_ORDER.forEach(k => { bucketCnt[k] = 0; });
  const lvDrift = [];
  master.rows.forEach(r => {
    bucketCnt[bucketOf(r, flow.rows)]++;
    const want = String(bucketLevelOf(r, flow.rows) || '');
    const now = String(r['客户等级'] || '').trim();
    if (now !== want) lvDrift.push(`${String(r['客户ID'] || '').trim()}(${now || '未定级'}→${want || '未定级'})`);
  });
  const bucketSum = BUCKET_ORDER.reduce((a, k) => a + bucketCnt[k], 0);
  if (bucketSum !== master.rows.length) problems.push(`六分类完备性失败: 六类合计 ${bucketSum} ≠ 客户数 ${master.rows.length}`);
  if (lvDrift.length) problems.push(`等级与分类不一致 ${lvDrift.length} 个（挂起冷备=C/待定跟进=B/重点跟进=A/标品成交=S/定制开发=SS/待首触=不定级）: ${lvDrift.slice(0, 8).join(',')}${lvDrift.length > 8 ? '…' : ''}`);

  return {
    ok: problems.length === 0,
    date: today(),
    master: master.rows.length, flow: flow.rows.length, contacts: contactRows,
    orphan: orphan.length, orphanTomb: orphanTomb.length, orphanContacts: orphanContacts.length,
    noFlow: noFlowAll.length, noFlowInProgress: noFlowInProgress.length, noFlowUntouched: noFlowUntouched.length, noFlowCold: noFlowCold.length,
    touchDiff: touchCount,
    changeRecords: changeRows.length,
    results, tracks, stuckNoAnchor: stuckNoAnchor.length, resultUnstarted: results['未开始'] || 0,
    entStageNoAnchor: entBare.length,
    referral: { pairs: refIdx.pairCount, half: refIdx.halfCount, referrers: refIdx.referrers.length },
    stageUnlabeled,
    stageNoFlow: stageNoFlow.length,
    unassigned: cov.unassignedCount,
    coverage: cov.buckets,
    buckets: bucketCnt, levelDrift: lvDrift.length,
    snapshot: sInfo,
    problems,
    warnings,
    info,
  };
}

// ---------- 命令: 汇总统计 ----------
// 展示顺序规范(用户2026-08-24): 等级按 ABCS(空) 固定顺序(不是插入顺序)；状态按 待首触/跟进中/挂起冷备/已闭环/(空)
// 命中分布: 未触达客户按首访4条筛选规则统计(未命中/命中1条/命中2条以上)
function cmdSummary() {
  const { rows } = readMaster();
  const flow = readFlow();
  const todaySerial = dateToSerial(today());
  const st = {}; const lv = {}; const tc = { 未触达: 0, 待微信通过: 0, 已触达: 0, 已加微信: 0 }; const sg = {};
  const hitDist = { 未命中: 0, 命中1条: 0, 命中2条以上: 0 };
  // 触达状态按流水判定(用户2026-08-24铁律): 主表「触达状态」字段失真，不作依据。
  //   2026-09-29（两表留痕）: 【…】变更留痕不算触达证据（改手机号/改状态≠接触过客户）
  const flowed = new Set(); const wechat = new Set(); const flowsById = new Map();
  flow.rows.forEach(f => {
    if (!isFollowRecord(f)) return;
    const id = f['客户ID']; if (!id) return;
    flowed.add(id);
    if (!flowsById.has(id)) flowsById.set(id, []);
    flowsById.get(id).push(f);
    if (String(f['方式'] || '').indexOf('微信') >= 0) wechat.add(id);
  });
  rows.forEach(r => {
    const s = r['跟进状态'] || '(空)'; st[s] = (st[s] || 0) + 1;
    const l = r['客户等级'] || '(空)'; lv[l] = (lv[l] || 0) + 1;
    const g = normStage(r['意向阶段']) || '(未标注)'; sg[g] = (sg[g] || 0) + 1;
    const id = r['客户ID'];
    // 2026-09-14 修复: 触达状态各态必须**互斥**（原来"已加微信"会同时计进"已触达"，
    //   看板「触达状态」标题数 > 客户总数，用户会误判）
    // 2026-10-20: 四态互斥（未触达/待微信通过/已触达/已加微信），按 deriveTouchState 现算
    if (wechat.has(id)) tc[deriveTouchState(flowsById.get(id) || [], r['触达状态'])]++;
    else if (flowed.has(id)) tc['已触达']++;
    else {
      tc['未触达']++;
      const h = ruleHits(r, todaySerial);
      if (h === 0) hitDist['未命中']++;
      else if (h === 1) hitDist['命中1条']++;
      else hitDist['命中2条以上']++;
    }
  });
  const STATUS_ORDER = ['待首触', '跟进中', '挂起', '挂起冷备', '已闭环', '(空)'];
  const LEVEL_ORDER = ['SS', 'S', 'A', 'B', 'C', '(空)'];
  const statusOut = {}; STATUS_ORDER.forEach(k => statusOut[k] = st[k] || 0);
  const levelOut = {}; LEVEL_ORDER.forEach(k => levelOut[k] = lv[k] || 0);
  // 2026-09-29 SOP 阶段分布（漏斗）：按 13 段（7 标品 + 6 企业级）+ 2 出口 + 未标注 固定顺序；野值单列，绝不静默丢
//   2026-10-08 审计 A19：原写「6 段 + 2 出口」，与 STAGE_MAIN（13 段）不符，已更正。
  const stageOut = {}; STAGE_ORDER.forEach(k => stageOut[k] = sg[k] || 0);
  const stageWild = Object.keys(sg).filter(k => STAGE_ORDER.indexOf(k) < 0 && sg[k] > 0).map(k => ({ stage: k, count: sg[k] }));
  // 2026-10-08 赛道分布（派生，6 轨固定顺序；合计恒等于客户总数）
  const tr = {};
  rows.forEach(r => { const k = sopTrackOf(r, flow.rows); tr[k] = (tr[k] || 0) + 1; });
  const trackOut = {}; TRACK_ALL.forEach(k => trackOut[k] = tr[k] || 0);
  // 2026-09-14 新增: 体检警告要有出口（否则 warnings 只存在 check 里，看板和模型都看不到）
  // 2026-09-23 修假警告: 备注注明「未直接接触」的（按 9-18 口径只补身份/排期、不落流水）是正常态，
  //   不计入 warnings（否则看板永久挂一条假警告）；单独给 noContactNoFlow 计数，信号仍可见。
  const inProgressNoFlowAll = rows.filter(r => ['跟进中', '挂起'].includes(String(r['跟进状态'] || '').trim()) && !flowed.has(String(r['客户ID'] || '').trim()));
  // 两类正常态豁免：① 备注注明「未直接接触」（2026-09-18 口径）② 已点名【结论】（有据，2026-10-13 修假警告）
  const noDirectContact = (r) => String(r['备注'] || '').indexOf('未直接接触') >= 0;
  const concludedIds = new Set(flow.rows.filter(f => parseConclusion(f)).map(f => String(f['客户ID'] || '').trim()).filter(Boolean));
  const noContactNoFlow = inProgressNoFlowAll.filter(noDirectContact).length;
  const concludedNoFlow = inProgressNoFlowAll.filter(r => !noDirectContact(r) && concludedIds.has(String(r['客户ID'] || '').trim())).length;
  const inProgressNoFlow = inProgressNoFlowAll.filter(r => !noDirectContact(r) && !concludedIds.has(String(r['客户ID'] || '').trim()));
  const warnings = [];
  if (inProgressNoFlow.length) warnings.push(`跟进中/挂起但0流水 ${inProgressNoFlow.length} 个(疑似历史丢流水)`);
  const pendingNoDate = rows.filter(r => String(r['跟进状态'] || '').trim() === '跟进中' && !normDateStr(r['下次跟进时间'])).length;
  // 2026-10-13 六分类分布（派生现算，固定顺序，六类合计恒等于客户总数）
  const buckets = bucketCounts(rows, flow.rows);
  return { total: rows.length, status: statusOut, level: levelOut, touch: tc, hitDist, stage: stageOut, stageWild, track: trackOut, buckets, flowCount: flow.rows.filter(isFollowRecord).length, changeCount: flow.rows.filter(isChangeRecord).length, warningsCount: warnings.length, warnings, noContactNoFlow, concludedNoFlow, pendingNoDate, touchNote: '触达状态按跟进流水判定(你铁律): 无跟进流水=未触达；有=已触达；方式含微信时再分三档——明确写了已加/已通过=已加微信，只写申请/待通过/没写清=待微信通过（2026-10-20 新增，四态互斥）；【…】变更留痕(建档/信息变更/排期变更)不计入触达。flowCount 只数跟进结果（2026-10-28 你 m03270：面板只展示结果，过程留痕走 changeCount）' };
}

// ---------- 命令: 销售指导检索(示例语料综合参考) ----------
// 场景联动: 按客户特征+跟进轨迹推荐跟进提示
// 已触达客户按「跟了几轮/最近聊什么/对方反应/卡点/付费/逾期」个性化；未触达按4条规则命中+特征。
// 文章选择: 场景关键词 -> 标题3分/标签2分/摘要1分 搜索打分，每场景取最贴切且全局不重复的文章
const TIP_KEYWORD_MAP = {
  '高意向首访': ['首访', '破冰', '第一', '需求'],
  '首次回访': ['首访', '破冰', '开场', '第一'],
  '首触后无下文': ['破冰', '首次', '加微信', '第一句'],
  '使用体验回访': ['回访', '使用', '体验', '效果'],
  '需求确认与价值建立': ['需求', '价值', '痛点', '方案'],
  '跟进推进': ['跟进', '推进', '节奏'],
  '促单成交': ['逼单', '成交', '促单', '下单'],
  '逾期重新激活': ['激活', '重新', '沉默', '旧'],
  '价格异议处理': ['贵', '议价', '价格', '预算', '异议'],
  '客户不回应': ['不回', '沉默', '消息', '激活'],
  '流失客户挽回': ['流失', '挽回', '删', '不合作'],
  '顾虑挖掘': ['顾虑', '考虑', '犹豫', '异议'],
  '趁热推进': ['趁热', '推进', '约定', '下一步'],
  '付费客户维护': ['老客户', '维护', '服务', '信任'],
  '续费与转介绍': ['转介绍', '复购', '续费'],
  '老客维护转介绍': ['老客户', '转介绍', '复购'],
  // 2026-09-29 行动引擎新增场景（V3.0 能力/周期节奏/增购/激活/联售）
  '项目节奏确认': ['需求', '项目', '节奏', '跟进'],
  '增购字数包': ['复购', '成交', '续费', '逼单'],
  '激活指导': ['回访', '使用', '体验', '服务'],
  '首次回访': ['首访', '破冰', '开场', '第一'],
  '联售智算': ['需求', '价值', '方案', '专业'],
  '批量触达': ['激活', '沉默', '重新', '跟进'],
  // 2026-10-08 D2 企业级 + 培育轨场景（关键词尽量落在《销售技巧资料》的 需求/推进/价值 类目里）
  '企业级机会': ['需求', '价值', '痛点', '方案'],
  '企业级推进': ['跟进', '推进', '节奏', '项目'],
  '决策链摸排': ['需求', '决策', '价值', '提问'],
  '现状勘察邀约': ['需求', '方案', '现状', '调研'],
  '方案与试点设计': ['方案', '试点', '价值', '设计'],
  '试点验证': ['方案', '效果', '价值', '推进'],
  '私有化签约': ['成交', '签约', '合同', '逼单'],
  '企业级转介绍': ['转介绍', '复购', '老客户', '续费'],
  '行业简报': ['激活', '沉默', '重新', '价值'],
  '新功能发布': ['回访', '体验', '服务', '价值'],
};
// 场景优先级: 卡点/反应类最具体排前，维度类(付费/逾期/体验)居中，兜底类最后
//   2026-10-08 D2：企业级段位是"这一段只推一件事"的硬指向，排在卡点类之后、维度类之前
const TIP_SCENE_PRIORITY = ['促单成交', '价格异议处理', '客户不回应', '流失客户挽回', '逾期重新激活', '首触后无下文', '顾虑挖掘', '趁热推进',
  '私有化签约', '决策链摸排', '现状勘察邀约', '方案与试点设计', '试点验证', '企业级机会', '企业级推进', '企业级转介绍', '行业简报', '新功能发布',
  '需求确认与价值建立', '老客维护转介绍', '付费客户维护', '续费与转介绍', '使用体验回访', '跟进推进', '高意向首访', '首次回访'];
function loadTipsDb() {
  try { return JSON.parse(require('fs').readFileSync(TIPS_JSON, 'utf8')); } catch (e) { return []; }
}
// 搜索式: 按关键词/场景检索，返回最贴切的前5篇
function cmdTips(a) {
  a = a || {};
  const q = String(a.q || '').trim();
  if (!q) return { ok: false, message: '缺少搜索关键词(q)' };
  const db = loadTipsDb();
  if (!db.length) return { ok: false, message: '参考文件读取失败(营销资料库/销售技巧-结构化.json)' };
  const kws = q.split(/[\s,，、]+/).filter(Boolean).map(s => s.toLowerCase());
  const scored = db.map(d => {
    let s = 0;
    const title = String(d.标题 || '').toLowerCase();
    const tags = (d.标签 || []).join(' ').toLowerCase();
    const abs = String(d.摘要 || '').toLowerCase();
    kws.forEach(kw => {
      if (title.includes(kw)) s += 3;
      if (tags.includes(kw)) s += 2;
      if (abs.includes(kw)) s += 1;
    });
    return { d, s };
  }).filter(x => x.s > 0).sort((x, y) => y.s - x.s || (y.d.点赞量 || 0) - (x.d.点赞量 || 0));
  return { ok: true, q, count: scored.length, list: scored.slice(0, 5).map(x => ({ 序号: x.d.序号, 标题: x.d.标题, 点赞量: x.d.点赞量, 标签: x.d.标签, 摘要: x.d.摘要, 全文: x.d.全文 })) };
}
// 场景联动: 按客户特征推荐跟进提示(未触达/付费/高消耗/阶段等)
function cmdClientTip(a) {
  a = a || {};
  const id = String(a.id || '').trim();
  if (!id) return { ok: false, message: '缺少客户ID(id)' };
  const { rows } = readMaster();
  const c = rows.find(r => String(r['客户ID']).trim() === id);
  if (!c) return { ok: false, message: '未找到客户 ' + id };
  const todaySerial = dateToSerial(today());
  const todayStr = today();
  const hits = ruleHits(c, todaySerial);
  const stage = normStage(c['意向阶段']);
  const paid = String(c['是否购买'] || '').trim() === '是';
  const used = Number(c['智写消耗字数'] || 0) > 0;
  const nextDate = String(c['下次跟进时间'] || '').trim();
  const overdue = !!nextDate && nextDate < todayStr;

  const flowRows = readFlow().rows.filter(f => String(f['客户ID'] || '').trim() === id);
  const hasFlow = flowRows.length > 0;
  const last = hasFlow ? flowRows[flowRows.length - 1] : null;
  const lastType = last ? String(last['类型'] || '').trim() : '';
  const lastReact = last ? String(last['对方反应'] || '') : '';
  const lastWhat = last ? (String(last['沟通内容'] || '') + ' ' + String(last['下一步动作'] || '')) : '';

  const scenes = [];
  if (!hasFlow) {
    // ---- 未触达：按4条规则命中 + 特征给首访思路 ----
    scenes.push(hits >= 2 ? '高意向首访' : '首次回访');
    if (used) scenes.push('使用体验回访'); // 有实际消耗的，首访从使用体验切入
    if (paid) { scenes.push('付费客户维护'); scenes.push('续费与转介绍'); }
  } else {
    // ---- 已触达：按跟进轨迹个性化 ----
    // 1) 卡点场景：按最近一条流水类型 + 主表 SOP 阶段 + 最近聊的内容
    if (isExitStage(stage)) {
      // 出口阶段（无法联系/推进终止）：不按常规节奏推，走挽回/激活话术
      scenes.push(stage === '无法联系' ? '客户不回应' : '流失客户挽回');
    } else if (stageSeq(stage) >= STAGE_ENT_MIN) {
      // 2026-10-08 D2 企业级 6 段：这一段只推一件事（摸决策链/勘察/方案试点/商务/签约/转介绍）
      scenes.push(ENT_STAGE_SCENE[stage] || '企业级推进');
    } else if (stage === '方案报价' || stage === '成交签约' || /(方案|报价|价格|合同|签约|打款)/.test(lastWhat)) {
      scenes.push('促单成交');
    } else if (lastType === '首触' || flowRows.length === 1) {
      scenes.push('首触后无下文'); // 只跟过一轮就没下文
    } else if (lastType === '试用回访' || lastType === '客户反馈') {
      scenes.push('使用体验回访');
    } else if (lastType === '老客服务') {
      scenes.push('老客维护转介绍');
    } else if (lastType === '放弃跟进') {
      scenes.push('流失客户挽回');
    } else if (lastType === '高意向跟进') {
      scenes.push('需求确认与价值建立');
    } else {
      scenes.push('跟进推进');
    }
    // 2) 反应场景：按最近一条对方反应（覆盖式：更具体时替换卡点场景）
    if (/(删|拉黑|流失|不续|换家|别家|取消合作|拒绝|不需要|不用了|暂时不|不考虑)/.test(lastReact)) {
      scenes.length = 0; scenes.push('流失客户挽回');
    } else if (/(贵|预算|价格|划不|不值|性价比)/.test(lastReact)) {
      scenes.length = 0; scenes.push('价格异议处理');
    } else if (/(不回|没回|未回|没空|太忙|不理|不接|挂断|失联|沉默|没动静|没下文)/.test(lastReact)) {
      scenes.push('客户不回应');
    } else if (/(考虑|想想|商量|再联系|看看|研究)/.test(lastReact)) {
      scenes.push('顾虑挖掘');
    } else if (/(感兴趣|约|行|可以|方便|要|发我|演示|报价|好的)/.test(lastReact)) {
      scenes.push('趁热推进');
    }
    // 3) 维度场景：叠加（不覆盖）
    if (paid) scenes.push('付费客户维护');
    if (overdue) scenes.push('逾期重新激活');
    if (used && !scenes.includes('使用体验回访')) scenes.push('使用体验回访');
  }

  // 场景去重 + 按优先级排序 + 最多保留3个（每场景一篇，不刷屏）
  const uniq = [...new Set(scenes)].sort((x, y) => TIP_SCENE_PRIORITY.indexOf(x) - TIP_SCENE_PRIORITY.indexOf(y)).slice(0, 3);

  // 每场景按关键词搜索打分选最贴切文章（标题3/标签2/摘要1），全局不重复
  const db = loadTipsDb();
  const seen = new Set();
  const tips = uniq.map(sc => {
    const kws = TIP_KEYWORD_MAP[sc] || [];
    let best = null, bestS = 0;
    for (const d of db) {
      if (seen.has(d.序号)) continue;
      let s = 0;
      const title = String(d.标题 || '').toLowerCase();
      const tags = (d.标签 || []).join(' ').toLowerCase();
      const abs = String(d.摘要 || '').toLowerCase();
      kws.forEach(kw => {
        if (title.includes(kw)) s += 3;
        if (tags.includes(kw)) s += 2;
        if (abs.includes(kw)) s += 1;
      });
      if (s > bestS) { bestS = s; best = d; }
    }
    if (!best || bestS <= 0) return null;
    seen.add(best.序号);
    return { 场景: sc, 序号: best.序号, 标题: best.标题, 点赞量: best.点赞量, 标签: best.标签, 摘要: best.摘要, 全文: best.全文 };
  }).filter(Boolean);

  // —— 已跟进客户：生成这次跟进的具体话术（规则模板 + 资料要点，从命中全文抽关键句）——
  // 2026-10-08 审计 A4：这里原来直接把主表原始行 `c` 传给 buildFollowScript，
  //   绕过了 cleanWho → 匿名客户的话术开口变成「匿名注册您好」（真表 53/53 命中）。
  //   与 buildHow 对齐：一律先过 cleanWho。
  let script = '';
  if (hasFlow && uniq.length) {
    script = buildFollowScript(uniq[0], tips[0], last, Object.assign({}, c, { '姓名/联系人': cleanWho(c) }));
  }

  return { ok: true, id, name: c['公司'] || c['姓名/联系人'], customer: customerIdentity(c), hits, scenes: uniq, tips, hasFlow, script };
}

// —— 已跟进客户：按主场景 + 客户上次反应/卡点 + 资料要点，合成这次跟进的话术 ——
const SCENE_OPEN = {
  '促单成交': '这次聊到方案/价格，别硬逼单，先帮他把顾虑一项项打消，再给个明确的下一步选择。',
  '价格异议处理': '他上次嫌贵/在意价格，先共情再讲价值，把投入换算成他省下的时间或收益，别上来就降价。',
  '客户不回应': '他没回复，别连环追问，换个角度给一条新价值信息，留个轻钩子让他愿意接话。',
  '流失客户挽回': '他之前有流失/拒绝信号，先承认之前没服务到位，再给一个具体到位的补救或新方案。',
  '逾期重新激活': '他一段时间没动静了，先用一句"最近忙啥"式破冰，再轻提之前聊到的点，别一上来就催。',
  '首触后无下文': '只跟过一轮就没下文，先回扣上次聊的痛点，给一条新信息/案例，约一个明确时间点。',
  '顾虑挖掘': '他说"再考虑/商量"，是还有顾虑没说透，用提问引导他把真实顾虑讲出来。',
  '趁热推进': '他上次意向不错/约了，趁热敲定下一步，别拖；给个明确的动作或时间。',
  '需求确认与价值建立': '他还在需求阶段，先确认真实需求，再把价值讲到场景里去，别急着给方案。',
  '老客维护转介绍': '老客户，先关怀使用效果，再自然开口请转介绍，别一上来就提。',
  '付费客户维护': '付费客户，先关心用得顺不顺，及时响应，巩固信任再谈续费。',
  '续费与转介绍': '服务到期/复购点，先给阶段成果，再谈续费与转介绍。',
  '使用体验回访': '他在用/用过，先问真实使用感受和卡点，再顺势给进阶建议。',
  '跟进推进': '正常跟进，别重复上次内容，抛一个新价值点，把节奏往前推一步。',
};
function extractTipLine(full) {
  if (!full) return '';
  const lines = String(full).split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (const ln of lines) {
    if (/^(💡|🔑|要点|建议|记住|别|一定要|核心|注意)/.test(ln) || (/[：:]/.test(ln) && ln.length < 80)) return ln.slice(0, 90);
  }
  return lines.find(l => l.length > 20 && l.length < 80) || '';
}
// —— 场景 → 可直接复制发送给客户的微信/短信消息模板（首段，照着念/复制即发）——
// 每个模板按「客户名字 + 上次沟通内容 + 上次对方反应 + 资料要点」拼成一句自然的开口。
const SCENE_MSG = {
  '促单成交': o => `${o.who}您好，上次聊到${o.whatPhrase}您说再考虑下，我理解。这段时间我把方案里您最关心的两点又核对了一遍，现在更顺了。您看这周三还是周四方便，我花10分钟给您讲清楚，您也好拍板？`,
  '价格异议处理': o => `${o.who}您好，您上次说价格上有点犹豫，我特别理解。我帮您算了笔账：按您现在的用法，这套每月能帮您省下的时间和人力，其实几个月就能把投入挣回来。要不我给您细说说这笔账，您再定？`,
  '客户不回应': o => `${o.who}您好，您最近忙，我就不多打扰。就一条：上次跟您提的${o.whatPhrase}，我这边多整理了一个同行的真实案例，效果挺不错。您要感兴趣我发您看看，不感兴趣也不用回我。`,
  '流失客户挽回': o => `${o.who}您好，之前有些地方没给您服务到位，我一直记着，也想找机会补上。这次我专门给您重新做了个方案，把您之前提的几个问题都改进了。您看方便的话，我发给您先看看？`,
  '逾期重新激活': o => `${o.who}您好，好久没联系了，最近忙啥呢？上次咱们聊到${o.whatPhrase}，我这边有点新进展，想着跟您同步下。您要是不忙，我简单跟您说两句？`,
  '首触后无下文': o => `${o.who}您好，上次咱们聊完${o.whatPhrase}，不知道您后面考虑得怎么样。我这边又整理了些资料，说不定对您有帮助。您看这周哪天有空，我给您打个电话聊聊？`,
  '顾虑挖掘': o => `${o.who}您好，您上次说再考虑考虑，我特别理解。方便的话您跟我说句实话：是方案哪儿还不合适，还是费用上有顾虑？我好帮您调。`,
  '趁热推进': o => `${o.who}您好，趁您还有兴趣，我想帮您快点定下来。上次聊到${o.whatPhrase}，您看这周咱们约个时间细聊，还是我先把方案发给您看看？`,
  '需求确认与价值建立': o => `${o.who}您好，想跟您多了解下：目前您这边最想解决的是${o.whatPhrase}这件事，对吗？我先弄清楚了，才好给您对应的建议，省得给您一堆用不上的。`,
  '老客维护转介绍': o => `${o.who}您好，这段时间用着还顺手吗？有卡住的地方您随时说，我帮您解决。对了，要是身边有朋友也做这行，方便的话推荐给我，我保证给您俩都照顾好。`,
  '付费客户维护': o => `${o.who}您好，最近用得怎么样？有需要帮忙的随时找我。您这边快到期了，我先问问您用得满不满意，有意见我一并给您弄好。`,
  // 2026-10-22（m02366）：没得引用（内部留痕被拦）时不能说「进展：之前那件事这段效果还不错」，改成整句兜底
  '续费与转介绍': o => `${o.who}您好，先跟您汇报下这段时间的进展：${o.hasWhat ? o.whatPhrase + '这块进展还不错' : '效果总体还不错，用得也稳'}。您这边也快到期了，我帮您看看是续费还是升级更合适，您哪天方便咱们聊下？`,
  '使用体验回访': o => `${o.who}您好，想听听您的真实感受，用下来有没有觉得哪儿不方便的？您说，我好帮您调；顺带教您几招用得更好的法子。`,
  '跟进推进': o => `${o.who}您好，上次聊到${o.whatPhrase}，这次不重复，有个新鲜事跟您说：${o.point}。您看方便的话，咱们见面或电话细聊下？`,
};
// 2026-09-29 行动引擎新增场景（追加式扩展，不动上面既有文案）
Object.assign(SCENE_OPEN, {
  '首次回访': '第一次联系：一句话说清我是谁、为什么找他，别念产品说明书，先争取"愿意聊两句"。',
  '激活指导': '注册了却没生成过报告，先问他卡在哪一步，用"我远程带您跑一遍"降低门槛。',
  '项目节奏确认': '咨询/设计院是项目驱动的：本期没动大概率是手头没项目，别当流失——问下一个项目的节奏。',
  '增购字数包': '余额快见底，把"再买多少够用到什么时候"算清楚给他，比讲功能管用。',
  '联售智算': '他买了智写没用财务测算，用 V3.0 的"智算数据一键出报告"当切口。',
  '批量触达': '长尾客户走批量，别打电话占额度；回复了的当天转成电话跟进。',
});
Object.assign(SCENE_MSG, {
  '首次回访': o => `${o.who}您好，我是负责可研报告工具的顾问，看到您在平台上注册了。冒昧打扰一句：您这边最近有要写可研的项目吗？有的话我花两分钟跟您说说新版（政府/企业分类型一键生成）合不合用，没有也不打扰您。`,
  '激活指导': o => `${o.who}您好，看到您注册了但还没上手。我把操作步骤整理成 3 步发您，或者我远程带您跑一份，10 分钟出初稿——您看哪个方便？`,
  '项目节奏确认': o => `${o.who}您好，跟您确认下节奏：您这边是先把手头项目收尾，还是下一个项目快上了？我按您的节奏来，不打扰。`,
  '增购字数包': o => `${o.who}您好，提醒一句：您账号里的字数快见底了。按您最近的使用量，我先帮您算个够用到下次项目结束的量，再定买多少，省得中途卡住。您方便的话我这就算给您？`,
  '联售智算': o => `${o.who}您好，您可研里的财务测算章节现在是手工做的吗？我们智算平台能把测算结果直接接进报告，V3.0 已经打通了，我给您演示一下？`,
  '批量触达': o => `${o.who}您好，我是负责可研报告工具的顾问。看您注册过还没用起来，我把上手步骤整理成 3 步发您；有项目要写可研的时候随时喊我。`,
});
// 2026-10-08 D2 企业级 + 培育轨场景（追加式，不动上面既有文案）
//   素材口径见 营销资料库/企业级落地要点.md（价值三点/安全边界/落地路径/必备信息五件套）
Object.assign(SCENE_OPEN, {
  '企业级机会': '先从"你们每份报告都要重做一遍"切进去，再落到"把资料和流程沉淀成企业自己的智能体"；别一上来讲私有化。',
  '企业级推进': '企业级一段只推一件事：摸决策链 → 现状勘察 → 方案试点 → 商务 → 签约；每次只拿一个明确下一步。',
  '决策链摸排': '先问三件事：谁牵头、预算走哪个口、今年信息化计划里有没有 AI 这一项——问清才好定下一步。',
  '现状勘察邀约': '带一份《资料清单＋权限矩阵》过去：哪些资料能用、谁能看、谁审，一次过清，别空谈方案。',
  '方案与试点设计': '四模块（资料库/写作/审核/权限）＋试点范围＋基线指标一次讲清，让他能拿这份东西去内部汇报。',
  '试点验证': '先定基线，再跑 20 个真实任务，拿数据比对——试点不验收不扩大。',
  '私有化签约': '把安全边界（资料权属/权限/审核）、部署方式、验收口径一次谈定；合同条款提前过法务，别卡在最后一步。',
  '企业级转介绍': '先问试点成效，成效好再请他引荐同行或集团内其他板块——用结果换介绍，不硬要。',
  '行业简报': '轻触达：发一条行业动态/AI 政策，不带任何客户信息，不求回复。',
  '新功能发布': '轻触达：发新功能 + 一句"您那边这版能省哪一步"，不催单。',
});
Object.assign(SCENE_MSG, {
  '企业级机会': o => `${o.who}您好，冒昧说一下我的观察：像您这边，报告和测算这类活儿每次都要重新组织资料、重走一遍流程。我们最近在做的方向是——把这些资料和流程沉淀成你们自己的智能体，人还是那几个人，活儿能少一大半。您要是愿意，我花 20 分钟跟您过一遍思路？`,
  '企业级推进': o => `${o.who}您好，企业侧的落地我想一步步来，不一次给您堆方案。这次就定一件事：下一步谁做什么。您看这周哪天方便，10 分钟我跟您对一下？`,
  '决策链摸排': o => `${o.who}您好，为了不给您后面添麻烦，我想先问清三件事：这件事谁牵头、预算走哪个口、今年信息化计划里有没有 AI 这一项。您方便的话跟我说个大概，我好按您的实际情况来准备。`,
  '现状勘察邀约': o => `${o.who}您好，我整理了一份《资料清单＋权限矩阵》——哪些资料能进、谁能看、谁审，一页纸。想约您半小时过一遍，过完之后方案才不会是空谈。您看这周哪天？`,
  '方案与试点设计': o => `${o.who}您好，方案我按四块来设计：资料库、写作、审核、权限，再加一个试点范围和基线指标。这样您拿这份东西去内部汇报也能直接讲。我发您先看看，您标一下要改的地方？`,
  '试点验证': o => `${o.who}您好，试点我建议先定基线：现在这类活一个项目大概花多少工、返工几次。然后咱们跑 20 个真实任务，再拿数据比对——不验收就不扩大，这样您这边也好交代。您看从哪个项目先试？`,
  '私有化签约': o => `${o.who}您好，到签约这步我把三件事一次说清：资料权属和权限怎么定、怎么部署、验收按什么口径算。条款我先给我们法务过一遍再发您，省得来回改。您看这周哪天方便定下来？`,
  '企业级转介绍': o => `${o.who}您好，试点这段时间的效果我先跟您对一下。要是您觉得值，方便的话帮我引荐一下同行，或者集团里其他板块的同事——我保证一样的方式服务。`,
  '行业简报': o => `${o.who}您好，最近整理了一份这个行业的动态和新政策要点，想着您可能用得上，发您看看。不用回我，有需要随时喊我。`,
  '新功能发布': o => `${o.who}您好，我们这版更新了个新功能（政策库和分类型模板又扩充了一批，写起来能少改一遍）。您那边现在的流程里，说不定能省掉一步，有兴趣我发您 3 分钟演示。`,
});
// 2026-10-08 审计 A1：发给客户的话术**只能引用"客户能看见的沟通内容"**。
//   事故形态：buildFollowScript 直接拿该客户**最后一条流水**（不判 isFollowRecord）的「沟通内容」
//   原文截 30 字塞进话术 → 真表会发出「先跟您汇报下这段时间的进展：「补录历史跟进：本客户系 9-14
//   由官网导出补录…」这段效果还不错」这种把内部留痕原文发给客户的事故（57 个客户末条流水类型=数据整理、
//   21 条末条是变更留痕，随时可能命中）。
//   两条口径：① 只有常规跟进（isFollowRecord）才允许引用；② 内容带内部标记（【…】标签、补录/导出/
//   暂不主动/节后再等内部口径）一律不引用，退回默认短语「上次聊的事」。
const INTERNAL_WHAT_RE = /【|补录|导出|留痕|暂不主动|不再主动|节后再|内部|系统自动/;
// 2026-10-22（用户 m02366「都修」）：上面这条只拦「【】/补录/导出」这类**整段**内部留痕，
//   漏了「沟通内容」里混进去的**内部字段片段**——真实事故：C-未知-2609-709 的末条流水是
//   「电话联系客户（付费798，平台已购），本次未联系上；微信昵称 AAA」，被原样拼进给客户的话术
//   （「上次聊到「电话联系客户（付费798，平台已购）…微信昵称」」）。内部口径发到客户手里 = 事故，
//   所以分两级：① 出现硬标记 → 整条不引用（退回「上次聊的事」）；② 只是夹带内部字段 → 去掉那小段再用。
const INTERNAL_HARD_RE = new RegExp(INTERNAL_WHAT_RE.source
  + '|微信昵称|平台已购|付费\\s*\\d|仅内部|CRM'
  // 2026-10-22（m02366）：流水里大量是「我们自己的记录口吻」——「微信还没加上：今日已发出微信好友申请」
  //   「电话联系客户，本次未联系上」——这些是内部台账原话，客户看了会觉得被当条目管，不能进话术。
  + '|微信还没加上|今日已发出|原排期|无人接听|未接听|电话联系客户|好友申请|微信好友|已发微信|发了微信');
const INTERNAL_SOFT_RE = /已购\s*\d|购字数|充值|账号|余额|字数包/;
function customerSafeWhat(what) {
  const w = String(what || '').trim();
  if (!w) return '';
  if (INTERNAL_HARD_RE.test(w)) return '';
  if (!INTERNAL_SOFT_RE.test(w)) return w;
  const parts = w.split(/[；;。\n]/).map(s => s.trim()).filter(Boolean);
  const keep = parts.filter(p => !INTERNAL_SOFT_RE.test(p));
  const out = keep.join('；');
  return out.length >= 8 ? out : '';
}
function publicWhat(last) {
  if (!last || !isFollowRecord(last)) return '';
  return customerSafeWhat(String(last['沟通内容'] || '').trim());
}
function buildFollowScript(scene, tip, last, c) {
  const who = String(c['姓名/联系人'] || c['公司'] || '').trim() || '您';
  // 审计 A1：反应/内容都只认常规跟进
  const isFollow = !!(last && isFollowRecord(last));
  const react = String(isFollow ? (last['对方反应'] || '') : '').trim();
  const what = publicWhat(last);
  // 2026-10-22（m02366）：兜底短语原来是「上次聊的事」，配上模板「上次聊到…」就成了
  //   「上次聊到上次聊的事」——别扭。改成「之前那件事」，句面通顺。
  const whatPhrase = what ? `「${what.slice(0, 30)}」` : '之前那件事';
  // 2026-10-08 D2：企业级/培育场景不一定能在示例语料里命中文章 → 用场景要点兜底，话术照样能发
  const entPoint = ENT_SCENE_POINTS[scene] || '';
  const point = (tip ? extractTipLine(tip.全文 || tip.摘要 || '') : entPoint).replace(/[。.\s]+$/, '');
  const refTitle = tip ? String(tip.标题 || '') : '';
  const open = SCENE_OPEN[scene] || SCENE_OPEN['跟进推进'];
  const msg = (SCENE_MSG[scene] || SCENE_MSG['跟进推进'])({ who, what, react, whatPhrase, point, hasWhat: !!what });
  const srcLine = tip
    ? `参考来源：《${refTitle}》${point ? ' 要点：「' + point + '」' : ''}`
    : (entPoint ? `要点来源：《企业级落地要点》 要点：「${entPoint}」` : '参考来源：（本次未命中文章，按场景口径直说）');
  const note =
    `【本次跟进要点】场景：${scene}\n` +
    `${srcLine}\n` +
    `上次反馈：${react ? react.slice(0, 40) : '（无）'}\n` +
    `策略：${open}`;
  return sanitizeGreeting(`—— 可直接复制发给客户（微信/短信）——\n${msg}\n\n${note}`);
}

// ---------- 通话中实时话术（2026-10-09 用户定：电话外放 → 本机转写 → 边说边提示）----------
// 场景：用户打电话开外放，浏览器端每 5 秒把一段话在**本机**转成文字，POST /sales/live；
//   本函数**纯读**算出「客户刚说了什么 → 你现在接哪句」（零网络、零落盘；红线10：派生事实不落盘）。
// 与 cmdClientTip 的分工：cmdClientTip 出的是**通话后发微信/短信**的整段文案（SCENE_MSG 口径）；
//   本函数出的是**通话中当面接话**的口语应对（LIVE_PLAYBOOK）——两者口径不同，不要互相替代。
// 出参：{ok,id,name,stage,result,progress,cues[],moves[],stageOpen}；cues 按优先级排序（列表显式给优先级），默认最多 3 条。
const LIVE_PLAYBOOK = [
  { cue: '价格异议', re: /贵|太贵|价格高|价钱|多少钱|报价|划不来|不值|性价比|打折|优惠|便宜|超预算|预算不够|预算有限|没那么多钱/, say: '我理解。您跟我说实话：是总价超了预算，还是觉得这笔钱值不回来？这两种我给的东西不一样。', why: '先把「没钱」和「不值」分开——前者改配置或分期，后者算账。', stage: '异议处理' },
  { cue: '预算要走内部流程', re: /预算|审批|请示|上头|领导批|公司批|内部流程|申请经费/, say: '明白。那我把方案整理成一页纸：解决什么、省多少、要花多少，您拿去汇报直接用；需要我配合讲一次也行。', why: '预算口不在他手里时，帮他准备好汇报材料就是最有效的推进。', stage: '决策链摸排' },
  { cue: '要跟别人商量', re: /商量|研究一下|内部讨论|再考虑|汇报一下|问一下/, say: '应该的。那您觉得卡点在谁那儿——是价格、是效果，还是流程？我好把材料准备到他关心的那一点上。', why: '问出真正的决策人和他的关注点（决策链摸排）。', stage: '决策链摸排' },
  { cue: '没时间/最近忙', re: /没时间|太忙|正忙|改天|回头再说|下周再说|以后再说/, say: '行，我不占您时间。就定个具体时间：下周您哪个半天方便？我提前把要讲的三件事列好，10 分钟过完。', why: '别问「什么时候方便」（等于没问），给二选一的具体时间。', stage: '产品演示' },
  { cue: '问能干什么', re: /能做什么|怎么用|有什么用|能省|效果怎么样|管用|靠谱吗/, say: '举个您身边的例子：像您这边每份可研，原来资料加排版两三天，用这个能压到半天。您最近哪个项目最急？我按那个项目说。', why: '用他自己的项目讲价值，比讲功能管用。', stage: '需求挖掘' },
  { cue: '要看案例/资料', re: /案例|同行|别人用|有没有资料|发我|发过来|资料发/, say: '有。我挑一个跟您同行的、数据完整的发您。您看完咱们就着它聊——您更想看省时间这块，还是省人力这块？', why: '案例要挑同行，并让他选角度，才有下一轮话头。', stage: '产品演示' },
  { cue: '比价/提别家', re: /别家|其他家|对比|比你们便宜|也在做|选型/, say: '您比较是应该的。我就问一件事：您现在最看重的是价格，还是落地时候省不省心？按您这个排序，我告诉您该怎么选。', why: '不贬低对手，把选择标准拉到自己强的维度上。', stage: '异议处理' },
  { cue: '担心数据安全', re: /安全|保密|涉密|私有化|数据能不能出|内网|权限/, say: '这块正好要先谈：资料权属归您、谁能看谁审、要不要私有化部署——我整理了一页纸，咱们过一遍就清了。', why: '企业级的安全顾虑要用「资料清单 + 权限矩阵」接住，不空口保证。', stage: '需求与现状勘察' },
  { cue: '愿意试用/试点', re: /试用|试点|先试试|小额|先上一个|跑一批/, say: '可以。先定基线：现在这类活一个项目花多少工、返工几次；然后拿 20 个真实任务比对，不达标不扩大。', why: '试点要带基线和范围，否则试完也说不清效果。', stage: '方案与试点设计' },
  { cue: '愿意约下一步', re: /约|方便|来一趟|过来|见面|演示|定个时间|做一次/, say: '那就定下来：{time}，我把{three}准备好。您那边要不要叫上{who}一起？', why: '客户一松口就把时间、材料、参会人一次确认，避免「回头再约」。', stage: '产品演示' },
  { cue: '成交/签约信号', re: /合同|签约|打款|付款|开票|下单|流程怎么走|怎么买/, say: '好，合同我这边准备：资料权属、部署方式、验收口径三件事写清楚，先过我们法务再发您——今天就能发。', why: '到签约只谈这三件事，别再把方案翻一遍。', stage: '成交签约' },
  { cue: '明确拒绝/不需要', re: /不需要|不用了|没人用|算了|不做了|暂时不|没这个需求|别打了/, say: '明白，不打扰您。就留一句：等您这边再上项目、或者要求变了，随时喊我，我按您的情况给方案。', why: '不纠缠，留个低压出口；之后归「沉默等需求」并给日期锚点。', stage: '' },
];
// 通话中「当前阶段该拿到的结果 + 第一句」（客户还没开口时，面板先给这一句）
const LIVE_STAGE_OPEN = {
  '线索获取': { say: '您好，我是负责智写工具的，您之前在官网申请过。占您两分钟——您最头疼的是写得慢，还是写完还要反复改？', next: '拿到一个具体痛点 + 一个时间点' },
  '客户触达': { say: '上次发您的资料看了吗？我就确认一件事：您这边是自己写，还是团队写？我好知道该讲哪块。', next: '确认使用场景 + 谁来用' },
  '需求挖掘': { say: '您一个项目从立项到可研交稿，大概多少天？卡在哪一步最多？', next: '问出时间线 / 卡点 / 谁拍板' },
  '产品演示': { say: '我不讲功能，直接拿您最近那个项目现场跑一遍，您看着时间就行。', next: '约一次带真实项目的演示' },
  '异议处理': { say: '您担心的这点，别人也问过。我给您一个能自己验证的办法。', next: '把异议转成可验证的试点' },
  '方案报价': { say: '报价我按您刚说的规模算，一次给您两档（基础 / 含私有化），您挑。', next: '拿到预算口 + 决策人 + 时间' },
  '成交签约': { say: '合同我把资料权属、部署方式、验收口径三件事写清楚，今天发您。', next: '发合同 / 定签约时间' },
  '': { say: '这通电话就拿到一件事：他现在最急的项目、和下一步时间。', next: '约下一步 + 定时间' },
};
const LIVE_STAGE_ACTION = {
  '异议处理': '把他的异议写成一条「可验证的问题」，下次通话用数据回答',
  '决策链摸排': '问出谁拍板 / 预算口在哪 / 他还需要谁点头',
  '产品演示': '定演示时间，并把时间写进排期（sales_log nextDate）',
  '需求挖掘': '问出时间线、卡点、使用人',
  '需求与现状勘察': '约一次现状勘察：现在流程、资料在哪、谁审',
  '方案与试点设计': '给出试点范围 + 基线指标（20 个真实任务）',
  '成交签约': '发合同（资料权属 / 部署方式 / 验收口径）并定签约时间',
  '商务推进': '把商务条款落到一页纸，找到对方接口人对',
};
function cmdLive(a) {
  const o = a && typeof a === 'object' ? a : {};
  const limit = Math.max(1, Math.min(5, Number(o.limit) || 3));
  const text = String(o.text == null ? '' : o.text).trim();   // 通话中最近几十秒的转写文本
  const flowRows = readFlow().rows;                            // 2026-10-08: 结果层要流水
  const rows = readMaster().rows;
  const kw = String(o.id == null ? '' : o.id).trim();
  let row = null, cands = [];
  if (kw) {
    const low = kw.toLowerCase();
    const hay = r => [r['客户ID'], r['公司'], r['姓名/联系人'], r['手机'], r['微信昵称'], r['城市'], r['原编号']].join(' ').toLowerCase();
    const hits = rows.filter(r => hay(r).includes(low));
    row = hits.find(r => String(r['客户ID'] || '').trim() === kw) || hits[0] || null;
    cands = hits.slice(0, 3).map(r => pickCust(r, true, flowRows).name);
  }
  const c = row ? pickCust(row, true, flowRows) : null;
  // 2026-10-09：客户被点名过结论（暂缓/沉默等需求）时，真实位置是结论里的「停在」那一段——
  //   主表阶段可能还停在更浅处（cmdSettle 只补写、不回退阶段），电话里要按 deeper 那段给话术。
  const res0 = row ? sopResultOf(row, flowRows) : null;
  const stuck = res0 && res0.stuckAt ? normStage(res0.stuckAt) : '';
  const stage = stuck && stageSeq(stuck) > (c ? (c.stageSeq || 0) : 0) ? stuck : (c ? c.stage : '');
  const effSeq = stageSeq(stage);
  const open = LIVE_STAGE_OPEN[stage] || LIVE_STAGE_OPEN[''];
  // 命中：playbook 顺序 = 基础优先级；出现在「最近一句」里的往前排（时效性）
  const tail = text.slice(-120);
  const cues = [];
  LIVE_PLAYBOOK.forEach((p, i) => {
    const g = new RegExp(p.re.source, 'g');
    const hits = []; let m;
    while ((m = g.exec(text)) && hits.length < 3) hits.push(m[0]);
    if (!hits.length) return;
    cues.push({ cue: p.cue, priority: i + 1, say: p.say, why: p.why, stage: p.stage || '', hits, hot: p.re.test(tail) });
  });
  cues.sort((x, y) => (Number(y.hot) - Number(x.hot)) || (x.priority - y.priority));
  // 推进建议：客户嘴里透出的阶段 > 客户当前阶段 → 建议照 SOP 往前推（stay 时不硬推）
  const moves = [];
  cues.forEach(x => {
    if (!x.stage || moves.some(mm => mm.stage === x.stage)) return;
    const to = stageSeq(x.stage);
    if (to && (!c || to > effSeq)) moves.push({ stage: x.stage, because: '客户在说「' + x.cue + '」', action: LIVE_STAGE_ACTION[x.stage] || open.next });
  });
  if (!moves.length) moves.push({ stage: c ? stage : '', because: text ? '客户还没透出可推进的点' : '还没转写到客户的话', action: open.next });
  return {
    ok: true, at: today(),
    id: c ? c.id : '', name: c ? c.name : '', contact: c ? c.contact : '', phone: c ? c.phone : '',
    customer: c ? { 姓名: c.contact || '', 公司: (c.name && c.name !== c.contact) ? c.name : '', 手机: c.phone || '', 微信昵称: '' } : null,
    level: c ? c.level : '', status: c ? c.status : '', track: c ? c.track : '',
    stage, stageSeq: effSeq, result: c ? c.result : '', progress: c ? c.progress : '', anchor: c ? c.anchor : '',
    candidates: cands.length > 1 ? cands : [],
    textLen: text.length, stageOpen: { stage, say: open.say, next: open.next },
    cues: cues.slice(0, limit), cueCount: cues.length, moves,
    note: text ? '' : '还没有转写到客户的话——先看 stageOpen 这句。',
  };
}

// ---------- 身份解析（2026-10-22 用户 m01260：第一锚点是手机号，没有手机号就拿关键字/词去比对） ----------
// 为什么要有这一层：侧栏 AI 在发模型前会把「今日实况」摘要做脱敏（A′ 档），模型看到的是
//   <单位8|咨询公司> 这种占位符，它没法靠猜知道那是哪家；而用户原话里明明写着公司名/联系人。
//   所以插件必须在**本地、遮罩之前**把人认出来，把「客户ID」交给模型（ID 是内部编号，不是身份信息）。
//   本层只读、纯现算、不落盘、不出网。
const RESOLVE_W = {
  id: 1000, phone: 900, wechat: 800, org: 700, orgShort: 560,
  contact: 500, orig: 420, note: 300, city: 180,
};
// 2026-10-22（m01260 自查）：行业通用词不是身份锚点。按「被包含」规则，它们会命中几乎每一行的
//   公司/简称（「公司」命中了「千忆…股份有限公司…」并给满权重 560），能把某一行顶成假唯一。
//   这类词只在用户**明确**要按行业筛时才该用（目前没有这个命令），检索里一律不当锚点。
const RESOLVE_GENERIC = new Set([
  '公司', '集团', '中心', '咨询', '咨询公司', '工程', '工程咨询', '设计', '建设', '管理',
  '科技', '技术', '服务', '有限', '分公司', '事务所', '研究院', '设计院', '大学', '学院',
  '项目', '客户', '系统', '平台', '单位', '企业', '老板', '负责人', '联系人',
]);
// 归一化：全角→半角、去空白与常见标点、小写。中文原样保留。
function normKey(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()【】\[\]「」『』《》〈〉,，。.;；:：!！?？、·\-—_/\\|'"“”‘’]/g, '')
    .toLowerCase();
}
// 公司简称：与 dsh/redact.js 的 shortOrg 同规则（数据层不能 import 插件，故各留一份，口径必须一致）
function shortOrgOf(company) {
  const full = String(company == null ? '' : company).trim();
  if (full.length < 5) return '';
  let s = full.replace(/[（(【\[][^）)】\]]*[)）】\]]/g, '');
  s = s.replace(/(股份有限公司|有限责任公司|有限公司|公司|集团|研究院|设计院|事务所|中心|大学|学院|厂|局)$/g, '');
  s = s.replace(/(科技|咨询|工程|评估|设计|建设|运营|管理|服务|实业|发展|投资|信息|技术)$/g, '');
  return (s.length >= 2 && s.length < full.length) ? s : '';
}
// 称谓剥离：「黄总」「王老师」「李经理」→ 黄 / 王 / 李（只留姓，按联系人前缀比对）
const RESOLVE_TITLE_RE = /(老师|总|经理|主任|院长|所长|先生|女士|工)$/;
function bareName(s) {
  return String(s == null ? '' : s).trim().replace(RESOLVE_TITLE_RE, '');
}
// 从一段自由文本里抽「像身份锚点」的片段
const ORG_SPAN_RE = /[\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}?(?:股份有限公司|有限责任公司|有限公司|公司|集团|设计院|研究院|事务所|中心|大学|学院|厂|局)/g;
const PERSON_SPAN_RE = /[\u4e00-\u9fa5]{1,3}(?:老师|总|经理|主任|院长|所长|先生|女士)/g;
const RESOLVE_CID_RE = /C-[\w\u4e00-\u9fa5]+-[\w\u4e00-\u9fa5]+-[\w\u4e00-\u9fa5]+/;
const RESOLVE_PHONE_RE = /(^|\D)(1[3-9]\d{9})(?!\d)/;
function extractTargets(text) {
  const s = String(text == null ? '' : text);
  const phone = (s.match(RESOLVE_PHONE_RE) || [])[2] || '';
  const cid = (s.match(RESOLVE_CID_RE) || [])[0] || '';
  const orgs = [];
  const contacts = [];
  let m;
  ORG_SPAN_RE.lastIndex = 0;
  while ((m = ORG_SPAN_RE.exec(s))) {
    const t = String(m[0] || '').replace(/^[（(【\[]+/, '').trim();
    if (t.length >= 4 && orgs.indexOf(t) < 0) orgs.push(t);
  }
  PERSON_SPAN_RE.lastIndex = 0;
  while ((m = PERSON_SPAN_RE.exec(s))) {
    const b = bareName(String(m[0] || ''));
    if (b && contacts.indexOf(b) < 0) contacts.push(b);
  }
  return { phone, cid, orgs, contacts };
}
// 双字组相似度（中文够用，比编辑距离稳）
function bigramSim(a, b) {
  const grams = (s) => { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
  const A = grams(a);
  const B = grams(b);
  if (!A.length || !B.length) return 0;
  let hit = 0;
  const pool = B.slice();
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length);
}
// 单个片段对一行客户的打分：返回 {score, matched, anchor}
function scoreRowBySpan(r, span, opt) {
  const q = normKey(span);
  if (!q) return { score: 0, matched: [], anchor: '' };
  const matched = [];
  let best = 0;
  let anchor = '';
  const test = (val, w, field, minLen, allowFuzzy, exactOnly) => {
    const v = normKey(val);
    if (!v) return 0;
    const min = minLen || 2;
    let s = 0;
    if (exactOnly) {
      // 客户ID 这类"独一无二的编号"只认精确：否则一段日期(10-21)会命中 ID 里的数字串
      if (v !== q) return 0;
      s = w * 2;
    } else if (v === q) s = w * 2;
    else if (q.length >= min && v.length >= q.length && v.indexOf(q) >= 0) s = w;
    else if (q.length >= min && v.length >= Math.max(3, min) && q.indexOf(v) >= 0) s = Math.round(w * 0.8);
    else if (allowFuzzy && q.length >= 4 && v.length >= 4 && bigramSim(v, q) >= 0.6) s = Math.round(w * 0.45);
    if (s > 0) {
      matched.push(field);
      if (s > best) { best = s; anchor = field; }
    }
    return s;
  };
  test(r['客户ID'], RESOLVE_W.id, 'id', 3, false, true);
  test(r['手机'], RESOLVE_W.phone, 'phone', 7);
  test(r['微信昵称'], RESOLVE_W.wechat, 'wechat', 2);
  test(r['公司'], RESOLVE_W.org, 'org', 4, true);
  const so = shortOrgOf(r['公司']);
  if (so) test(so, RESOLVE_W.orgShort, 'orgShort', 2);
  test(r['姓名/联系人'], RESOLVE_W.contact, 'contact', 2);
  test(r['原编号'], RESOLVE_W.orig, 'orig', 3);
  test(r['城市'], RESOLVE_W.city, 'city', 2);
  test(String(r['备注'] || '').slice(0, 300), RESOLVE_W.note, 'note', 2);
  let score = best;
  // 称谓：「黄总」→ 黄，按联系人前缀给弱分（单独出现定不了人，配合公司名一起用）
  if (opt && opt.bare && opt.bare.length >= 1 && opt.bare.length <= 2) {
    const ct = String(r['姓名/联系人'] || '').trim();
    if (ct && normKey(ct.slice(0, opt.bare.length)) === normKey(opt.bare)) {
      score += Math.round(RESOLVE_W.contact * 0.5);
      matched.push('contactTitle');
      if (!anchor) anchor = 'contactTitle';
    }
  }
  return { score, matched, anchor };
}
// 把「一句话/一个词」解析成候选客户（按分排序）
function resolveRows(input, rows) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return [];
  const t = extractTargets(text);
  const spans = [];
  if (t.cid) spans.push({ s: t.cid, bare: '' });
  if (t.phone) spans.push({ s: t.phone, bare: '' });
  for (const o of t.orgs.slice(0, 4)) spans.push({ s: o, bare: '' });
  for (const c of t.contacts.slice(0, 4)) spans.push({ s: c, bare: c });
  if (!spans.length) {
    // 没抽出结构：整句当一个词，再退到「按空白/标点切的词」（多词命中同一行会加分）
    // 2026-10-22：纯日期/纯短数字（10-21、2026、22）不当锚点——它们只会撞上 ID/备注里的数字串。
    // 2026-10-22（m01260 自查）：行业通用词（公司/集团/咨询/工程…）也不当锚点——「公司」会以
    //   「被包含」方式命中每一行的简称（千忆…股份有限公司…），实测能把某一行顶成 560 分假唯一，
    //   正好是「按名字搜成了天水那批」那种错认。
    const DATEISH_RE = /^\d{1,4}([-/.]\d{1,2}){0,2}$/;
    const usable = (x) => {
      const t2 = String(x || '').trim();
      if (!t2 || t2.length < 2) return false;
      if (DATEISH_RE.test(t2)) return false;
      if (/^\d{1,6}$/.test(normKey(t2))) return false;
      if (RESOLVE_GENERIC.has(normKey(t2))) return false;
      return true;
    };
    if (usable(text)) spans.push({ s: text, bare: '' });
    const parts = text.split(/[\s，。；、,.;：!！?？]+/).map((x) => x.trim()).filter(usable);
    if (parts.length > 1) for (const p of parts.slice(0, 4)) spans.push({ s: p, bare: '' });
    if (!spans.length) return [];   // 整句都是日期/数字：认不出人，就如实说没查到
  }
  const best = new Map();
  for (const sp of spans) {
    for (const r of rows) {
      const sc = scoreRowBySpan(r, sp.s, sp);
      if (!sc.score) continue;
      const id = String(r['客户ID'] || '').trim();
      const cur = best.get(id);
      if (!cur) best.set(id, { r, score: sc.score, matched: sc.matched.slice(), anchor: sc.anchor, spans: [sp.s] });
      else {
        cur.score += Math.round(sc.score * 0.6);   // 同一条被多个片段命中：加分（不翻倍，避免叠成一个假冠军）
        cur.spans.push(sp.s);
        for (const f of sc.matched) if (cur.matched.indexOf(f) < 0) cur.matched.push(f);
      }
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score);
}
// 出参：候选（带客户ID、匹配依据、唯一性）——dock 与 DSH 工具面共用
function cmdResolve(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '没给查询词：要手机号、客户ID、公司名、联系人或一句话', query: '', candidates: [] };
  const { rows } = readMaster();
  const flowRows = readFlow().rows;
  const rr = resolveRows(raw, rows);
  const t = extractTargets(raw);
  const anchors = [];
  if (t.cid) anchors.push('id');
  if (t.phone) anchors.push('phone');
  if (t.orgs.length) anchors.push('org');
  if (t.contacts.length) anchors.push('contact');
  const candidates = rr.slice(0, 8).map((x) => Object.assign(pickCust(x.r, false, flowRows), {
    score: Math.round(x.score), matched: x.matched, anchor: x.anchor, matchedText: x.spans.join(' / ').slice(0, 80),
  }));
  const top = candidates[0] || null;
  const second = candidates[1] || null;
  const unique = !!top && (!second || top.score >= second.score * 1.4) && top.score >= RESOLVE_W.contact;
  return {
    ok: true, query: raw, anchors, count: candidates.length, candidates, unique,
    ambiguous: !!top && !unique, topId: top ? top.id : '',
    note: !candidates.length ? '客户表里没有匹配（别猜，如实说没查到）'
      : (unique ? ('唯一命中 ' + top.id + '，直接用这个客户ID') : ('有 ' + candidates.length + ' 个候选，按客户ID区分')),
  };
}

// ---------- 命令: 查找客户 ----------
// 2026-10-22（用户 m01260）：原来是「整串子串 + slice(20)」，不认简称/分词/称谓、不搜备注，
//   空关键词还会静默返回前 20 条（看着像查到了）。现在改成与 resolve 同一套打分：
//   多字段、多片段、按分排序；空词直接报错（fail-closed，别拿"前 20 条"冒充结果）。
function cmdSearch(kw) {
  const { rows } = readMaster();
  const flowRows = readFlow().rows;   // 2026-10-08: 结果层要流水
  const k = String(kw == null ? '' : kw).trim();
  if (!k) return { keyword: kw, ok: false, error: '查询词为空（不知道要找谁）', count: 0, hits: [] };
  const rr = resolveRows(k, rows);
  const hits = rr.slice(0, 20).map((x) => Object.assign(pickCust(x.r, false, flowRows), {
    score: Math.round(x.score), matched: x.matched,
  }));
  return { keyword: kw, count: hits.length, hits };
}

// ==================== 行动引擎（2026-09-29 用户定：销售副驾，不是传统CRM）====================
// 三条铁律（改前必读）：
//   ① **只说事实**：输入只有「累计量差分」+「固定事实」两类 → 物理上不会说错时间。
//      **禁用维度**：`最后登陆时间` / `智写登录次数` 不得参与任何判定与话术。
//      原因（用户 2026-09-29 拍板）：导出表半个月一次，会移动的时间戳必然误判——宁可不说，不可说错。
//   ② **队列固定**：当天清单固定 N 条，「处理一个少一个」靠 `done` 标记，不靠删条目（同日输出恒定）。
//   ③ **每人必有归属**：要么在队列/排期/待定/批量池，要么是出口/挂起/闭环 —— 不许悬空（cmdCheck 报红）。
const SNAPSHOT_FILE = path.join(DIR, '用量快照.json');
const SNAPSHOT_ARCHIVE = path.join(DIR, '快照');
const SNAPSHOT_CYCLE_DAYS = 15;   // 建议导表周期（提醒阈值）
const SNAPSHOT_STALE_DAYS = 20;   // 快照容差：超过 → 增量类信号失效（降级「用量待确认」）
const COOLDOWN_DAYS = 7;          // 冷却：N 天内推过且无硬信号 → 降权（防同批人天天霸榜）
// 行动权重（**唯一来源**，要调手感只改这里）
const ACTION_WEIGHTS = {
  level: { SS: 50, S: 40, A: 30, B: 20, C: 10, '': 5 },   // 2026-10-13 加 SS（定制开发=最高）
  paid: 25, trialActive: 15,
  // 2026-10-22（用户 m00636）：最近活跃加分 —— 时间维度（最后登陆/注册/建档 ≤7 天）或
  //   「这一期有智写消耗增量」任一成立。**只加分不改卡**：没有信号的人不会因为活跃就凭空进队列。
  recentActive: 12,
  sig: {
    expiredPaid: 90, expire7: 100, expire14: 70, expire30: 40, trialExpired: 60,
    surge: 55, zero: 45, lowLeft: 60, newReg: 45, activated: 40,
    crossSell: 35, quoteStall: 65, stall: 50, overdue: 85, silent14: 30,
    firstTouch: 25, referral: 20, batch: 5,
    // 2026-10-08 D2 企业级（客单价高 → 权重高于标品同类）+ 培育轻触达
    entOpportunity: 70, entStall: 60, decisionChain: 65, pocReady: 55, entContract: 75,
    referralEnt: 45, nurtureDue: 15,
    // 2026-10-19 用户 m00409 四类节奏：标品成交每两周服务追踪 / 待定跟进超一周再跟
    //   （重点跟进不进队列、挂起冷备不再跟进 → 这两类**没有**队列信号，只走页面与断点）
    svcTrack: 45, pendingDue: 50,
  },
  exec: { phone: 5, wechat: 3 },
  cooldown: 0.5,
};
// 阶段停滞阈值（天）：超过 → 进队列表「推进或给结论」
// 2026-10-08 延伸 6 个企业级段：企业级周期长（决策链/勘察/方案/合同），阈值比标品宽；
//   「私有化签约」= 终点段，签约后的服务记录挂在本段之下，90 天不动才算停滞。
const STALL_DAYS = {
  '线索获取': 7, '客户触达': 14, '需求挖掘': 14, '产品演示': 14, '异议处理': 7, '方案报价': 7,
  '企业级机会': 10, '决策链摸排': 14, '需求与现状勘察': 14, '方案与试点设计': 14, '商务推进': 10, '私有化签约': 90,
};
// ---------- 企业级 + 培育轨常量（2026-10-08 D2）----------
// 培育节奏：结论「暂缓」（用户手动点名、必带锚点）的客户进培育池 —— **不催单、不排电话**，
//   每 NURTURE_CADENCE_DAYS 天一次轻触达（微信/短信发行业简报/新功能），有新版本可提前一次。
//   来由（用户 2026-10-08）：「有些客户暂时跟不下去」「沉默也是结果」+ 培育轨（标准 §十六）。
const NURTURE_CADENCE_DAYS = 30;
// ---------- 六类跟进节奏（2026-10-19 用户定，唯一来源，改节奏只改这里）----------
// 用户原话：「重点跟进：不用列入今日任务，我每天都会看；标品成交：每两周进行一次服务追踪；
//   待定跟进：距离上一次跟进超过一周则再次跟进；挂起冷备：不再跟进。」
// 落到引擎里就四句话（**全部纯派生，不落盘**，红线 10）：
//   focus    → 每天自己看（页面口径），**不进今日任务/电话队列**；due = 今天还没跟
//   standard → 每 14 天一次服务追踪（成交后服务：问使用效果/续费/转介绍），到点才派活
//   pending  → 距上次跟进 >7 天 → 拿出来再跟一次
//   cold     → 不再跟进（连提醒都不发）；只在「新功能上线」时由用户人工点名捞回
const FOCUS_CADENCE_DAYS = 1;
const STANDARD_CADENCE_DAYS = 14;
const PENDING_CADENCE_DAYS = 7;
const CADENCE_DEF = {
  focus: { days: FOCUS_CADENCE_DAYS, mode: 'daily', label: '重点跟进' },
  standard: { days: STANDARD_CADENCE_DAYS, mode: 'biweekly', label: '标品成交' },
  pending: { days: PENDING_CADENCE_DAYS, mode: 'stale', label: '待定跟进' },
  cold: { days: 0, mode: 'event', label: '挂起冷备' },
};
// 「新功能上线可捞回」标记（主表备注里带这些字样才算）——cmdCold 与 cadenceReport 共用同一个正则，
//   口径不许分叉（2026-10-19 实测：两处各写一份时 recallMarked 数出 3 vs 8 的不一致）
const RECALL_MARK_RE = /大更|新功能|捞回|★/;
// 企业级机会阈值：标品"用透了"才算信任到位（累计消耗 ≥2 万字 或 累计生成报告 ≥5 篇）
const ENT_OPP_MIN_COST = 20000;
const ENT_OPP_MIN_ART = 5;
// 企业级必备信息留痕（D3 写入路径；D2 先做读取侧）：沟通内容 = 【企业级】决策人=…｜预算口=…｜…
const ENT_TAG = '【企业级】';
const ENT_FACTS = ['决策人', '预算口', '资料权属', '安全要求', '试点范围'];
// 段位 → 行动场景（企业级一段只推一件事）；场景 → 一句话要点（D2 话术，素材见 营销资料库/企业级落地要点.md）
const ENT_STAGE_SCENE = {
  '企业级机会': '决策链摸排', '决策链摸排': '企业级机会', '需求与现状勘察': '现状勘察邀约',
  '方案与试点设计': '方案与试点设计', '商务推进': '私有化签约', '私有化签约': '企业级转介绍',
};
// 通用「推进企业级」信号只覆盖这 4 段；方案与试点设计 → pocReady、商务推进 → entContract 各自专属
const ENT_STALL_STAGES = { '企业级机会': 1, '决策链摸排': 1, '需求与现状勘察': 1, '私有化签约': 1 };
const ENT_SCENE_POINTS = {
  '企业级机会': '把"每份报告都重做一遍"换成"资料和流程沉淀成企业自己的智能体"',
  '企业级推进': '一段只推一件事：摸决策链 → 勘察 → 方案试点 → 商务 → 签约',
  '决策链摸排': '问三件事：谁牵头、预算走哪个口、今年信息化计划里有没有 AI 这一项',
  '现状勘察邀约': '带一份《资料清单＋权限矩阵》过一遍：哪些资料能用、谁能看、谁审',
  '方案与试点设计': '四模块（资料库/写作/审核/权限）＋试点范围＋基线指标，一次讲清',
  '试点验证': '先定基线，跑 20 个真实任务，再拿数据比对——试点不验收不扩大',
  '私有化签约': '安全边界（资料权属/权限/审核）、部署方式、验收口径，一次谈定',
  '企业级转介绍': '先问试点成效，再请他引荐同行或集团内其他板块',
  '行业简报': '一条行业动态/AI 政策，不带客户信息，不求回复',
  '新功能发布': '发新功能 + 一句"您那边这版能省哪一步"，不催单',
};
// ---------- D3 企业级推进（sales_enterprise）：一段三件事 + 该带的材料 ----------
const ENT_NEXT3 = {
  '企业级机会': ['问清谁牵头、预算走哪个口', '问今年信息化计划里有没有 AI 这一项', '约一次 30 分钟现状勘察'],
  '决策链摸排': ['补齐决策人 / 预算口两项台账', '确认资料权属与安全要求', '约现状勘察（带《资料清单＋权限矩阵》）'],
  '需求与现状勘察': ['把资料清单＋权限矩阵过一遍', '定试点范围与基线指标', '出方案四模块初稿'],
  '方案与试点设计': ['四模块＋试点范围＋基线指标讲一遍', '确认试点任务量（20 个真实任务）', '约试点启动会'],
  '商务推进': ['定验收口径（省了多少工时/返工）', '谈安全边界与部署方式', '推进立项与签约排期'],
  '私有化签约': ['签约材料与验收口径对齐', '排部署与培训计划', '试点成效出来后要转介绍'],
};
const ENT_MATERIALS = {
  '企业级机会': '《企业级落地要点》价值三点＋安全边界',
  '决策链摸排': '《企业级落地要点》必备信息五件套',
  '需求与现状勘察': '《资料清单＋权限矩阵》模板',
  '方案与试点设计': '方案四模块（资料库/写作/审核/权限）＋基线指标表',
  '商务推进': '验收口径清单（省工时 / 少返工 / 可追溯）',
  '私有化签约': '安全边界＋部署方式＋验收口径一页纸',
  '企业级转介绍': '试点成效对比数据',
};
// 机构型客户弱信号（咨询/设计院/勘察/规划/研究）——**只作候选排序提示，绝不当作结论**
const ENT_CONSULT_RE = /咨询|设计院|设计|勘察|规划|研究院|研究|院/;

function numFrom(v) { const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : 0; }
function fmtW(v) { const n = numFrom(v); return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万' : String(n); }
// 2026-10-22 用户：「只展示小数点后两位，单位定为万元」。
//   库里存**元**（付款总额等字段单位不变），只有**展示**才换算成 X.XX 万元；
//   顺手灭掉累加出来的浮点尾巴（73296.49999999999 这种是浮点累加误差，不是客户数据）——
//   先按分四舍五入再换算，界面上永远只出现两位小数。
function fmtMoneyWan(v) {
  const n = numFrom(v);
  if (!Number.isFinite(n)) return '0.00 万元';
  return (Math.round(n * 100) / 100 / 10000).toFixed(2) + ' 万元';
}
// 纯日历天数差 a-b（兼容序列号/字符串，UTC 计算，不受 DST 影响）
function dayDiffStr(a, b) {
  const pa = parseDate(a), pb = parseDate(b);
  if (!pa || !pb) return null;
  return Math.round((Date.UTC(pa.getUTCFullYear(), pa.getUTCMonth(), pa.getUTCDate())
    - Date.UTC(pb.getUTCFullYear(), pb.getUTCMonth(), pb.getUTCDate())) / 86400000);
}
// ---------- 用量快照层（import-platform.cjs --write 落盘；引擎只读）----------
// 2026-10-08 审计 A10：`refreshedAt` 原来只判真假不判**能不能解析**。畸形值（如 'yesterday'、
//   Excel 序列号、数字）会造成两个后果：① `snapshotAge` 返回 null → `snapshotInfo` 把 level 判成
//   'fresh'（fail-open：数据其实过期/不可信，却告诉用户"新鲜"）；② `.slice(5)` 对数字直接抛
//   TypeError，穿透 buildActionContext，让 cmdFirstCall/cmdPlan/cmdCheck 整体 500。
//   修法：读入即**规范化**（normDateStr 吃 YYYY-MM-DD / 序列号 / 8 位数字 / Date）；解析不了就
//   当作"没有快照"（fail-closed：增量类信号全部停用），绝不放行。
function readSnapshot() {
  try {
    const j = JSON.parse(require('fs').readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (!j || !j.usage || !j.refreshedAt) return null;
    const d = normDateStr(j.refreshedAt);
    if (!d) return null;
    return Object.assign({}, j, { refreshedAt: d });
  } catch (e) { return null; }
}
function snapshotAge(latest) { return latest ? dayDiffStr(today(), latest.refreshedAt) : null; }
function listSnapshotArchives() {
  try { return require('fs').readdirSync(SNAPSHOT_ARCHIVE).filter(f => /^用量-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); }
  catch (e) { return []; }
}
function readPrevSnapshot(latest) {
  if (!latest) return null;
  const files = listSnapshotArchives().filter(f => f.slice(3, 13) < latest.refreshedAt);
  if (!files.length) return null;
  try {
    const j = JSON.parse(require('fs').readFileSync(path.join(SNAPSHOT_ARCHIVE, files[files.length - 1]), 'utf8'));
    if (!j || !j.usage) return null;
    // 审计 A10：归档快照同样规范化 refreshedAt（差分算周期天数时要用）
    const d = normDateStr(j.refreshedAt) || String(files[files.length - 1]).slice(3, 13);
    return Object.assign({}, j, { refreshedAt: d });
  }
  catch (e) { return null; }
}
// 两期差分：累计量相减 = 这半个月**真发生的事**（不是"最后登录时间"那种会移动的时间戳）
function diffSnapshot(latest, prev) {
  const out = {};
  if (!latest || !latest.usage) return out;
  Object.keys(latest.usage).forEach(id => {
    const cur = latest.usage[id] || {};
    const old = (prev && prev.usage && prev.usage[id]) || null;
    const curCost = numFrom(cur.cost), oldCost = numFrom(old && old.cost);
    out[id] = {
      firstSeen: !old, cost: curCost, left: numFrom(cur.left), buy: numFrom(cur.buy),
      art: numFrom(cur.art), zx: numFrom(cur.zx),
      prevCost: old ? oldCost : null,
      dCost: old ? curCost - oldCost : null,
      dArt: old ? numFrom(cur.art) - numFrom(old.art) : null,
      dZx: old ? numFrom(cur.zx) - numFrom(old.zx) : null,
      dBuy: old ? numFrom(cur.buy) - numFrom(old.buy) : null,
    };
  });
  return out;
}
function snapshotInfo(ctx) {
  const latest = ctx.latest, age = ctx.age;
  // 审计 A10：age 解析不出来 → 按最坏情况判 stale（fail-closed），绝不判 fresh
  const level = !latest ? 'none'
    : (age === null ? 'stale' : (age > SNAPSHOT_STALE_DAYS ? 'stale' : (age >= SNAPSHOT_CYCLE_DAYS ? 'due' : 'fresh')));
  const label = !latest ? '无用量快照（增量类信号停用）'
    : ('用量数据截至 ' + latest.refreshedAt.slice(5) + '（' + age + ' 天前'
      + (level === 'due' ? '，该导表了' : level === 'stale' ? '，增量类信号已停用' : '') + '）');
  return { refreshedAt: latest ? latest.refreshedAt : '', age, cycleDays: SNAPSHOT_CYCLE_DAYS, staleDays: SNAPSHOT_STALE_DAYS, level, label, hasSnap: !!latest };
}
function buildActionContext(preRows, preFlowRows) {
  const T = today();
  const rows = preRows || readMaster().rows;
  const flowRows = preFlowRows || readFlow().rows;
  const byCust = new Map();
  flowRows.forEach(f => {
    if (!isFollowRecord(f)) return;          // 2026-09-29: 行动引擎只认常规跟进流水（变更留痕不算"跟过"）
    const id = String(f['客户ID'] || '').trim();
    if (!byCust.has(id)) byCust.set(id, []);
    byCust.get(id).push(f);
  });
  byCust.forEach(list => list.sort((a, b) => String(a['日期'] || '').localeCompare(String(b['日期'] || '')) || String(a['流水ID'] || '').localeCompare(String(b['流水ID'] || ''))));
  const latest = readSnapshot();
  const age = snapshotAge(latest);
  const prev = readPrevSnapshot(latest);
  return {
    T, rows, flowRows, byCust, latest, prev, age,
    entIdx: indexEnterprise(flowRows),      // 企业级台账（2026-10-08 D2）：每客户解析一次，别逐客户重扫
    touchIdx: indexLastTouch(flowRows),     // 上次触达（2026-10-08 D2）：培育节奏用
    diff: diffSnapshot(latest, prev),
    stale: latest ? (age !== null && age > SNAPSHOT_STALE_DAYS) : true,
  };
}
// ---------- 话术：复用现有场景引擎（SCENE_OPEN/SCENE_MSG + 示例语料），不另起一套 ----------
function pickTipByScene(scene, used) {
  const db = loadTipsDb();
  if (!db.length) return null;
  const kws = (TIP_KEYWORD_MAP[scene] || []).map(s => String(s).toLowerCase());
  if (!kws.length) return null;
  let best = null, bs = 0;
  db.forEach(d => {
    if (used && used.has(d.序号)) return;
    const t = String(d.标题 || '').toLowerCase();
    const g = (d.标签 || []).join(' ').toLowerCase();
    const a = String(d.摘要 || '').toLowerCase();
    let s = 0;
    kws.forEach(k => { if (t.includes(k)) s += 3; if (g.includes(k)) s += 2; if (a.includes(k)) s += 1; });
    if (s > bs) { bs = s; best = d; }
  });
  return best;
}
function cleanWho(c) {
  const n = String(c['姓名/联系人'] || '').trim();
  return (!n || /^匿名|未知|^xj$/i.test(n)) ? '您' : n;
}
// 2026-10-08 审计 A3：匿名客户 cleanWho 返回「您」，而 40+ 处模板统一写成 `${who}您好`
//   → 拼出「您您好」发给客户（真表 627/850 命中，cmdNext 实测 80/80 全是这个开口）。
//   不去改 40+ 处模板（改漏一处就复发），改成**在出口收口**：所有话术出口一律过 sanitizeGreeting。
function sanitizeGreeting(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/您您好/g, '您好')       // 匿名客户 + 模板「{who}您好」
    .replace(/您好您好/g, '您好');
}
function buildHow(card, c, last) {
  const scene = (card && card.scene) || '跟进推进';
  const tip = pickTipByScene(scene);
  return sanitizeGreeting(buildFollowScript(scene, tip, last, Object.assign({}, c, { '姓名/联系人': cleanWho(c) })));
}
// ---------- 2026-10-22（用户 m02366「都修」）：开场一律用库里的原文 ----------
//   背景：dock 里的 AI 会自己写「开场」，措辞飘、还问过「这些话术是调库生成的吗」（m02291）。
//   口径：开场句子由本机模板引擎出（场景模板 SCENE_MSG + 资料要点 + 客户字段），
//   模型只许挑、只许删，**不许改写**；插件把这句原文随【本次提到的客户】一起贴给模型。
function openLineOf(r, ctx) {
  const id = String((r && r['客户ID']) || '').trim();
  const card = buildActionCard(r, ctx) || {};
  const scene = String(card.scene || '跟进推进');
  const flows = (ctx && ctx.byCust && ctx.byCust.get(id)) || [];
  const last = flows.length ? flows[flows.length - 1] : null;
  const tip = pickTipByScene(scene);
  const full = buildFollowScript(scene, tip, last, Object.assign({}, r, { '姓名/联系人': cleanWho(r) }));
  // full 形如「—— 可直接复制发给客户（微信/短信）——\n<开场正文>\n\n【本次跟进要点】…」：只要正文那段
  const body = String(full || '').split('\n\n')[0].split('\n');
  const open = body.slice(1).join('\n').trim();
  return {
    id,
    name: String((r && (r['公司'] || r['姓名/联系人'])) || ''),
    scene,
    action: String(card.action || ''),
    open,
  };
}
function cmdOpen(input) {
  const q = String(input == null ? '' : (typeof input === 'object' ? (input.id || input.q || input.text || '') : input)).trim();
  if (!q) return { ok: false, error: '没给客户：要客户ID、公司名或手机号' };
  const ctx = buildActionContext();
  const idW = q.toUpperCase();
  let r = (ctx.rows || []).find(x => String(x['客户ID'] || '').trim().toUpperCase() === idW) || null;
  if (!r) {
    const rr = resolveRows(q, ctx.rows || []);
    if (rr.length) r = rr[0].r;
  }
  if (!r) return { ok: false, error: '未找到客户 ' + q + '（客户表里没有匹配）' };
  const o = openLineOf(r, ctx);
  if (!o.open) return Object.assign({ ok: false, error: '这个客户这一轮没有可用的开场（场景模板没出词），别现编' }, o);
  return Object.assign({ ok: true, source: '模板' }, o);
}
// 分支处置提示（接通/没接/说贵/没需求）——按动作给，不按客户给
const BRANCH_HINTS = {
  '谈续费': ['接通：先问用得顺不顺、卡在哪，再谈续费或升级（二选一，别开放式问）', '没接：隔天微信补一句"还剩 X 天到期"，别连打', '说贵：把这一期实际消耗量摆出来，按用量摊成本'],
  '续费挽回': ['接通：先认过期没提醒到位，再给一个"重启"的具体好处', '没接：换微信留一条轻钩子，三天后再打一次', '说不需要：问清是没项目还是换人了，直接判出口别拖着'],
  '复活促销': ['接通：问他上次试用卡在哪一步，给一次我带您跑通', '没接：发一条"我帮您把上次没跑完的报告补上"', '说没需求：问下一个项目什么时候，转待定'],
  '趁势推进': ['接通：趁热敲下一步（约演示/发方案），别重讲价值', '没接：当天再补一条微信，把"用量涨了"当由头', '说再想想：问清是预算还是效果顾虑'],
  '问项目节奏': ['接通：不问他"怎么不用了"，问"下一个项目什么时候上"', '没接：微信发一句"要不要我把新版的政企分类型模板发您"', '说换人了：要到新联系人，老的转出口'],
  '推增购': ['接通：把"再买多少够用到什么时候"算给他看', '没接：发一条余额提醒 + 一句建议量', '说够用：问下一个项目规模，要不要提前备量'],
  '激活指导': ['接通：先问他卡在哪一步，别念产品说明', '没接：微信发"我远程带您跑一遍，10 分钟出报告"', '说不会用：约个具体时间做陪跑'],
  '联售智写': ['接通：用 V3.0 的"智算项目数据一键出可研"当切口', '没接：发一条演示短视频/截图', '说先看看：约一次 20 分钟的实操演示'],
  '联售智算': ['接通：问他可研的报告里财务测算章节怎么做的', '没接：发一份带财务分析章节的样例报告', '说用不上：问项目类型（政府/企业）再定'],
  '催决策': ['接通：不催"考虑得怎么样"，给一个明确的下一步选择', '没接：发一句"这周先帮您把方案里的两点改好再发您"', '说等领导：问清领导关心什么，帮他准备一页纸'],
  '推进或给结论': ['接通：要么拿到下一个明确动作（时间+事），要么这次就判结论', '没接：微信留一条，仍无回应则进出口', '说暂时不跟：直接给结论（推进终止/无法联系），别挂着'],
  '按排期跟进': ['接通：按上次约的事接着聊，别重复', '没接：换微信，另约时间', '有异议：先处理异议再推进'],
  '激活': ['接通：用"最近忙啥"破冰，别一上来就催', '没接：微信留一条新信息（案例/新版本）', '说没动静：问项目节奏，转待定或出口'],
  '首触': ['接通：一句话说清我是谁、为什么找他，争取愿意聊两句', '没接：隔天换微信加一条，第三次仍不接转批量', '说不感兴趣：问一句"那您最近用得上吗"，没戏就判出口'],
  '批量触达': ['微信/短信群发：别打电话，占额度不划算', '回复的：当天转成电话跟进，进队列', '不回：留在批量池，下一轮导表后再筛'],
  '老客维护转介绍': ['接通：先关心使用效果，再自然开口请转介绍', '没接：微信问候 + 一句"有同行也做这行吗"', '说效果一般：先解决卡点，转介绍押后'],
  // 2026-10-08 D2 企业级 + 培育轨分支（一条动作三句：接通 / 没接 / 说X）
  '谈企业级落地': ['接通：从"每份报告都要重做一遍"切进去，落到"把资料和流程沉淀成企业自己的智能体"', '没接：微信发一句"想跟您聊个把资料沉淀下来的思路，不占您时间"', '说用不上：先问清是量太小还是没人管，量小的留标品轨道继续服务'],
  '推进企业级': ['接通：先说这次只办一件事（摸决策链/看资料/定试点），别堆方案', '没接：微信发一条"按您的节奏来，这周就确认一件事"', '说在等：问清等谁、等什么，把下一步写进下次跟进时间'],
  '摸决策链': ['接通：只问三件事——谁牵头、预算走哪个口、今年信息化计划里有没有 AI', '没接：微信发一句"想先问清楚怎么推对您最省事"', '说不知道：退一步问"那这活儿平时谁最关心结果"'],
  '推试点验证': ['接通：先定基线（一个项目多少工、返工几次），再谈跑 20 个真实任务', '没接：微信发一句"试点我先不扩，跑完拿数给您看"', '说没时间：把试点缩到 1 个项目，问哪个最合适'],
  '推签约': ['接通：三件事一次说清——资料权属与权限、部署方式、验收口径', '没接：微信发"条款我先过法务再发您，省得来回改"', '说法务卡住：要到法务的具体意见，逐条回，别硬顶'],
  '企业级转介绍': ['接通：先对试点成效，成效好再请他引荐同行或集团其他板块', '没接：微信发一句"想请您帮个小忙，方便时回我"', '说先别说：先问是不是哪儿没做到位，把问题解决了再提'],
  '发行业简报': ['微信/短信发一条行业动态或新政策，**不打电话**', '不回：正常，留在培育池，下个周期再发', '回了：当天转成电话跟进，进队列'],
};
const BATCH_SCRIPT = '【批量触达话术（不占电话额度，微信/短信照抄）】\n'
  + 'A. 有消耗没付费：「X 老师您好，看到您在写可研（已生成 N 篇），这周我们更新了政府/企业分类型一键生成，还有个"智算数据直接出报告"的功能。要不要我发您 3 分钟演示，您先看看？」\n'
  + 'B. 注册了没用过：「X 老师您好，看您注册了但还没上手过。我把操作步骤整理成 3 步发您，或者我远程带您跑一份，10 分钟出初稿——您看哪个方便？」\n'
  + 'C. 长期沉默：「X 老师您好，好久没打扰了。最近我们更新了不少（政策库、市场分析图表），有项目要写可研的话随时喊我，我帮您排个演示。」';

// ---------- 企业级台账派生（读【企业级】留痕；不新增列 / 不新增文件）----------
// 格式：【企业级】决策人=张院长｜预算口=集团信息中心｜资料权属=院方｜安全要求=本地部署｜试点范围=可研一处
//   缺项 = 「必备信息缺口」的**唯一来源**（D3 的 sales_enterprise / brief 用它）。
//   D2 先落读取侧：有了它，decisionChain 信号才知道"决策人摸没摸清"。
function parseEnterprise(f) {
  const t = String((f && f['沟通内容']) || '').trim();
  if (t.indexOf(ENT_TAG) !== 0) return null;
  const out = {};
  t.slice(ENT_TAG.length).split(/[｜|]/).forEach(seg => {
    const m = seg.match(/^\s*([^=＝:：]+)\s*[=＝:：]\s*(.+?)\s*$/);
    if (m) out[m[1].trim()] = m[2].trim();
  });
  return Object.keys(out).length ? out : null;
}
function entFactsOf(flowRows, id) {
  const facts = {}; let date = '';
  (flowRows || []).forEach(f => {
    if (String(f['客户ID'] || '').trim() !== String(id || '').trim()) return;
    const p = parseEnterprise(f);
    if (!p) return;
    Object.assign(facts, p);
    const d = String(f['日期'] || '').slice(0, 10);
    if (d >= date) date = d;
  });
  const missing = ENT_FACTS.filter(k => !facts[k]);
  return { facts, missing, date, filled: ENT_FACTS.length - missing.length };
}
const EMPTY_ENT = { facts: {}, missing: ENT_FACTS.slice(), date: '', filled: 0 };
// 批量索引：buildActionContext 预计算一次（850 客户 × 391 流水，别逐客户重扫）
function indexEnterprise(flowRows) {
  const m = new Map();
  (flowRows || []).forEach(f => {
    const id = String(f['客户ID'] || '').trim();
    if (!id) return;
    const p = parseEnterprise(f);
    if (!p) return;
    const cur = m.get(id) || { facts: {}, date: '' };
    Object.assign(cur.facts, p);
    const d = String(f['日期'] || '').slice(0, 10);
    if (d >= cur.date) cur.date = d;
    m.set(id, cur);
  });
  m.forEach(v => { v.missing = ENT_FACTS.filter(k => !v.facts[k]); v.filled = ENT_FACTS.length - v.missing.length; });
  return m;
}
// 上次触达：最后一次**常规跟进**流水日期，与最近一次【结论】日期取较晚者（留痕不算触达）
function lastTouchOf(flowRows, id) {
  let base = '';
  (flowRows || []).forEach(f => {
    if (String(f['客户ID'] || '').trim() !== String(id || '').trim()) return;
    if (!isFollowRecord(f)) return;
    const d = String(f['日期'] || '').slice(0, 10);
    if (d > base) base = d;
  });
  const con = lastConclusionOf(flowRows, id);
  if (con && con.date > base) base = con.date;
  return base;
}
function indexLastTouch(flowRows) {
  const m = new Map();
  (flowRows || []).forEach(f => {
    if (!isFollowRecord(f)) return;
    const id = String(f['客户ID'] || '').trim(); if (!id) return;
    const d = String(f['日期'] || '').slice(0, 10);
    if (d > (m.get(id) || '')) m.set(id, d);
  });
  (flowRows || []).forEach(f => {
    if (!parseConclusion(f)) return;   // 只认【结论】（不是所有留痕）
    const id = String(f['客户ID'] || '').trim(); if (!id) return;
    const d = String(f['日期'] || '').slice(0, 10);
    if (d > (m.get(id) || '')) m.set(id, d);
  });
  return m;
}
function datePlusDays(base, n) {
  const s = dateToSerial(base);
  if (!Number.isFinite(s)) return '';
  const d = parseDate(Math.floor(s) + Number(n || 0));
  return d ? normDateStr(d) : '';
}
// ---------- 培育节奏（2026-10-08 D2）----------
// 返回 null = 不在培育池（只有用户手动点名结论「暂缓」的才在池里）；
//   在池 = { inPool, base, days, due, nextDue, anchor, stuckAt, cadence }
function nurtureDueOf(row, flowRows, T, base) {
  const rr = sopResultOf(row, flowRows);
  if (rr.result !== '暂缓') return null;
  const id = String((row && row['客户ID']) || '').trim();
  const b = base === undefined ? lastTouchOf(flowRows, id) : base;
  const tt = T || today();
  const days = b ? dayDiffStr(tt, b) : null;
  const due = days === null ? true : days >= NURTURE_CADENCE_DAYS;
  return {
    inPool: true, base: b, days, due, anchor: rr.anchor, stuckAt: rr.stuckAt,
    cadence: NURTURE_CADENCE_DAYS, nextDue: b ? datePlusDays(b, NURTURE_CADENCE_DAYS) : '',
  };
}
// 培育轻触达话术（微信/短信，**不打电话**）
function buildNurtureScript(scene, c) {
  const who = cleanWho(c);
  const msg = (SCENE_MSG[scene] || SCENE_MSG['行业简报'])({ who, what: '', react: '', whatPhrase: '上次聊的事', point: ENT_SCENE_POINTS[scene] || '' });
  return sanitizeGreeting('—— 可直接复制发给客户（微信用，不打电话）——\n' + msg
    + '\n\n【轻触达纪律】不占电话额度；一条就够，不求回复；客户回了当天转成电话跟进（按 action 队列排）。');
}
// 培育卡：结论「暂缓」的客户只走轻触达，不进电话队列（用户人工点了暂缓，别自动拉回）
function buildNurtureCard(r, ctx, nd) {
  const id = String(r['客户ID'] || '').trim();
  const level = String(r['客户等级'] || '').trim();
  const stage = normStage(r['意向阶段']);
  const due = !!nd.due;
  const scene = due ? '行业简报' : '新功能发布';
  const action = due ? '发行业简报' : '培育观望';
  const why = due
    ? ('培育池到点：距上次触达 ' + (nd.days === null ? '-' : nd.days) + ' 天（节奏 ' + NURTURE_CADENCE_DAYS + ' 天），发一条行业动态/新功能，不占电话额度' + (nd.anchor ? '；复查锚点 ' + nd.anchor : ''))
    : ('培育池：距上次触达 ' + (nd.days === null ? '-' : nd.days) + ' 天，' + (nd.nextDue || '') + ' 到点，先不动');
  const score = Math.round(
    (ACTION_WEIGHTS.level[level] !== undefined ? ACTION_WEIGHTS.level[level] : ACTION_WEIGHTS.level[''])
    + (ACTION_WEIGHTS.sig.nurtureDue || 10)
    + (String(r['微信昵称'] || '').trim() ? ACTION_WEIGHTS.exec.wechat : 0));
  return {
    id, name: r['公司'] || r['姓名/联系人'] || id, level: level || '未定级', stage, stageSeq: stageSeq(stage),
    status: String(r['跟进状态'] || '').trim(), tier: 'T3', action, why,
    deadline: due ? '批量' : (nd.nextDue || '批量'), scene, hard: false,
    signals: [{ key: 'nurtureDue', action, why }], noPhone: !String(r['手机'] || '').trim(), score,
    nurture: { cadence: nd.cadence, base: nd.base, days: nd.days, due, anchor: nd.anchor, nextDue: nd.nextDue },
  };
}
// 培育池清单（轻触达批次，**不占电话额度**）：D2 只给清单+话术；投放并入 D5 的 sales_campaign
//   opts.all=true    → 池子全量（含未到点）
//   opts.release=true → 有新版本/新功能，允许提前一次（全部视为可发）
function nurtureList(ctx, opts) {
  const o = opts || {};
  const T = (ctx && ctx.T) || today();
  const rows = (ctx && ctx.rows) || readMaster().rows;
  const flowRows = (ctx && ctx.flowRows) || readFlow().rows;
  const touchIdx = (ctx && ctx.touchIdx) || indexLastTouch(flowRows);
  const out = [];
  rows.forEach(r => {
    const st = String(r['跟进状态'] || '').trim();
    if (st === '已闭环') return;                       // 已闭环 = 终态，不培育
    const id = String(r['客户ID'] || '').trim();
    const nd = nurtureDueOf(r, flowRows, T, touchIdx.get(id) || '');
    if (!nd) return;
    if (!nd.due && !o.release && !o.all) return;
    const rel = !!o.release;
    const scene = (rel || !nd.due) ? '新功能发布' : '行业简报';
    out.push({
      id, name: r['公司'] || r['姓名/联系人'] || id, level: r['客户等级'] || '未定级',
      status: st, phone: String(r['手机'] || ''), wechat: r['微信昵称'], channel: '微信/短信',
      scene, due: !!nd.due, anchor: nd.anchor, stuckAt: nd.stuckAt, base: nd.base, days: nd.days,
      nextDue: nd.nextDue, cadence: NURTURE_CADENCE_DAYS,
      why: nd.due
        ? ('培育池到点：距上次触达 ' + (nd.days === null ? '-' : nd.days) + ' 天（节奏 ' + NURTURE_CADENCE_DAYS + ' 天）' + (rel ? '；有新版本/新功能可提前一次' : '') + '，发一条行业简报，不占电话额度')
        : ('培育池：距上次触达 ' + (nd.days === null ? '-' : nd.days) + ' 天，' + (nd.nextDue || '') + ' 到点'),
      script: buildNurtureScript(scene, r),
    });
  });
  out.sort((a, b) => (b.days === null ? -1 : b.days) - (a.days === null ? -1 : a.days) || String(a.id).localeCompare(String(b.id)));
  return out;
}
// 培育池概览（cmdPlan / cmdBrief 用；**一次扫描**，别在循环里反复算）
function nurtureInfo(ctx) {
  const all = nurtureList(ctx, { all: true });
  const due = all.filter(x => x.due);
  return {
    cadenceDays: NURTURE_CADENCE_DAYS, pool: all.length, due: due.length,
    list: due.slice(0, 10), poolTop: all.slice(0, 10),
  };
}
// ---------- 四类跟进节奏引擎（2026-10-19 用户 m00409 定；纯派生，绝不写盘）----------
// 一句话口径（与文件头 CADENCE_DEF 一致）：
//   focus    每天自己看 → 今天还没跟 = due（但**不进今日任务**，只做页面断点）
//   standard 每 14 天一次服务追踪 → 距上次触达 ≥14 天才 due
//   pending  距上次跟进 >7 天 → due
//   cold     不再跟进 → 永不 due（只有用户人工点名「新功能上线」才捞回，见 cmdCold 的 recallMarked）
// 返回 null = 该客户不在这个节奏里；否则 {bucket, cadence, base, days, due, nextDue, anchor}
//   base = 上次触达日（常规跟进/结论取晚，见 lastTouchOf）；无记录按建档日期兜底；
//   days = 距今日历天数（null = 既无流水也无建档日，视为"从没跟过"→ 直接 due）
function cadenceDueOf(row, flowRows, T, bucket, base) {
  const key = bucket || bucketOf(row, flowRows);
  const def = CADENCE_DEF[key];
  if (!def) return null;
  const tt = T || today();
  if (def.mode === 'event') {
    // 挂起冷备：不再跟进。base/days 照算只为展示"冷了多久"，due 恒 false
    const b0 = base === undefined ? lastTouchOf(flowRows, String((row && row['客户ID']) || '').trim()) : base;
    const b = b0 || normDateStr((row && row['建档日期']) || '');
    const days0 = b ? dayDiffStr(tt, b) : null;
    return { bucket: key, cadence: 0, mode: def.mode, base: b, days: days0, due: false, nextDue: '', anchor: '' };
  }
  const b0 = base === undefined ? lastTouchOf(flowRows, String((row && row['客户ID']) || '').trim()) : base;
  const b = b0 || normDateStr((row && row['建档日期']) || '');
  const days = b ? dayDiffStr(tt, b) : null;
  // focus 是"每天"节奏：今天没跟就是 due（days >= 1）；从没跟过 → due
  const due = days === null ? true : days >= def.days;
  const anchor = normDateStr((row && row['复查锚点']) || '');
  return {
    bucket: key, cadence: def.days, mode: def.mode, base: b, days, due,
    nextDue: b ? datePlusDays(b, def.days) : '',
    anchor: key === 'pending' ? (anchor || normDateStr((row && row['下次跟进时间']) || '')) : anchor,
  };
}
// 四类节奏总览（cmdPlan / cmdBrief 的 cadence 段；一次扫描，别在循环里反复算）
// 返回 { focus:{...}, standard:{...}, pending:{...}, cold:{...}, list: [...] }
//   focus.list   = 今天还没跟的重点跟进（**只是断点提示，不进电话队列**）
//   standard.list= 到点该做服务追踪的成交客户
//   pending.list = 超 7 天没跟的待定客户
//   cold.list    = 恒空（不再跟进）；只带 recallMarked 计数
function cadenceReport(ctx) {
  const c = ctx || buildActionContext();
  const T = c.T || today();
  const rows = c.rows || [];
  const flowRows = c.flowRows || [];
  const touchIdx = c.touchIdx || indexLastTouch(flowRows);
  const out = { date: T, focus: [], standard: [], pending: [], cold: [], recallMarked: 0, def: CADENCE_DEF };
  const bucketOfRow = r => bucketOf(r, flowRows);
  rows.forEach(r => {
    const bk = bucketOfRow(r);
    if (!CADENCE_DEF[bk]) return;
    const id = String(r['客户ID'] || '').trim();
    const nd = cadenceDueOf(r, flowRows, T, bk, touchIdx.get(id) || '');
    if (!nd) return;
    if (bk === 'cold') {
      // 挂起冷备：不再跟进；只有备注带 ★/大更/新功能/捞回 的才计入"可捞回"（等用户点名）
      //   口径与 cmdCold 的 recallMarked 必须一致：只数**未终态**（active）的那批
      if (bucketTerminal(r)) return;
      if (RECALL_MARK_RE.test(String(r['备注'] || ''))) out.recallMarked++;
      return;
    }
    if (!nd.due) return;
    const item = Object.assign({ id, name: r['公司'] || r['姓名/联系人'] || id, level: r['客户等级'] || '未定级', status: String(r['跟进状态'] || '').trim(), phone: String(r['手机'] || ''), wechat: String(r['微信昵称'] || '') }, nd);
    out[bk].push(item);
  });
  ['focus', 'standard', 'pending'].forEach(k => {
    out[k].sort((a, b) => (b.days === null ? 99999 : b.days) - (a.days === null ? 99999 : a.days) || String(a.id).localeCompare(String(b.id)));
  });
  out.focusCount = out.focus.length;
  out.standardCount = out.standard.length;
  out.pendingCount = out.pending.length;
  out.note = '四类节奏：重点跟进每天自己看（不进今日任务）/ 标品成交每 ' + STANDARD_CADENCE_DAYS + ' 天服务追踪一次 / 待定跟进超 ' + PENDING_CADENCE_DAYS + ' 天再跟 / 挂起冷备不再跟进（仅新功能上线人工捞回）';
  return out;
}
// ---------- 行动卡：信号 → 动作（纯派生，绝不写盘）----------
function buildActionCard(r, ctx) {
  const id = String(r['客户ID'] || '').trim();
  const flows = ctx.byCust.get(id) || [];
  const last = flows.length ? flows[flows.length - 1] : null;
  const stage = normStage(r['意向阶段']);
  const status = String(r['跟进状态'] || '').trim();
  const level = String(r['客户等级'] || '').trim();
  const paid = String(r['是否购买'] || '').trim() === '是';
  const expire = normDateStr(r['到期时间']);
  const expDays = expire ? dayDiffStr(expire, ctx.T) : null;
  const cost = numFrom(r['智写消耗字数']), left = numFrom(r['智写剩余字数']), buy = numFrom(r['智写购买字数']);
  const art = numFrom(r['智写文章生成次数']), zx = numFrom(r['智算次数']);
  const d = ctx.diff[id] || null;
  const reg = normDateStr(r['注册时间']);
  const lastDate = last ? String(last['日期'] || '').slice(0, 10) : '';
  const baseDate = lastDate || normDateStr(r['建档日期']) || '';
  const silentDays = baseDate ? dayDiffStr(ctx.T, baseDate) : null;
  const nextDate = normDateStr(r['下次跟进时间']);
  const overdue = !!nextDate && nextDate < ctx.T;
  const exit = isExitStage(stage);
  const sigs = [];
  const add = (key, action, why, deadline, tier, scene, hard) => sigs.push({ key, action, why, deadline, tier, scene, hard: !!hard, w: ACTION_WEIGHTS.sig[key] || 10 });

  // ⓪ 培育池（结论=暂缓）：只出「轻触达 / 观望」卡，**不排电话、不催单**（2026-10-08 D2）
  //   培育池客户主表状态=挂起冷备（用户手动点名 settle 的）→ buildQueue 本就不派活；
  //   sales_next 单客户视角给到"到点发简报 / 还有几天到点"，避免被误判成"跟丢了"。
  const nrt = nurtureDueOf(r, ctx.flowRows, ctx.T, ctx.touchIdx ? (ctx.touchIdx.get(id) || '') : undefined);
  if (nrt) return buildNurtureCard(r, ctx, nrt);

  // ① 到期类（固定事实，不吃快照新鲜度）
  //   2026-09-29: 过期超 90 天的付费客户按"早年流失"处理（低权重唤醒），别让 200 多天前的老到期日霸占队列。
  if (paid && expDays !== null) {
    if (expDays < 0 && expDays >= -90) add('expiredPaid', '续费挽回', '已过期 ' + (-expDays) + ' 天（' + expire + '），累计消耗 ' + fmtW(cost) + ' 字', '今天', 'T1', '续费与转介绍', true);
    else if (expDays < -90) add('referral', '老客唤醒', '付费到期已 ' + (-expDays) + ' 天（' + expire + '）——早年流失，低成本唤醒即可', '本周', 'T2', '逾期重新激活', true);
    else if (expDays <= 7) add('expire7', '谈续费', expire + ' 到期，还剩 ' + expDays + ' 天；累计消耗 ' + fmtW(cost) + ' 字', '今天', 'T1', '续费与转介绍', true);
    else if (expDays <= 14) add('expire14', '谈续费', expire + ' 到期，还剩 ' + expDays + ' 天', '本周', 'T1', '续费与转介绍', true);
    else if (expDays <= 30) add('expire30', '谈续费', expire + ' 到期，还剩 ' + expDays + ' 天', '本周', 'T2', '续费与转介绍', false);
  }
  if (!paid && expDays !== null && expDays < 0 && expDays >= -90 && (cost > 0 || art > 0)) {
    add('trialExpired', '复活促销', '试用 ' + expire + ' 已到期 ' + (-expDays) + ' 天；到期前累计生成 ' + art + ' 篇、消耗 ' + fmtW(cost) + ' 字', '本周', 'T2', '逾期重新激活', false);
  }
  // ② 增量类（只吃「两期累计量差分」；快照超期 → 失效，不猜）
  if (!ctx.stale && d && !d.firstSeen && d.prevCost !== null) {
    if (d.prevCost > 0 && d.dCost >= Math.max(d.prevCost, 1000)) {
      add('surge', '趁势推进', '这一期消耗从 ' + fmtW(d.prevCost) + ' 涨到 ' + fmtW(d.cost) + ' 字（上一期的 ' + (d.cost / d.prevCost).toFixed(1) + ' 倍）', '今天', 'T1', '趁热推进', true);
    } else if (d.prevCost > 0 && d.dCost <= 0) {
      add('zero', '问项目节奏', '上一期用了 ' + fmtW(d.prevCost) + ' 字，这一期没动（截至 ' + (ctx.latest ? ctx.latest.refreshedAt.slice(5) : '') + '）', '本周', 'T2', '项目节奏确认', true);
    }
  }
  // ③ 余额见底 → 增购（用上一期速度估算，口径写明"按上一期"）
  if (buy > 0 && left > 0 && left / buy < 0.2) {
    let est = '';
    if (!ctx.stale && d && d.dCost > 0 && ctx.prev) {
      const periodDays = Math.max(1, dayDiffStr(ctx.latest.refreshedAt, ctx.prev.refreshedAt) || SNAPSHOT_CYCLE_DAYS);
      const perDay = d.dCost / periodDays;
      if (perDay > 0) est = '，按上一期速度约 ' + Math.max(1, Math.round(left / perDay)) + ' 天用完';
    }
    add('lowLeft', '推增购', '剩 ' + fmtW(left) + ' 字（共 ' + fmtW(buy) + '）' + est, '本周', 'T1', '增购字数包', true);
  }
  // ④ 激活类
  if (ctx.prev && !ctx.stale && d && d.firstSeen && cost === 0) {
    add('newReg', '激活指导', '本期新增客户，账号还没用起来（累计 0 消耗）', '今天', 'T1', '激活指导', false);
  } else if (ctx.prev && cost > 0 && art === 0) {
    add('activated', '激活指导', '累计消耗 ' + fmtW(cost) + ' 字，却一篇报告都没生成（工具没用透）', '本周', 'T2', '激活指导', false);
  }
  // ⑤ 联售（V3.0 打通智算→智写）
  if (zx > 0 && !paid) add('crossSell', '联售智写', '累计用了 ' + zx + ' 次智算，还没上智写——V3.0 能把智算的项目数据一键出成可研', '本周', 'T2', '需求确认与价值建立', false);
  else if (paid && zx === 0 && cost > 0) add('crossSell', '联售智算', '智写在用（' + fmtW(cost) + ' 字），财务测算还没用起来', '本周', 'T2', '联售智算', false);
  // ⑥ 停滞类（我们自己的数据：流水日期 + 阶段）
  //   2026-09-29 修：必须 `flows.length`（**跟过才谈停滞**）——否则 611 个从没跟过的待首触客户
  //   会被判成"停在「线索获取」N 天没推进"，把真正该做的「首触」挤掉（信号失真）。
  if (!exit && stage !== '成交签约' && silentDays !== null) {
    if (stage === '方案报价' && silentDays >= 7) add('quoteStall', '催决策', '报价后 ' + silentDays + ' 天没动静', '今天', 'T1', '促单成交', false);
    else if (flows.length && stage && silentDays >= (STALL_DAYS[stage] || 14)) add('stall', '推进或给结论', '停在「' + stage + '」' + silentDays + ' 天没推进', '今天', 'T1', '跟进推进', false);
  }
  if (overdue && !exit && stage !== '成交签约') add('overdue', '按排期跟进', '排期已逾期（' + nextDate + '）', '今天', 'T1', '跟进推进', false);
  if (flows.length && silentDays !== null && silentDays >= 14 && !exit && stage !== '成交签约') {
    add('silent14', '激活', '最后一次跟进在 ' + silentDays + ' 天前', '本周', 'T2', '逾期重新激活', false);
  }
  // ⑥b 四类节奏信号（2026-10-19 用户 m00409；纯派生，不进主表）
  //   标品成交：每 14 天一次服务追踪 → 到点才派活（问使用效果 / 续费 / 转介绍，不是催单）
  //   待定跟进：距上次跟进 >7 天 → 拿出来再跟一次
  //   重点跟进、挂起冷备：**这里刻意不产信号**（前者用户每天自己看、后者不再跟进），
  //     由 buildQueue 的开头过滤兜住，避免哪天 filter 被改坏后偷偷混进电话队列。
  const cadBk = bucketOf(r, ctx.flowRows);
  if (!exit && stage !== '成交签约') {
    if (cadBk === 'standard') {
      const ndS = cadenceDueOf(r, ctx.flowRows, ctx.T, 'standard', ctx.touchIdx ? (ctx.touchIdx.get(id) || '') : undefined);
      if (ndS && ndS.due) {
        add('svcTrack', '服务追踪',
          '标品成交客户，距上次触达 ' + (ndS.days === null ? '无记录' : ndS.days + ' 天') + '（节奏 ' + STANDARD_CADENCE_DAYS + ' 天）——问使用效果/续费/转介绍，别催单',
          '本周', 'T2', '成交后服务', false);
      }
    } else if (cadBk === 'pending') {
      const ndP = cadenceDueOf(r, ctx.flowRows, ctx.T, 'pending', ctx.touchIdx ? (ctx.touchIdx.get(id) || '') : undefined);
      if (ndP && ndP.due) {
        add('pendingDue', '再跟一次',
          '待定跟进客户，距上次跟进 ' + (ndP.days === null ? '无记录' : ndP.days + ' 天') + '（超 ' + PENDING_CADENCE_DAYS + ' 天该动一次）'
          + (ndP.anchor ? '；锚点 ' + ndP.anchor : ''),
          '今天', 'T1', '跟进推进', false);
      }
    }
  }
  // ⑦ 无流水：分高价值首触 / 长尾批量（长尾不占电话额度）
  //   2026-10-19 修（用户 m00409「每天还要有 10 个首触客户列出」）：原来 hv 只认 paid/消耗/等级，
  //   而待首触客户按定义**等级为空**（未定级）→ 264 个全落 T3 批量池，firstTouchPool 恒为 0，
  //   「每天 10 个首触」永远凑不出来。补一条：属于 first 桶且**有手机号**的，也算高价值首触。
  if (!flows.length) {
    const hv = paid || cost > 0 || zx > 0 || level === 'SS' || level === 'S' || level === 'A' || level === 'B'
      || (bucketOf(r, ctx.flowRows) === 'first' && !!String(r['手机'] || '').trim());
    const aged = silentDays === null ? '' : ('，建档 ' + silentDays + ' 天');
    if (hv) add('firstTouch', '首触', '官网注册' + aged + '、累计消耗 ' + fmtW(cost) + ' 字' + (paid ? '、已付费' : '') + '，还没人跟过', '今天', 'T1', '首次回访', false);
    else add('batch', '批量触达', '注册' + aged + '、0 使用 → 走批量触达，不占电话额度', '批量', 'T3', '批量触达', false);
  }
  // ⑧ 已成交易主 → 转介绍/维护（没到期日的付费客户才有）
  if ((paid || stage === '成交签约') && (expDays === null || expDays > 30) && !exit) {
    add('referral', '老客维护转介绍', '已付费客户，先关心使用效果再请转介绍（累计消耗 ' + fmtW(cost) + ' 字）', '本周', 'T2', '老客维护转介绍', false);
  }
  // ⑨ 企业级信号（2026-10-08 D2；客单价高 → 权重高于标品同类）
  //   ① 标品"用透了"→ 谈企业级落地（走直谈还是升级由用户在 sales_enterprise 里确认，引擎只给建议）
  //   ② 已进企业级段 → 一段只推一件事：摸决策链 / 推试点 / 推签约 / 转介绍（阈值沿用 STALL_DAYS）
  if (!exit && stage !== '成交签约' && !nrt) {
    const seqE = stageSeq(stage);
    const ef = ctx.entIdx ? (ctx.entIdx.get(id) || EMPTY_ENT) : entFactsOf(ctx.flowRows, id);
    const healthy = cost >= ENT_OPP_MIN_COST || art >= ENT_OPP_MIN_ART;
    if (seqE < STAGE_ENT_MIN && healthy && (paid || cost > 0) && (expDays === null || expDays > 30)) {
      // 已付费=信任已建立 → T1；只是用得多还没付费 → T2（先按标品服务，别一上来谈私有化）
      add('entOpportunity', '谈企业级落地',
        '标品用透了（累计消耗 ' + fmtW(cost) + ' 字、报告 ' + art + ' 篇）' + (paid ? '、已付费' : '、还没付费')
        + '，且没有到期压力——把资料与流程沉淀成企业自己的智能体',
        '本周', paid ? 'T1' : 'T2', '企业级机会', false);
    }
    if (seqE >= STAGE_ENT_MIN) {
      if (flows.length && silentDays !== null && silentDays >= (STALL_DAYS[stage] || 14) && ENT_STALL_STAGES[stage]) {
        add('entStall', '推进企业级', '停在「' + stage + '」' + silentDays + ' 天没推进（企业级阈值 ' + (STALL_DAYS[stage] || 14) + ' 天）——一段只推一件事',
          '今天', 'T1', '企业级推进', false);
      }
      if (stage === '企业级机会' && !ef.facts['决策人']) {
        add('decisionChain', '摸决策链', '已进「企业级机会」，但决策人还没摸清——问三件事：谁牵头、预算走哪个口、今年信息化计划里有没有 AI 这一项',
          '今天', 'T1', '决策链摸排', false);
      }
      if (stage === '方案与试点设计' && silentDays !== null && silentDays >= 10) {
        add('pocReady', '推试点验证', '方案与试点设计停了 ' + silentDays + ' 天——先定基线，跑 20 个真实任务再比对，试点不验收不扩大',
          '本周', 'T1', '试点验证', false);
      }
      if (stage === '商务推进' && silentDays !== null && silentDays >= 7) {
        add('entContract', '推签约', '商务推进卡了 ' + silentDays + ' 天——把安全边界（资料权属/权限/审核）、部署方式、验收口径一次谈定',
          '今天', 'T1', '私有化签约', false);
      }
      if (stage === '私有化签约' || (stage === '商务推进' && silentDays !== null && silentDays >= 30)) {
        add('referralEnt', '企业级转介绍', '企业级单已到「' + stage + '」——先问试点成效，再请他引荐同行或集团内其他板块',
          '本周', 'T2', '企业级转介绍', false);
      }
      if (ef.filled && ef.missing.length && (seqE === STAGE_ENT_MIN || seqE === STAGE_ENT_MIN + 1)) {
        add('decisionChain', '补企业级必备信息', '企业级台账缺 ' + ef.missing.join('/') + '（已有 ' + ef.filled + '/' + ENT_FACTS.length + '）——边聊边补齐，后面方案/合同都要用',
          '本周', 'T2', '决策链摸排', false);
      }
    }
  }
  if (!sigs.length) return null;
  sigs.sort((a, b) => b.w - a.w);
  const top = sigs[0];
  // 2026-10-22（用户 m00636）：最近活跃并进行动分（时间维度 or 这一期智写消耗有增量）。
  //   放在 !sigs.length 之后算，所以它**只影响排序、不产生新任务**。
  const ra = recentActiveOf(r, ctx);
  let score = (ACTION_WEIGHTS.level[level] !== undefined ? ACTION_WEIGHTS.level[level] : ACTION_WEIGHTS.level[''])
    + (paid ? ACTION_WEIGHTS.paid : 0) + (!paid && cost > 0 ? ACTION_WEIGHTS.trialActive : 0) + top.w
    + (ra.on ? ACTION_WEIGHTS.recentActive : 0)
    + (String(r['手机'] || '').trim() ? ACTION_WEIGHTS.exec.phone : 0)
    + (String(r['微信昵称'] || '').trim() ? ACTION_WEIGHTS.exec.wechat : 0);
  // 无手机号：动作保留（队列里按"微信/补资料"提示），只是不加电话可执行分（见上面的 phone 权重）。
  // 2026-10-08 审计 A18：这里原来写的是 `top.action = top.action;`（自赋值空操作，删了也不影响行为），已删。
  return {
    id, name: r['公司'] || r['姓名/联系人'] || id, level: level || '未定级', stage, stageSeq: stageSeq(stage),
    status, tier: top.tier, action: top.action, why: top.why, deadline: top.deadline, scene: top.scene,
    hard: sigs.some(s => s.hard), signals: sigs.slice(0, 3).map(s => ({ key: s.key, action: s.action, why: s.why })),
    // 最近活跃标记（用户 2026-10-22 m00636）：对模型/面板只做事实说明，why 不加进话术
    recentActive: ra.on, recentActiveBy: ra.byDate ? (ra.byUse ? 'login+use' : 'login') : (ra.byUse ? 'use' : ''),
    noPhone: !String(r['手机'] || '').trim(), score: Math.round(score),
  };
}
// 冷却记录读取（**只读、绝不做"坏文件另存"那种副作用**——readJSONState 会重命名坏文件，
//   若在 cmdFirstCall 之前先读一次，坏文件就被"消费"掉了，等于把坏文件闸门静默绕过）
function readRecentPushes() {
  try {
    const j = JSON.parse(require('fs').readFileSync(FIRSTCALL_STATE, 'utf8'));
    return (j && typeof j === 'object' && j.recent) ? j.recent : {};
  } catch (e) { return {}; }
}
function buildQueue(ctx) {
  const out = [];
  ctx.rows.forEach(r => {
    // 2026-09-29 审计修（sale-audit P1-1）：**挂起冷备/已闭环 = 用户人工决定不跟了，不进任何行动队列**
    //   （原来只挡了电话队列，长尾分支照样给它们出 T3 批量卡 → 会连手机号画进「批量触达池」，违反标准 13.4）
    // 2026-10-19 用户 m00409 复核并确认三类都**不进今日任务**：
    //   挂起冷备=「不再跟进」；已闭环=终态；重点跟进=「不用列入今日任务，我每天都会看」。
    const st = String(r['跟进状态'] || '').trim();
    if (st === '已闭环' || st === '挂起冷备' || st === '重点跟进') return;
    // 六分类兜底（2026-10-19）：状态字段可能被野值绕过（如状态=跟进中但阶段已在企业级轨、或 isPayer 客户），
    //   分类口径以 bucketOf 为唯一准绳 —— cold 一律不派活、focus 一律不进队列。
    const bk = bucketOf(r, ctx.flowRows);
    if (bk === 'cold' || bk === 'focus') return;
    // 2026-10-08 审计 A5：出口阶段（无法联系/推进终止）= 终态，与 actionCoverage 口径对齐 —— 不再发卡。
    //   真表原有 2 个「无法联系」客户仍拿到 T1/T2 卡（其一动作还是「推增购」），是自相矛盾。
    //   注意：**成交签约不在此列** —— 付费客户的续费/联售/老客维护（售后环）必须有卡，
    //   actionCoverage 侧同步改成按卡计数（见下）。
    if (isExitStage(normStage(r['意向阶段']))) return;
    const card = buildActionCard(r, ctx);
    // 2026-10-10 审计修（批量清黑洞后暴露）：**培育池卡永不进电话队列**（标准 13.4：培育池只走
    //   sales_campaign 培育批/飞轮的轻触达，不排电话、不催单）。旧实现靠"培育池客户主表状态=挂起冷备，
    //   上面已经挡掉"这个先决条件——但 cmdMeeting 批量排期（私享会邀请名单）会把 挂起/挂起冷备 拉回「跟进中」，
    //   而【结论】暂缓属留痕、不会被【排期变更】作废 → 培育卡就漏进了电话队列（selftest 真撞上）。
    //   buildActionCard 的单客户视角不受影响（sales_next 照旧出培育卡）。
    if (card && card.nurture) return;
    if (card) out.push({ r, card });
  });
  const recent = readRecentPushes();
  out.forEach(x => {
    const pushed = recent[x.card.id];
    if (pushed && !x.card.hard) {
      const dd = dayDiffStr(ctx.T, pushed);
      if (dd !== null && dd >= 0 && dd <= COOLDOWN_DAYS) x.card.score = Math.round(x.card.score * ACTION_WEIGHTS.cooldown);
    }
  });
  out.sort((a, b) => b.card.score - a.card.score || String(a.card.id).localeCompare(String(b.card.id)));
  return out;
}
// 归属完整性（「跟到底」的机制保证）：每个客户要么有动作，要么已明确不跟
function actionCoverage(ctx) {
  const buckets = { '电话池': 0, '批量池': 0, '重点跟进': 0, '已排期': 0, '待定区': 0, '出口': 0, '挂起冷备': 0, '已闭环': 0, '成交': 0 };
  const unassigned = [];
  ctx.rows.forEach(r => {
    const id = String(r['客户ID'] || '').trim();
    const s = String(r['跟进状态'] || '').trim();
    const stage = normStage(r['意向阶段']);
    // 2026-09-29 审计修：先判终态再算卡（终态客户本就不该有动作卡，省一遍计算也更不容易再漏）
    if (s === '已闭环') { buckets['已闭环']++; return; }
    if (s === '挂起冷备') { buckets['挂起冷备']++; return; }
    if (s === '重点跟进') { buckets['重点跟进']++; return; }   // 2026-09-29: 人工重点盘，不参与自动动作
    if (isExitStage(stage)) { buckets['出口']++; return; }
    // 2026-10-08 审计 A5：这里原来把「成交签约」直接记进 '成交' 桶（= 无卡），
    //   但 buildQueue 会给成交客户发卡（续费挽回/联售智算/老客维护转介绍 —— 售后环的正当动作），
    //   两边口径矛盾 → 真表 5 个成交客户在「有没有卡」上说法不一。现在统一按**实际发卡结果**计数，
    //   '成交' 桶保留（形状不变）但不再由阶段提前填充。
    const card = buildActionCard(r, ctx);
    if (card) { buckets[card.tier === 'T3' ? '批量池' : '电话池']++; return; }
    if (normDateStr(r['下次跟进时间'])) { buckets['已排期']++; return; }
    if (s === '跟进中' || s === '挂起' || s === '待首触' || s === '') { buckets['待定区']++; return; }
    unassigned.push(id + ':' + s);
  });
  return { total: ctx.rows.length, buckets, unassigned, unassignedCount: unassigned.length };
}

// ---------- 命令: 合同台账 contract（2026-10-15 W1 数据层）----------
// 目的：把「谈合同 → 签合同 → 付款节点 → 审核 → 归档文件」这些**成交关键节点**落成可查的账，并守住本文件纪律：
//   ① 合同本体存 sale/合同台账.json（readJSONState / atomicWriteJSON，坏文件先备份 .corrupt-<ts> 再重建空表）；
//   ② 每个**写动作**都在流水表落一条【合同】留痕（方式留空、类型=数据整理、日期=当天、阶段=客户主表现阶段）；
//   ③ sign 除留痕外**再落一条常规跟进**（方式=合同、类型=老客服务），并回写主表 到期时间/备注/阶段（等级随分类归一）。
// 冻结接口：dispatch case 'contract' → cmdContract(a)；动作 = list/get/save/status/sign/pay/audit/file/archive/void。
// 口径：绝不物理删除（void 只改状态 + 留痕）；红点等派生字段现算不落盘（铁律 10）。
const CONTRACT_TAG = '【合同】';
const CONTRACT_JSON = path.join(DIR, '合同台账.json');
const CONTRACT_TYPES = ['标品服务', '企业级私有化', '定制开发', '保密协议', '其他'];
const CONTRACT_STATUS = ['草稿', '法务审核中', '待签署', '已签署', '执行中', '已归档', '作废'];
const CONTRACT_PAY_STATUS = ['未付', '部分', '已付'];
const CONTRACT_AUDIT_MODES = ['规则', '规则+AI'];
const CONTRACT_ENTERPRISE_TYPES = ['企业级私有化', '定制开发']; // sign 推进阶段时走企业级轨
const CONTRACT_ACTIONS = ['list', 'get', 'save', 'status', 'sign', 'pay', 'audit', 'file', 'archive', 'void'];

function contractErr(msg) { return { ok: false, error: msg, message: msg }; }
function contractNumOf(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  // 去掉千分位/空白/货币符号后必须还有数字，否则 Number('')===0 会把 'abc' 误判成 0（自测实捉）
  const cleaned = s.replace(/[,\s，]/g, '').replace(/[^\d.\-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}
function contractRound2(n) { return Math.round(Number(n) * 100) / 100; }
function contractStrList(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(x => String(x === null || x === undefined ? '' : x).trim()).filter(Boolean);
  return String(v).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
// 记录归一（容错手改过的 JSON）：数组字段兜底、金额/状态兜底；不认识的键原样保留
function contractNormRec(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  ['付款节点', '交付物', '文件', '审核', '留痕'].forEach(k => { if (!Array.isArray(rec[k])) rec[k] = []; });
  if (rec['金额'] === undefined || rec['金额'] === null || rec['金额'] === '') rec['金额'] = 0;
  if (!String(rec['状态'] || '').trim()) rec['状态'] = '草稿';
  return rec;
}
// 读合同台账（只读）：解析失败由 readJSONState(:139) 自动改名 .corrupt-<ts>；结构坏了在这里再补一次改名备份
function readContractLedger() {
  const raw = readJSONState(CONTRACT_JSON);
  if (raw === null) return { contracts: [], rev: 0, corrupt: false };
  if (raw && raw.__corrupt) return { contracts: [], rev: 0, corrupt: true, error: String(raw.error || '') };
  if (!Array.isArray(raw.contracts)) {
    let renamed = false;
    try { require('fs').renameSync(CONTRACT_JSON, CONTRACT_JSON + '.corrupt-' + Date.now()); renamed = true; } catch (e) { /* 原地保留，仍按空表重建 */ }
    return { contracts: [], rev: 0, corrupt: true, renamed, error: 'contracts 不是数组' };
  }
  raw.contracts.forEach(contractNormRec);
  return { contracts: raw.contracts, rev: Number(raw.rev) || 0, corrupt: false };
}
// 写合同台账（必须在 withWriteLock 内）：rev 自增 + 原子写 + 变更日志；失败返回 null
function writeContractLedger(contracts, rev) {
  const obj = { rev: (Number(rev) || 0) + 1, updated: new Date().toISOString(), contracts };
  if (!atomicWriteJSON(obj, CONTRACT_JSON)) return null;
  logChange(CONTRACT_JSON, { op: 'writeContractLedger', rev: obj.rev, contracts: contracts.length });
  return obj.rev;
}
// 坏台账：留痕 + 重建空表（必须在 withWriteLock 内；备份已由 readJSONState/readContractLedger 完成）
function repairContractLedger(st) {
  if (!st || !st.corrupt) return st;
  logChange(CONTRACT_JSON, { op: 'contractLedgerCorrupt', error: st.error || '', rebuilt: true });
  const rev = writeContractLedger([], 0);
  return { contracts: [], rev: rev === null ? 0 : rev, corrupt: false, repaired: true, error: st.error || '' };
}
function findContract(contracts, id) {
  const k = String(id || '').trim();
  if (!k) return null;
  return (contracts || []).find(c => String(c['合同ID'] || '').trim() === k) || null;
}
function findContractClient(rows, id) {
  const k = String(id || '').trim();
  if (!k) return null;
  return (rows || []).find(r => String(r['客户ID'] || '').trim() === k) || null;
}
// 合同ID: HT-YYYYMMDD-NNN，按当天已有最大序号 +1
function nextContractId(contracts, day) {
  const d = String(day || today()).replace(/[^\d]/g, '').slice(0, 8);
  let max = 0;
  (contracts || []).forEach(c => {
    const m = String(c['合同ID'] || '').match(/^HT-(\d{8})-(\d+)$/);
    if (m && m[1] === d) { const n = parseInt(m[2], 10); if (n > max) max = n; }
  });
  return 'HT-' + d + '-' + String(max + 1).padStart(3, '0');
}
// 红点（派生现算，不落盘）：过期 / 缺到期日 / 付款逾期 / 比例合计≠100 / 已签署缺文件或缺审核
function contractRedDots(c, T) {
  const out = [];
  const st = String((c && c['状态']) || '');
  if (st === '作废' || st === '已归档') return out;
  const day = T || today();
  const due = String((c && c['到期日']) || '');
  if (due && isDateStr(due) && due < day) out.push('已过到期日 ' + due);
  else if (!due) out.push('缺到期日');
  const nodes = Array.isArray(c && c['付款节点']) ? c['付款节点'] : [];
  nodes.forEach(n => {
    const d = String((n && n['日期']) || '');
    if (String((n && n['状态']) || '') !== '已付' && d && isDateStr(d) && d < day) out.push('付款逾期：' + ((n && n['名称']) || '') + ' ' + d);
  });
  const rateSum = nodes.reduce((a, n) => a + (Number(n && n['比例']) || 0), 0);
  if (nodes.length && Math.abs(rateSum - 100) > 0.01) out.push('付款比例合计 ' + contractRound2(rateSum) + '%≠100%');
  if (st === '已签署' || st === '执行中') {
    if (!(Array.isArray(c['文件']) && c['文件'].length)) out.push('已签署但无合同文件');
    if (!(Array.isArray(c['审核']) && c['审核'].length)) out.push('已签署但未审核');
  }
  return out;
}
// 付款节点：名称必填且不重复、比例≥0、日期 YYYY-MM-DD、状态枚举、金额缺省按比例折算、比例合计=100（无节点允许）
function buildContractNodes(nodesIn, amount) {
  if (!Array.isArray(nodesIn)) return { error: '付款节点必须是数组，收到: ' + (nodesIn === null ? 'null' : typeof nodesIn) };
  const nodes = [], seen = Object.create(null);
  let ratioSum = 0;
  for (let i = 0; i < nodesIn.length; i++) {
    const n = nodesIn[i] || {};
    const name = String(n['名称'] || '').trim();
    if (!name) return { error: '付款节点第 ' + (i + 1) + ' 项缺「名称」' };
    if (seen[name]) return { error: '付款节点名称重复: ' + name };
    seen[name] = 1;
    const rawRatio = n['比例'];
    const ratio = rawRatio === undefined || rawRatio === null || String(rawRatio).trim() === '' ? 0 : contractNumOf(rawRatio);
    if (!Number.isFinite(ratio) || ratio < 0) return { error: '付款节点「' + name + '」的比例必须是 ≥0 的数字，收到: ' + rawRatio };
    const nd = n['日期'] === undefined || n['日期'] === null || String(n['日期']).trim() === '' ? '' : String(n['日期']).trim();
    if (nd && !isDateStr(nd)) return { error: '付款节点「' + name + '」日期格式应为 YYYY-MM-DD，收到: ' + nd };
    const ns = n['状态'] === undefined || n['状态'] === null || String(n['状态']).trim() === '' ? '未付' : String(n['状态']).trim();
    if (CONTRACT_PAY_STATUS.indexOf(ns) < 0) return { error: '付款节点「' + name + '」状态不合法: ' + ns + '（应为 ' + CONTRACT_PAY_STATUS.join('/') + '）' };
    const rawAmt = n['金额'];
    const nAmount = rawAmt === undefined || rawAmt === null || String(rawAmt).trim() === ''
      ? contractRound2(Number(amount) * ratio / 100) : contractNumOf(rawAmt);
    if (!Number.isFinite(nAmount) || nAmount < 0) return { error: '付款节点「' + name + '」金额必须是 ≥0 的数字，收到: ' + rawAmt };
    nodes.push({ '名称': name, '比例': ratio, '金额': contractRound2(nAmount), '日期': nd, '状态': ns });
    ratioSum += ratio;
  }
  if (nodes.length && Math.abs(ratioSum - 100) > 0.01) {
    return { error: '付款节点比例合计应为 100，实际 ' + contractRound2(ratioSum) + '（' + nodes.map(x => x['名称'] + ' ' + x['比例'] + '%').join('，') + '）' };
  }
  return { nodes, ratioSum: contractRound2(ratioSum) };
}
// 落一条【合同】留痕（只改内存）：同客户 + 同日期 + 同内容 = 判重不重写（照 writeEnterpriseLedger :2390-2392）
function pushContractLedger(flowRows, id, stage, cid, action, type, amount, status) {
  const detail = '合同ID=' + cid + '｜动作=' + action + '｜类型=' + type + '｜金额=' + amount + '｜状态=' + status;
  const what = CONTRACT_TAG + detail;
  const date = today();
  const dup = flowRows.find(f => String(f['客户ID'] || '').trim() === String(id || '').trim()
    && String(f['日期'] || '').trim() === date
    && String(f['沟通内容'] || '').trim() === what);
  if (dup) return { row: dup, duplicated: true };
  return { row: pushChangeFlow(flowRows, id, '合同', detail, stage), duplicated: false };
}
// 写流水：失败不写（提示可安全重试）
function writeContractFlow(flow) {
  try { writeFlow(flow.wb, flow.rows, flow.headers); return null; }
  catch (e) { return '写Excel失败: ' + e.message + '（合同台账未改，可安全重试）'; }
}
// 写台账号状态文件；失败＝流水已落、JSON 未落（半写，需显式回报）
function writeContractState(contracts, rev, flowId) {
  const newRev = writeContractLedger(contracts, rev);
  if (newRev === null) return { error: '合同台账.json 写失败（流水 ' + flowId + ' 已写入，重跑同一动作即可补齐；JSON 临时文件已保留）', rev: null };
  return { error: null, rev: newRev };
}
// 写动作公共前置：读主表 + 读台账 + 找合同 + 找客户（必须在 withWriteLock 内调用）
function contractCtx(cid) {
  const m = readMaster();
  const lstate = repairContractLedger(readContractLedger());
  const rec = findContract(lstate.contracts, cid);
  if (!rec) return { error: contractErr('合同ID 不存在: ' + cid) };
  contractNormRec(rec);
  const c = findContractClient(m.rows, rec['客户ID']);
  if (!c) return { error: contractErr('合同 ' + cid + ' 的客户ID 不在主表在册: ' + rec['客户ID']) };
  return { m, rows: m.rows, headers: m.headers, lstate, contracts: lstate.contracts, rec, c, id: String(c['客户ID']).trim() };
}

// ---------- 动作: list ----------
function contractList() {
  const st = readContractLedger();
  const T = today();
  const contracts = st.contracts.slice().sort((x, y) => String(y['合同ID'] || '').localeCompare(String(x['合同ID'] || '')));
  const out = {
    ok: true, count: contracts.length,
    contracts: contracts.map(c => ({
      '合同ID': c['合同ID'], '客户ID': c['客户ID'], '客户名': c['客户名'], '类型': c['类型'],
      '金额': c['金额'], '状态': c['状态'], '到期日': c['到期日'], '红点': contractRedDots(c, T),
    })),
  };
  if (st.corrupt) { out.corrupt = true; out.message = '合同台账.json 损坏，已备份为 .corrupt-<ts>，本次按空表返回（下一次写动作会重建）'; }
  return out;
}

// ---------- 动作: get ----------
function contractGet(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const st = readContractLedger();
  const rec = findContract(st.contracts, cid);
  if (!rec) return contractErr('合同ID 不存在: ' + cid);
  const out = { ok: true, contract: rec, 红点: contractRedDots(rec, today()) };
  if (st.corrupt) out.corrupt = true;
  return out;
}

// ---------- 动作: save（新建 / 更新）----------
function contractSave(a) {
  const cidIn = String(a['合同ID'] || '').trim();
  const isNew = !cidIn;
  const key = String(a['客户ID'] || a.id || '').trim();
  if (!key) return contractErr('缺少 客户ID');
  const prov = (k) => a[k] !== undefined && a[k] !== null;
  // 类型
  const typeIn = prov('类型') ? String(a['类型']).trim() : '';
  if (isNew && !typeIn) return contractErr('缺少 类型（' + CONTRACT_TYPES.join('/') + '）');
  if (typeIn && CONTRACT_TYPES.indexOf(typeIn) < 0) return contractErr('类型不合法: ' + typeIn + '（应为 ' + CONTRACT_TYPES.join('/') + '）');
  // 金额（新建必填；更新给了才改）
  let amountIn = NaN;
  if (prov('金额')) {
    amountIn = contractNumOf(a['金额']);
    if (!Number.isFinite(amountIn)) return contractErr('金额必须是 ≥0 的数字，收到: ' + a['金额']);
    if (amountIn < 0) return contractErr('金额不能为负: ' + amountIn);
  } else if (isNew) return contractErr('缺少 金额（必须是 ≥0 的数字）');
  // 税率
  let rateIn = null;
  if (prov('税率')) {
    if (String(a['税率']).trim() === '') rateIn = 0;
    else {
      rateIn = contractNumOf(a['税率']);
      if (!Number.isFinite(rateIn) || rateIn < 0) return contractErr('税率必须是 ≥0 的数字，收到: ' + a['税率']);
    }
  }
  // 状态
  const stIn = prov('状态') && String(a['状态']).trim() !== '' ? String(a['状态']).trim() : '';
  if (stIn && CONTRACT_STATUS.indexOf(stIn) < 0) return contractErr('状态不合法: ' + stIn + '（应为 ' + CONTRACT_STATUS.join('/') + '）');
  // 付款节点（结构在锁内校验，因为金额可能沿用旧值）
  if (prov('付款节点') && !Array.isArray(a['付款节点'])) return contractErr('付款节点必须是数组，收到: ' + typeof a['付款节点']);
  // 日期
  const dates = {};
  for (const k of ['签署日', '生效日', '到期日']) {
    if (!prov(k)) { dates[k] = null; continue; }
    if (String(a[k]).trim() === '') { dates[k] = ''; continue; }
    const s = String(a[k]).trim();
    if (!isDateStr(s)) return contractErr(k + '格式应为 YYYY-MM-DD，收到: ' + s);
    dates[k] = s;
  }
  if (dates['生效日'] && dates['到期日'] && dates['到期日'] < dates['生效日']) {
    return contractErr('到期日不能早于生效日: ' + dates['到期日'] + ' < ' + dates['生效日']);
  }
  return (() => {
    const m = readMaster();
    const rows = m.rows;
    const c = findContractClient(rows, key);
    if (!c) return contractErr('客户ID 不在册（主表查无此人）: ' + key);
    const id = String(c['客户ID']).trim();
    const lstate = repairContractLedger(readContractLedger());
    const contracts = lstate.contracts;
    let rec = null;
    const created = isNew;
    if (isNew) {
      rec = {
        '合同ID': nextContractId(contracts, today()),
        '客户ID': '', '客户名': '', '类型': '', '我方主体': '', '对方主体': '', '对方统一社会信用代码': '',
        '金额': 0, '税率': 0, '付款节点': [], '签署日': '', '生效日': '', '到期日': '', '续约': '',
        '交付物': [], '验收口径': '', '试点范围': '', '资料权属': '', '部署方式': '', '安全要求': '',
        '状态': '草稿', '文件': [], '审核': [], '留痕': [], '备注': '',
      };
      contracts.push(rec);
    } else {
      rec = findContract(contracts, cidIn);
      if (!rec) return contractErr('合同ID 不存在: ' + cidIn);
      contractNormRec(rec);
    }
    const amountFinal = isNew ? amountIn : (prov('金额') ? amountIn : (Number(rec['金额']) || 0));
    if (prov('付款节点') || isNew) {
      const b = buildContractNodes(prov('付款节点') ? a['付款节点'] : [], amountFinal);
      if (b.error) return contractErr(b.error);
      rec['付款节点'] = b.nodes;
    }
    rec['客户ID'] = id;
    rec['客户名'] = String(c['公司'] || c['姓名/联系人'] || '');
    if (isNew || prov('类型')) rec['类型'] = typeIn;
    rec['金额'] = contractRound2(amountFinal);
    if (rateIn !== null) rec['税率'] = rateIn;
    else if (isNew) rec['税率'] = 0;
    const setS = (k) => { if (isNew || prov(k)) rec[k] = String(a[k] === undefined || a[k] === null ? '' : a[k]).trim(); };
    ['我方主体', '对方主体', '对方统一社会信用代码', '验收口径', '试点范围', '资料权属', '部署方式', '安全要求', '备注'].forEach(setS);
    ['签署日', '生效日', '到期日'].forEach(k => { if (dates[k] !== null) rec[k] = dates[k]; else if (isNew) rec[k] = ''; });
    if (isNew || prov('续约')) {
      rec['续约'] = a['续约'] === true ? '是' : a['续约'] === false ? '否' : String(a['续约'] === undefined || a['续约'] === null ? '' : a['续约']).trim();
    }
    if (isNew || prov('交付物')) rec['交付物'] = contractStrList(prov('交付物') ? a['交付物'] : []);
    if (stIn) rec['状态'] = stIn;
    else if (isNew) rec['状态'] = '草稿';
    const flow = readFlow();
    const actionName = created ? '新建' : '修改';
    const led = pushContractLedger(flow.rows, id, c['意向阶段'], rec['合同ID'], actionName, rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': actionName, '流水ID': led.row['流水ID'] });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(contracts, lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 合同ID: rec['合同ID'], 流水ID: led.row['流水ID'] };
    return {
      ok: true, 合同ID: rec['合同ID'], created, 客户ID: id, 客户名: rec['客户名'], 类型: rec['类型'],
      金额: rec['金额'], 状态: rec['状态'], 到期日: rec['到期日'], 流水ID: led.row['流水ID'],
      duplicated: led.duplicated, rev: w.rev,
      message: (created ? '新建' : '更新') + '合同 ' + rec['合同ID'] + '（' + rec['类型'] + '，' + rec['金额'] + ' 元，' + rec['状态'] + '）；已落【合同】留痕 ' + led.row['流水ID'],
    };
  })();
}

// ---------- 动作: status（改状态，日志用）----------
function contractStatus(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const stIn = String(a['状态'] || '').trim();
  if (!stIn) return contractErr('缺少 状态（' + CONTRACT_STATUS.join('/') + '）');
  if (CONTRACT_STATUS.indexOf(stIn) < 0) return contractErr('状态不合法: ' + stIn + '（应为 ' + CONTRACT_STATUS.join('/') + '）');
  const note = String(a['备注'] || '').trim();
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec;
    const from = String(rec['状态'] || '');
    rec['状态'] = stIn;
    if (note) {
      const oldNote = String(rec['备注'] || '').trim();
      rec['备注'] = oldNote ? oldNote + '；' + stamp(today(), note) : stamp(today(), note);
    }
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, ctx.id, ctx.c['意向阶段'], cid, '状态变更', rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '状态变更', '流水ID': led.row['流水ID'] });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return { ok: true, 合同ID: cid, 状态: stIn, 原状态: from, 流水ID: led.row['流水ID'], duplicated: led.duplicated, rev: w.rev, message: '合同 ' + cid + ' 状态 ' + from + '→' + stIn + '；已落【合同】留痕 ' + led.row['流水ID'] };
  })();
}

// ---------- 动作: sign（签署 = 留痕 + 常规跟进 + 回写主表）----------
function contractSign(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const sdIn = a['签署日'] === undefined || a['签署日'] === null || String(a['签署日']).trim() === '' ? '' : String(a['签署日']).trim();
  if (sdIn && !isDateStr(sdIn)) return contractErr('签署日格式应为 YYYY-MM-DD，收到: ' + sdIn);
  const advance = a['推进阶段'] !== false;
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec, c = ctx.c, id = ctx.id, rows = ctx.rows, headers = ctx.headers;
    const st0 = String(rec['状态'] || '');
    if (st0 === '作废') return contractErr('合同已作废，不能签署: ' + cid);
    if (st0 === '已归档') return contractErr('合同已归档，不能签署: ' + cid);
    const 签署日 = sdIn || String(rec['签署日'] || '') || today();
    rec['签署日'] = 签署日;
    if (st0 !== '已签署' && st0 !== '执行中') rec['状态'] = '已签署';
    const curStage = normStage(c['意向阶段']);
    const isEnt = CONTRACT_ENTERPRISE_TYPES.indexOf(String(rec['类型'] || '')) >= 0;
    const advStage = isEnt ? '私有化签约' : '成交签约';
    const flowStage = advance ? advStage : curStage;
    // ① 流水：一条【合同】留痕 +（若要）一条常规跟进，同一次写盘
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, id, curStage, cid, '签署', rec['类型'], rec['金额'], rec['状态']);
    const nodes = Array.isArray(rec['付款节点']) ? rec['付款节点'] : [];
    const firstUnpaid = nodes.find(n => String(n['状态'] || '') !== '已付');
    const 到期日 = String(rec['到期日'] || '');
    const followWhat = '签署合同 ' + cid + '（' + rec['类型'] + '，金额 ' + rec['金额'] + ' 元' + (到期日 ? '，到期 ' + 到期日 : '') + '）';
    let followRow = flow.rows.find(f => String(f['客户ID'] || '').trim() === id
      && String(f['日期'] || '').trim() === today()
      && String(f['沟通内容'] || '').trim() === followWhat);
    if (!followRow) {
      followRow = {
        '流水ID': nextFlowId(flow.rows), '客户ID': id, '日期': today(), '方式': '合同', '类型': '老客服务',
        '沟通内容': followWhat, '对方反应': '', '下一步动作': firstUnpaid ? String(firstUnpaid['名称'] || '') : '',
        '下次跟进时间': '', '下次跟进方式': '', '阶段': normStage(flowStage) || '',
      };
      flow.rows.push(followRow);
    }
    // ② 主表回写：到期时间 / 备注 / 阶段 / 等级归一 / 触达状态
    if (到期日 && headers.indexOf('到期时间') >= 0) c['到期时间'] = 到期日;
    const noteText = '合同 ' + cid + ' 已签署（' + rec['类型'] + '，' + rec['金额'] + ' 元' + (到期日 ? '，到期 ' + 到期日 : '') + '）';
    const oldNote = String(c['备注'] || '').trim();
    c['备注'] = oldNote ? oldNote + '；' + stamp(today(), noteText) : stamp(today(), noteText);
    if (advance) c['意向阶段'] = advStage;
    const lvSync = syncLevelFor(c, flow.rows);
    const custFlows = flow.rows.filter(f => String(f['客户ID'] || '').trim() === id && isFollowRecord(f));
    c['触达状态'] = deriveTouchState(custFlows, c['触达状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '签署', '流水ID': led.row['流水ID'] });
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '签署跟进', '流水ID': followRow['流水ID'] });
    let flowWritten = false;
    try {
      writeFlow(flow.wb, flow.rows, flow.headers);
      flowWritten = true;
      writeMaster(ctx.m.wb, rows, headers, { addDate1904: false });
    } catch (e) {
      return { ok: false, partial: flowWritten, error: '写Excel失败: ' + e.message + (flowWritten ? '（流水已写入，主表未回写）' : '（两表都未写）'), message: '写Excel失败: ' + e.message };
    }
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return {
      ok: true, 合同ID: cid, 客户ID: id, 客户名: rec['客户名'], 签署日, 状态: rec['状态'],
      流水ID: led.row['流水ID'], 跟进流水ID: followRow['流水ID'], duplicated: led.duplicated, rev: w.rev,
      阶段: advance ? advStage : (curStage || ''), 推进阶段: advance, 到期时间: 到期日,
      levelSynced: lvSync && lvSync.changed ? String(lvSync.from || '未定级') + '→' + String(lvSync.to || '未定级') : '',
      message: '合同 ' + cid + ' 已签署（留痕 ' + led.row['流水ID'] + ' + 常规跟进 ' + followRow['流水ID'] + '）；'
        + (advance ? '阶段推进到「' + advStage + '」' : '阶段停留「' + (curStage || '未标注') + '」')
        + (到期日 ? '；主表到期时间=' + 到期日 : '；合同无到期日，主表到期时间未改'),
    };
  })();
}

// ---------- 动作: pay（付款节点推进）----------
function contractPay(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const nodeName = String(a['节点名'] || a['名称'] || '').trim();
  if (!nodeName) return contractErr('缺少 节点名');
  const stIn = String(a['状态'] || '').trim();
  if (!stIn) return contractErr('缺少 状态（' + CONTRACT_PAY_STATUS.join('/') + '）');
  if (CONTRACT_PAY_STATUS.indexOf(stIn) < 0) return contractErr('付款节点状态不合法: ' + stIn + '（应为 ' + CONTRACT_PAY_STATUS.join('/') + '）');
  const dtIn = a['日期'] === undefined || a['日期'] === null || String(a['日期']).trim() === '' ? '' : String(a['日期']).trim();
  if (dtIn && !isDateStr(dtIn)) return contractErr('日期格式应为 YYYY-MM-DD，收到: ' + dtIn);
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec;
    const node = (rec['付款节点'] || []).find(n => String(n['名称'] || '').trim() === nodeName);
    if (!node) {
      const names = (rec['付款节点'] || []).map(n => String(n['名称'] || '')).join('/');
      return contractErr('付款节点不存在: ' + nodeName + '（现有: ' + (names || '无') + '）');
    }
    const from = String(node['状态'] || '');
    node['状态'] = stIn;
    if (dtIn) node['日期'] = dtIn;
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, ctx.id, ctx.c['意向阶段'], cid, '付款(' + nodeName + '→' + stIn + ')', rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '付款', '流水ID': led.row['流水ID'], '节点名': nodeName, '节点状态': stIn });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return { ok: true, 合同ID: cid, 节点名: nodeName, 状态: stIn, 原状态: from, 日期: node['日期'], 金额: node['金额'], 流水ID: led.row['流水ID'], duplicated: led.duplicated, rev: w.rev, message: '付款节点「' + nodeName + '」' + from + '→' + stIn + '；已落【合同】留痕 ' + led.row['流水ID'] };
  })();
}

// ---------- 动作: audit（规则 / 规则+AI 审核留痕）----------
function contractAudit(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const mode = String(a['模式'] || '').trim();
  if (!mode) return contractErr('缺少 模式（' + CONTRACT_AUDIT_MODES.join(' / ') + '）');
  if (CONTRACT_AUDIT_MODES.indexOf(mode) < 0) return contractErr('审核模式不合法: ' + mode + '（应为 ' + CONTRACT_AUDIT_MODES.join(' / ') + '）');
  const concl = String(a['结论'] || '').trim();
  if (!concl) return contractErr('缺少 审核结论');
  const risks = contractStrList(a['风险']);
  const disc = String(a['免责'] || '').trim();
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec;
    rec['审核'].push({ '时间': new Date().toISOString(), '模式': mode, '结论': concl, '风险': risks, '免责': disc });
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, ctx.id, ctx.c['意向阶段'], cid, '审核(' + mode + '·' + concl + ')', rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '审核', '流水ID': led.row['流水ID'] });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return { ok: true, 合同ID: cid, 模式: mode, 结论: concl, 风险: risks, 免责: disc, 审核条数: rec['审核'].length, 流水ID: led.row['流水ID'], duplicated: led.duplicated, rev: w.rev, message: '合同 ' + cid + ' 已审核（' + mode + '·' + concl + '，风险 ' + risks.length + ' 条）；已落【合同】留痕 ' + led.row['流水ID'] };
  })();
}

// ---------- 动作: file（合同文件登记，只登记不搬文件）----------
function contractFile(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const name = String(a['名'] || '').trim();
  if (!name) return contractErr('缺少 名（文件名）');
  const p = String(a['路径'] || '').trim();
  if (!p) return contractErr('缺少 路径（文件绝对路径）');
  // 2026-10-21 体检（m03962 P0）：原来路径/字节/sha256 全由调用方给，等于「台账可登记任意本机文件」，
  //   再配合 download 就能把客户表这类文件读出去。现在只收 合同/ 下真实存在的文件，
  //   字节与 sha256 由服务端现算（调用方给的值只当参考，不采信）。
  const CONTRACT_DIR = path.join(DIR, '合同');
  const fs = require('fs');
  const crypto = require('crypto');
  const abs = (() => { try { return path.resolve(p) } catch (e) { return '' } })();
  const dirAbs = path.resolve(CONTRACT_DIR);
  if (!abs || !(abs === dirAbs || abs.startsWith(dirAbs + path.sep))) {
    return contractErr('只允许登记 sale\\合同\\ 目录下的文件，收到: ' + p);
  }
  let realBytes = 0;
  let realSha = '';
  try {
    if (!fs.existsSync(abs)) return contractErr('文件不在本机：' + abs);
    const buf = fs.readFileSync(abs);
    realBytes = buf.length;
    realSha = crypto.createHash('sha256').update(buf).digest('hex');
  } catch (e) { return contractErr('读文件失败：' + String((e && e.message) || e)); }
  const bytesIn = a['字节'] === undefined || a['字节'] === null || String(a['字节']).trim() === '' ? realBytes : Number(a['字节']);
  if (!Number.isFinite(bytesIn) || bytesIn < 0) return contractErr('字节必须是 ≥0 的数字，收到: ' + a['字节']);
  if (bytesIn !== realBytes) return contractErr('字节与文件实际大小不一致（调用方说 ' + bytesIn + '，实际 ' + realBytes + '）');
  const shaIn = String(a['sha256'] || '').trim();
  if (shaIn && shaIn.toLowerCase() !== realSha.toLowerCase()) return contractErr('sha256 与文件实际内容不一致（拒绝登记）');
  const sha = realSha;
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec;
    const entry = { '名': name, '路径': p, '生成时间': new Date().toISOString(), '字节': bytesIn, 'sha256': sha };
    rec['文件'].push(entry);
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, ctx.id, ctx.c['意向阶段'], cid, '文件登记(' + name + ')', rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '文件登记', '流水ID': led.row['流水ID'], '名': name });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return { ok: true, 合同ID: cid, 名: name, 路径: p, 字节: bytesIn, sha256: sha, 文件数: rec['文件'].length, 文件: entry, 流水ID: led.row['流水ID'], duplicated: led.duplicated, rev: w.rev, message: '合同 ' + cid + ' 已登记文件「' + name + '」；已落【合同】留痕 ' + led.row['流水ID'] };
  })();
}

// ---------- 动作: archive ----------
function contractArchive(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec;
    const from = String(rec['状态'] || '');
    rec['状态'] = '已归档';
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, ctx.id, ctx.c['意向阶段'], cid, '归档', rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '归档', '流水ID': led.row['流水ID'] });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return { ok: true, 合同ID: cid, 状态: '已归档', 原状态: from, 文件数: (rec['文件'] || []).length, 流水ID: led.row['流水ID'], duplicated: led.duplicated, rev: w.rev, message: '合同 ' + cid + ' 已归档（状态 ' + from + '→已归档）；已落【合同】留痕 ' + led.row['流水ID'] };
  })();
}

// ---------- 动作: void（作废，绝不物理删除）----------
function contractVoid(a) {
  const cid = String(a['合同ID'] || '').trim();
  if (!cid) return contractErr('缺少 合同ID');
  const reason = String(a['原因'] || '').trim();
  if (!reason) return contractErr('缺少 原因（作废必须写清原因）');
  return (() => {
    const ctx = contractCtx(cid);
    if (ctx.error) return ctx.error;
    const rec = ctx.rec;
    const from = String(rec['状态'] || '');
    rec['状态'] = '作废';
    const flow = readFlow();
    const led = pushContractLedger(flow.rows, ctx.id, ctx.c['意向阶段'], cid, '作废', rec['类型'], rec['金额'], rec['状态']);
    rec['留痕'].push({ '时间': new Date().toISOString(), '动作': '作废', '流水ID': led.row['流水ID'], '原因': reason });
    const ferr = writeContractFlow(flow);
    if (ferr) return { ok: false, error: ferr, message: ferr };
    const w = writeContractState(ctx.contracts, ctx.lstate.rev, led.row['流水ID']);
    if (w.error) return { ok: false, partial: true, error: w.error, message: w.error, 流水ID: led.row['流水ID'] };
    return { ok: true, 合同ID: cid, 状态: '作废', 原状态: from, 原因: reason, 流水ID: led.row['流水ID'], duplicated: led.duplicated, rev: w.rev, message: '合同 ' + cid + ' 已作废（' + from + '→作废，原因：' + reason + '）；未删任何记录，已落【合同】留痕 ' + led.row['流水ID'] };
  })();
}

// ---------- 命令入口: cmdContract ----------
function cmdContract(a) {
  const args = a && typeof a === 'object' ? a : {};
  const action = String(args['动作'] || args['action'] || 'list').trim().toLowerCase();
  switch (action) {
    case 'list': return contractList();
    case 'get': return contractGet(args);
    // 写锁边界（2026-10-15 W1）：8 个写动作统一在本入口 withWriteLock(:212)；
    //   动作函数内**不再**重复加锁——.sales-lock 不可重入，嵌套加锁会自锁成「文件忙」。
    //   list/get 只读台账（原子写 + rename，读不到半个文件），不加锁。
    case 'save': return withWriteLock(() => contractSave(args));
    case 'status': return withWriteLock(() => contractStatus(args));
    case 'sign': return withWriteLock(() => contractSign(args));
    case 'pay': return withWriteLock(() => contractPay(args));
    case 'audit': return withWriteLock(() => contractAudit(args));
    case 'file': return withWriteLock(() => contractFile(args));
    case 'archive': return withWriteLock(() => contractArchive(args));
    case 'void': return withWriteLock(() => contractVoid(args));
    default:
      return { ok: false, error: '未知动作: ' + action, message: '未知动作: ' + action, 动作: CONTRACT_ACTIONS, actions: CONTRACT_ACTIONS };
  }
}

// ---------- 数据目录初始化（首次设置向导 / `npm run setup` 共用，幂等） ----------
// 只建"结构"：目录骨架 + 张空表（表头取上面的契约常量，**绝不**从 rows[0] 推）。
// 已存在的文件绝不覆盖 —— 重复点「初始化」不会清掉客户数据。
// 示例语料（营销资料库 里的 .md/.json）由 scripts/setup.mjs 从 templates/ 复制。
function cmdInit(a) {
  const args = a && typeof a === 'object' ? a : {};
  const madeDirs = [], created = [], kept = [];
  try {
    for (const sub of ['', '营销资料库', '合同', 'logs', '快照']) {
      const p = sub ? path.join(DIR, sub) : DIR;
      if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); madeDirs.push(sub || '.'); }
    }
    const master = path.join(DIR, '销售客户-主表.xlsx');
    if (!fs.existsSync(master)) {
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([HEADERS_MASTER.slice()]), '客户主表');
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([HEADERS_CONTACT.slice()]), '联系人');
      atomicWrite(wb, master);
      created.push(path.basename(master));
    } else kept.push(path.basename(master));
    const flow = path.join(DIR, '销售客户-流水表.xlsx');
    if (!fs.existsSync(flow)) {
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([HEADERS_FLOW.slice()]), '跟进流水');
      atomicWrite(wb, flow);
      created.push(path.basename(flow));
    } else kept.push(path.basename(flow));
    return {
      ok: true,
      dataDir: DIR,
      madeDirs, created, kept,
      next: '把客户数据填进 销售客户-主表.xlsx（表头已建好，别改列名）；营销语料放 营销资料库/。',
    };
  } catch (e) {
    return { ok: false, error: '初始化数据目录失败：' + String((e && e.message) || e) };
  }
}

// ---------- 命令分发 ----------
function dispatch(cmd, args) {
  switch (cmd) {
    // 首次设置：建目录骨架 + 空表（幂等，不覆盖）
    case 'init': return cmdInit(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'tasks': {
      const a = args[0];
      if (a && typeof a === 'object') return cmdTasks(Number(a.days) || 7, !!a.slim);
      return cmdTasks(parseInt(a, 10), false);
    }
    case 'view': return cmdView(args[0]);
    case 'log': return cmdLog(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    // 2026-10-21 夜（侧栏 AI 协议 v2）：写库差异预览——与 log/settle 同一条代码路径，只是不落盘。
    case 'logplan': return cmdLog(Object.assign({}, (typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {})), { __dryRun: true }));
    case 'settleplan': return cmdSettle(Object.assign({}, (typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {})), { __dryRun: true }));
    case 'summary': return cmdSummary();
    case 'check': return cmdCheck();
    case 'search': return cmdSearch(args[0]);
    // 2026-10-22（用户 m01260）：身份解析——手机号→客户ID→微信→公司全称→简称→联系人→原编号→城市→备注
    case 'resolve': return cmdResolve(args[0]);
    // 2026-10-22（用户 m02366）：开场原文——模板引擎出的这一句，模型只许挑/删，不许改写
    case 'open': return cmdOpen(args[0]);
    case 'remind': return cmdRemind();
    case 'firstcall': return cmdFirstCall();
    case 'tips': return cmdTips(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'clienttip': return cmdClientTip(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'live': return cmdLive(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'today': return today();
    case 'next': return cmdNext(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].id) || '');
    case 'plan': return cmdPlan();
    case 'brief': return cmdBrief();
    case 'settle': return cmdSettle(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'enterprise': return cmdEnterprise(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'contract': return cmdContract(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'flywheel': return cmdFlywheel(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'campaign': return cmdCampaign(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'digest': return cmdDigest(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'meeting': return cmdMeeting(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].date) || '');
    case 'sweep': return cmdSweep();
    case 'cold': return cmdCold();
    case 'focus': return cmdFocus();
    // 六分类名单页（2026-10-13 用户定：顶部导航六类各成一页）
    case 'standard': return cmdStandard();
    case 'custom': return cmdCustom();
    case 'pending': return cmdPending();
    case 'first': return cmdFirst(args[0] && typeof args[0] === 'object' ? args[0].limit : args[0]);
    case 'buckets': return bucketPools(readMaster().rows, readFlow().rows, today(), { per: 10 });
    // 四类跟进节奏总览（2026-10-19 用户 m00409）：纯派生、不写盘
    case 'cadence': return cadenceReport(buildActionContext());
    case 'alignlevels': return cmdAlignLevels(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    case 'sop': return cmdSop(args[0]);
    case 'add': return cmdAdd(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    // 2026-10-13 批次5 审计 P0-1：删除收口（只走 CLI/dispatch 入口；不注册 HTTP 路由、不注册模型工具）
    case 'delete': return cmdDelete(typeof args[0] === 'string' ? JSON.parse(args[0]) : (args[0] || {}));
    default: return { error: '未知命令', commands: ['init','tasks','view','log','summary','search','remind','firstcall','tips','clienttip','live','today','check','meeting','sweep','cold','focus','standard','custom','pending','first','buckets','cadence','alignlevels','sop','add','delete','next','plan','brief','settle','enterprise','contract','flywheel','campaign','digest'] };
  }
}
const cmd = process.argv[2];
// --dir / --data-dir 只用于上面解析数据目录（模块加载时已消费），不进命令参数
const args = (() => {
  const raw = process.argv.slice(3)
  const out = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--dir' || raw[i] === '--data-dir') { i++; continue }
    out.push(raw[i])
  }
  return out
})();
async function readStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}
async function main() {
  let out;
  try {
    if (cmd === 'run') {
      // stdin 入口: node sales-lib.js run < payload.json — 从 stdin 读 {cmd,args}，绕开命令行中文转义
      const payload = JSON.parse(await readStdin());
      out = dispatch(payload.cmd, payload.args || []);
    } else if (cmd === 'b64') {
      // base64 入口: node sales-lib.js b64 <base64({cmd,args})> — 避免命令行转义问题
      const payload = JSON.parse(Buffer.from(args[0], 'base64').toString('utf8'));
      out = dispatch(payload.cmd, payload.args || []);
    } else {
      out = dispatch(cmd, args);
    }
  } catch (e) {
    // 2026-09-14 加固: 异常必须带非 0 退出码，否则插件侧(只在 exitCode!==0 报错)会把失败当正常数据
    out = { error: String(e && e.message || e) };
    process.exitCode = 1;
    try { process.stderr.write('[sales-lib] 异常: ' + out.error + '\n'); } catch (_) { /* 忽略 */ }
  }
  // 2026-09-29 审计修（eng-audit P0-1）：check 报出问题（ok:false）必须带非 0 退出码——
  //   否则 doctor 的「结构体检 check」是**恒绿**的假绿项（口径红线整类没有闸门）。
  if (cmd === 'check' && out && out.ok === false) process.exitCode = 1;
  console.log(JSON.stringify(out, null, 0));
}
if (typeof require !== 'undefined' && require.main === module) main();
if (typeof module !== 'undefined' && module.exports) {
  // 2026-09-14: 额外导出内部件供 scripts/selftest.cjs 做契约测试（写闸/日期口径/出参）
  module.exports = { dispatch, cmdInit, cmdClientTip, cmdTips, cmdSummary, cmdCheck, cmdTasks, cmdFirstCall, cmdPlan, cmdBrief, cmdSettle, cmdNext, cmdLog, cmdView, cmdSearch, cmdRemind, cmdMeeting, cmdSweep, cmdCold, cmdFocus, cmdSop, cmdAdd, cmdDelete, isChangeRecord, isFollowRecord, pushChangeFlow, nextFlowId, masterDiff, CHANGE_KINDS, CHANGE_TAG, buildSop, buildFollowScript, buildActionCard, buildActionContext, buildQueue, actionCoverage, readSnapshot, readPrevSnapshot, diffSnapshot, snapshotInfo, dayDiffStr, ACTION_WEIGHTS, SNAPSHOT_CYCLE_DAYS, SNAPSHOT_STALE_DAYS, parseDate, normDateStr, dateToSerial, pickCust, writeMaster, writeFlow, readMaster, readFlow, withWriteLock, MST, FLT, CT, STATUS_SET, STAGE_SET, STAGE_ORDER, STAGE_MAIN, STAGE_EXIT, STAGE_ALIAS, TOUCH_SET, deriveTouchState, isWechatPendingText, TOUCH_METHOD_SET, isTouchMethod, TYPE_STAGE_FILL, normStage, stageSeq, isExitStage, stageMoveNote, sopResultOf, sopTrackOf, TRACK_ALL, STAGE_STD, STAGE_ENT, STAGE_ENT_MIN, STALL_DAYS, parseConclusion, lastConclusionOf, conclusionAlive, RESULT_ALL, RESULT_STOP, SETTLE_KINDS,
    // 2026-10-22 金额展示口径（元 → 「X.XX 万元」，selftest ㊷ 断言）
    fmtMoneyWan,
    // 2026-10-22 身份解析（用户 m01260：手机号→客户ID→微信→公司→简称→联系人→原编号→城市→备注）
    cmdResolve, resolveRows, extractTargets, normKey, shortOrgOf,
    // 2026-10-22 开场原文（用户 m02366：开场走库，模型只许挑不许改）
    cmdOpen, openLineOf, customerSafeWhat,
    // 2026-10-28 时间轴排序（用户 m03369：时间靠后的放下面）+ 面板只给结果（m03270）
    orderFlowsByTime, isFollowRecord, isChangeRecord,
    // 2026-10-29 写卡预校验（用户 m03421：「方式：会议」点确认才报错）——归一表的唯一实现，导出给 selftest
    normalizeFollowArgs, METHOD_ALIAS, TYPE_ALIAS,
    // 2026-10-29 按内容落段（用户 m03535「跟进记录不对应 sop」）
    inferStageOfFollow, STAGE_HINTS,
    // 2026-10-08 D2 双轨/培育轨（导出以便 selftest 断言内部常量，D1 踩过 STALL_DAYS 未导出的坑）
    NURTURE_CADENCE_DAYS, ENT_TAG, ENT_FACTS, ENT_OPP_MIN_COST, ENT_OPP_MIN_ART, ENT_SCENE_POINTS, ENT_STAGE_SCENE, ENT_STALL_STAGES,
    parseEnterprise, entFactsOf, EMPTY_ENT, indexEnterprise, lastTouchOf, indexLastTouch, datePlusDays,
    nurtureDueOf, nurtureList, nurtureInfo, buildNurtureCard, buildNurtureScript,
    // 2026-10-08 D3 企业级推进（候选盘点/台账写入/一段三件事）
    cmdEnterprise, writeEnterpriseLedger, entCandidateLists, isLikelyConsult, ENT_NEXT3, ENT_MATERIALS,
    // 2026-10-08 D4 飞轮管理（13 环 + 成交后/转介绍）+ 转介绍留痕
    cmdFlywheel, flywheelReport, writeReferral, parseReferral, indexReferral, REF_TAG, FW_DEFAULT_STALL, STD_NEXT_DO,
    // 2026-10-08 D5 周战役 + 周复盘
    cmdCampaign, campaignReport, cmdDigest, digestReport, CAMPAIGN_QUOTA,
    // 2026-10-09 通话中实时话术（外放通话 → 本机转写 → 边说边提示）
    cmdLive, LIVE_PLAYBOOK, LIVE_STAGE_OPEN, LIVE_STAGE_ACTION,
    // 2026-10-13 六分类（用户定：六类成页 + 等级随分类走）
    BUCKET_ORDER, BUCKET_DEF, LEVEL_GRADIENT, bucketOf, bucketDef, bucketLevelOf, bucketTerminal, bucketCounts, bucketPage, bucketPools, sortBucketList, syncLevelFor, levelRank,
    cmdStandard, cmdCustom, cmdPending, cmdFirst, FIRST_BUCKET_LIMIT, cmdAlignLevels,
    // 2026-10-19 四类跟进节奏（用户 m00409：重点跟进每天自看不进今日任务 / 标品成交每两周服务追踪 /
    //   待定跟进超一周再跟 / 挂起冷备不再跟进）+ 首触保底 10 条兜底
    FOCUS_CADENCE_DAYS, STANDARD_CADENCE_DAYS, PENDING_CADENCE_DAYS, CADENCE_DEF,
    cadenceDueOf, cadenceReport,
    // 2026-10-15 W1 合同台账（数据层：contract 命令 + 合同台账.json + 【合同】留痕）
    cmdContract, readContractLedger, writeContractLedger, pushContractLedger, contractRedDots,
    CONTRACT_TAG, CONTRACT_JSON, CONTRACT_TYPES, CONTRACT_STATUS, CONTRACT_PAY_STATUS, CONTRACT_AUDIT_MODES, CONTRACT_ACTIONS };
}
