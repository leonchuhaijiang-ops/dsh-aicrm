// 客户数据出网闸门（egress-guard）—— dsh-sales 的数据出口闸
// 口径（2026-09-17 用户拍板 C 档）：不做模型面脱敏；只堵「主动把客户数据送出本机」。
// 设计约束：
//   1) 纯函数、零依赖、全同步 —— 闸门在工具调用前跑，不许读盘/发网络/await；
//   2) 插件（dsh/index.js）与探针（_check/probe-sale-egress.cjs）、selftest 共用同一份判定；
//   3) 判定失败一律拒绝（fail-closed），绝不"拿不准就放行"。
// 覆盖的通道：web_search / web_fetch 的查询词、pwsh / bash 的命令行、npm publish / git push。
// 已知缺口（写在《销售数据标准》第九节，别假装没有）：分两步外传、编码混淆、以及
//   「pwsh 里跑一个命令行不带客户关键词的脚本，脚本自己读表再上传」—— 纯正则闸门拦不住，
//   只有防火墙出站白名单能拦。MODE=strict 可把"见 egress 动词即拒"打开，作为升级口。

/** 判定模式：balanced（默认，需同时命中"出网动词"与"客户数据特征"）| strict（见出网动词即拒）。 */
export const MODE = process.env.SALE_EGRESS_MODE === 'strict' ? 'strict' : 'balanced'

/** 客户数据落点特征：出现这些，说明这次调用很可能在搬我方数据。 */
// 2026-10-08 审计 B2 加固：原 8 条正则**都不带 /i**、且只认固定文件名/固定大小写目录，
//   实测 9 条绕过（大写 .XLSX、改名备份 backup\20261008-120000.xlsx、把盘符目录写成全小写
//   `<盘符>:\<某个含 sale 的目录>\...`、相对路径 `logs/egress-guard.log`…）。
//   现在改为「业务关键词 + 目录段 + 扩展名兜底」三层，全部 /i。
export const SALE_HINTS = [
  /销售客户/i,                         // 主表/流水表/任意前缀，不再依赖 .xlsx 完整名
  /运营销售-/i,
  /首访任务清单\.json/i,
  /营销资料库/i,
  /[\\/]sale[-_]?data[\\/]/i,       // 数据目录名（开源版由 config 决定，这里只认目录段）
  /[\\/]sale[\\/]/i,                   // 任意深度目录段 \sale\ 或 /sale/
  /(^|[\s"'=(])sale[\\/]/i,            // 相对路径 logs/... / sale/backup.json
  /\bsale\b/i,                         // 裸目录名（挡 `tar -czf - sale | curl …` 这类搬运）
  /\.(xlsx|xls|json|log)\b/i,          // 兜底：改名后的备份/日志/导出
]

/** 个人标识特征：手机号（11 位 1 开头）/ 客户ID / 邮箱。 */
export const PII = [
  /\b1[3-9]\d{9}\b/,
  /\bC-[\u4e00-\u9fa5]{1,6}-\d{4}-\d{3}\b/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
]

/** 出网动词：命令行里出现这些，就是"往机器外送"的动作。 */
export const VERBS = [
  /\bInvoke-WebRequest\b|\biwr\b/i,
  /Invoke-RestMethod/i,
  /Start-BitsTransfer/i,
  /System\.Net\.(WebClient|HttpClient|HttpWebRequest|WebRequest)/i,
  /\bcurl\b|\bwget\b/i,
  /\bnc\b|\bncat\b/i,
  /\bssh\b|\bscp\b|\bsftp\b|\bftp\b|\btelnet\b/i,
  /\bUploadFile\b|\bUploadString\b/i,
  /Send-MailMessage/i,
  /npm\s+publish/i,
  /\bgit\s+push\b/i,
  /\bgh\s+release\b/i,
  // 2026-09-29 补（第二道锁）：下三样是"绕开出网白名单"的经典搬运工具
  /\bbitsadmin\b/i,
  /certutil[^\n]*(-urlcache|-verifyctl|\s-f\s)/i,
  /\bnet\s+use\b/i,
  /\brobocopy\b/i,
  /\btftp\b/i,
  // 2026-10-08 审计 B2 再补：本地搬运工具（先打包/复制到共享盘，再手工外发）。
  //   ⚠️ 踩坑（实测两次）：判定文本是 `JSON.stringify(args)`，Windows 路径里的**单个** `\` 在文本里是 `\\`，
  //   于是"本地备份 Copy-Item 表.xlsx <盘符>:\backup\b.xlsx"会被当成 UNC 路径拦掉（selftest 售-17 当场报红）。
  //   → 动词表不再登记 copy/xcopy/Compress-Archive 这类"本地也合法"的命令（真 UNC 由 R-5 用反转义后的路径判），
  //     只留"天生就是往别的机器送"的两条：tar 打包（常配管道外发）与 PowerShell 远程会话复制。
  /\btar\b[^\n]*\s-c|\btar\b[^\n]*--create/i,
  /-ToSession\b|\bCopy-Item\b[^\n]*-To(Session|Remote)/i,
  /api\.telegram\.org|discord(app)?\.com\/api\/webhooks|hooks\.slack\.com|pastebin\.com|transfer\.sh|0x0\.st|file\.io|tmpfiles\.org|gofile\.io|anonfiles/i,
]

/**
 * UNC / 网络共享路径（`\\host\share`）：出现即代表"往别的机器写"。
 *
 * 2026-10-08 审计 B2 实测（两个假判 + 一个漏判，都在这条正则上）：
 *   · 判定文本通常是 `JSON.stringify(args)`，Windows 路径里的**单个** `\` 会变成 `\\`，于是
 *     `<盘符>:\backup\b.xlsx` / `backup\x.xlsx` 这种本机路径也"长得像 UNC" → 本地备份被误拦（selftest 售-17 报红）。
 *   · 反过来，selftest 的另一种调用约定（`assessCall('pwsh', 原始命令串)`）里 UNC 写作 4 个反斜杠（序列化形态），
 *     而"反转义一次再判"会把 8 个反斜杠的宿主串还原成 4 个 → 又判不出来（售-16 报红）。
 *   → 结论：**不要反转义，改成"路径段起点 + 反斜杠连续段"形状判定**：
 *     ① 第一个反斜杠段必须出现在**路径段起点**（行首 / 空白 / 引号 / `(` / `=` 之后）—— 本机路径的反斜杠前面
 *        是盘符 `D:` 或文件名（`backup`），不满足；真 UNC 的前面一定是空格/引号这类分隔符。
 *     ② 两段反斜杠各用 `{2,}` / `{1,}`：不管调用方是否 JSON 转义（1 份或 2 份反斜杠）都能命中。
 *   实测：`"<盘符>:\\backup\\b.xlsx"`（序列化）→ 判不出（放行）；`"copy sale\\* \\\\host\\share"`（序列化）→ 命中；
 *         `\\192.168.1.9\share\a.xlsx`（原始串，未额外转义）→ 命中。
 */
export const UNC_PATH = /(?:^|[\s"'=(])\\{2,}[A-Za-z0-9._$-]{2,}\\{1,}[A-Za-z0-9._$%-]+/

/** 编码/混淆搬运：PowerShell 编码命令、base64 转换、超长 base64 串。 */
export const ENCODE = [
  /-EncodedCommand/i,
  /(^|\s)-enc\s/i,
  /FromBase64String|ToBase64String/i,
  /\batob\s*\(|\bbtoa\s*\(/i,
  /[A-Za-z0-9+/]{300,}={0,2}/,
]

/** R-8 用：称呼式/裸姓名（百家姓锚定到词首）+ 公司机构名特征。 */
//   裸姓名必须**锚在词首**（行首或空白/标点之后）并紧跟分隔符 —— 否则「工程管理」这类词
//   会因为「程」是姓氏而误报（R-8 只该挡"张三 某某公司"这种身份外泄）。
export const SURNAMES = '赵钱孙李周吴郑王冯陈蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜谢邹苏潘葛范彭鲁韦马苗方俞任袁柳唐费廉薛雷贺倪汤罗郝安常于傅齐康伍余顾孟平黄和穆萧尹姚邵汪毛宋庞熊纪舒屈项祝董梁杜阮蓝闵席季贾路江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫房裘解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊惠甄曲家封芮储靳段富巫乌焦巴牧山谷车侯全班仰秋仲伊宫宁仇栾甘厉祖武符刘景詹龙叶幸司黎薄印宿白怀蒲鄂索咸赖卓屠蒙池乔胥苍闻党翟谭贡劳姬申扶堵冉雍桑桂牛寿通边燕浦尚农温庄晏柴瞿阎充慕连茹习艾容向古易慎戈廖庾居衡步都耿满弘匡国文寇广东欧沃利越隆师巩聂晁勾融冷辛简饶曾沙养丰巢关查荆红游权盖益桓'
export const PERSON_HINT = new RegExp('(?:^|[\\s，,、：:（(\\"\'\\[{\\\\/])[' + SURNAMES + '][\\u4e00-\\u9fa5]{1,2}(?:先生|女士|老师|总|经理|主任|总监|董)?(?=$|[\\s，,、：:）)\\"\'\\]}\\\\/的])')
export const ORG_HINT = /有限公司|股份有限公司|集团|事务所|研究院|设计院|工程管理|科技有限|咨询|中心|厂|店/

// ---- R-8 误报词表（2026-10-17）----
//   背景：SURNAMES 里本来就有「封/安/方/程/关/项/马/高…」，于是普通词「封面 / 安全 / 方案 / 程序 /
//   关键 / 项目 / 高端」会被裸姓名分支当成「张三」这种两字名；再碰上 ORG_HINT 的「中心」，
//   一次正常检索就被 R-8 拦了。实测（封 is a 姓）：`web_search "视频号 封面 尺寸 1080 1260 官方 帮助中心"`
//   → 命中 person="封面" org="中心" = 误报，不是泄密。
//   口径：**只加不减**，R-8 判据语义不变（仍是"人名 + 公司名"才拦），只是"人名"不再认这些普通词。
//   维护：加词必须同时在 sale\scripts\selftest.cjs「售-27」一批里跑正反例（词表逐词放行 + 真名仍拦）。
export const PERSON_NOUNS = new Set([
  // 封（姓氏「封」）
  '封面', '封图', '封条', '封面图', '封皮',
  // 安（「安」姓）
  '安全', '安装', '安排', '安静', '安心', '安徽', '安防',
  // 方（「方」姓）
  '方案', '方法', '方向', '方式', '方面', '方便', '方程', '方位', '方法论',
  // 程（「程」姓）
  '程序', '程序化', '程度',
  // 关（「关」姓）
  '关键', '关系', '关注', '关于', '关闭', '关联',
  // 项 / 余 / 顾 / 马 / 万 / 包 / 石 / 毛 / 高 / 常 / 于 / 和（都是姓氏字打头的普通词）
  '项目', '余额', '余量', '顾客', '顾问', '顾及', '马上', '万一', '万元', '包含', '包装', '包括', '包月',
  '石油', '石头', '石膏', '毛坯', '毛利', '毛病', '高端', '高效', '高清', '高价', '常规', '常见', '常常',
  '常态', '常年', '于是', '和平',
  // 其他高频（贾/路/江/童/颜/梅/盛/钟/夏/田/凌/支/管/房/解/应/宣/单/洪/左/陆/荣/羊/惠/曲/家/储/焦/山/谷/车/全/班/秋/宁/仇/甘/厉/祖/武/符/景/龙/叶/幸/司/黎/薄/印/宿/白/怀/索/卓/蒙/池/乔/苍/闻/党/贡/劳/申/扶/堵/桂/牛/寿/通/边/燕/尚/农/温/柴/充/连/习/艾/容/向/古/易/慎/居/衡/步/满/国/文/广/东/欧/利/越/师/巩/勾/融/冷/辛/简/曾/沙/养/丰/查/红/游/权/盖）
  '路线', '路灯', '路演', '江苏', '江西', '江南', '童话', '颜色', '梅花', '盛行', '盛大', '钟表',
  '夏季', '夏天', '田野', '凌晨', '支付', '支持', '支架', '管理', '管控', '管道', '管线', '房产', '房屋',
  '房价', '房间', '解决', '解释', '解析', '解码', '应用', '应急', '应该', '应对', '宣传', '宣布', '宣发',
  '单位', '单价', '单独', '单元', '杭州', '洪水', '洪灾', '左右', '左边', '陆地', '陆续', '荣誉', '羊毛',
  '惠民', '优惠', '曲线', '曲目', '家具', '家庭', '家长', '家电', '储能', '储备', '储蓄', '焦点', '焦虑',
  '牧场', '山西', '山东', '山区', '谷物', '车辆', '车次', '全部', '全新', '全国', '全年', '全省', '班级',
  '班次', '秋季', '秋天', '宁夏', '宁静', '宁可', '仇恨', '甘肃', '厉害', '祖国', '武汉', '武器', '武功',
  '符合', '符号', '景区', '景点', '景观', '景气', '龙头', '龙年', '叶片', '幸福', '司法', '司机', '黎明',
  '薄弱', '印刷', '印象', '宿舍', '白酒', '白天', '白色', '白皮书', '怀疑', '索引', '索赔', '卓越', '蒙古',
  '蒙牛', '池塘', '乔木', '苍白', '闻名', '党建', '党员', '贡献', '劳动', '劳务', '申报', '申请', '申领',
  '扶贫', '扶持', '堵塞', '桂林', '桂花', '牛市', '牛奶', '寿命', '通用', '通讯', '通信', '通知', '通过',
  '通行', '边界', '边缘', '边境', '燕麦', '尚未', '尚可', '农业', '农村', '农民', '农产品', '温度', '温室',
  '柴油', '充电', '充足', '充分', '连接', '连续', '连锁', '习惯', '艾草', '容易', '容量', '容器', '向上',
  '向下', '古代', '古老', '古典', '易用', '易错', '易学', '慎重', '居民', '居住', '居家', '衡量', '步骤',
  '步行', '步伐', '满意', '满足', '满分', '国家', '国内', '国际', '国企', '国标', '国产', '文件', '文字',
  '文章', '文案', '文档', '文献', '文旅', '文明', '广告', '广州', '广东', '广西', '广场', '广泛', '东方',
  '东风', '东北', '东京', '欧洲', '利润', '利益', '利息', '利用', '师资', '师傅', '巩固', '勾选', '勾勒',
  '融资', '融合', '融入', '冷库', '冷门', '冷却', '辛苦', '简单', '简易', '简历', '简介', '曾经', '沙漠',
  '沙发', '沙子', '养殖', '养老', '丰富', '丰收', '查询', '查看', '检查', '荆州', '红色', '红利', '红包',
  '红旗', '游戏', '游览', '权利', '权限', '权威', '权益', '盖章', '董事', '董事会',
])

/** 裸姓名片段的「核心词」：去掉正则吃进来的前边界与后分隔符。 */
function nameCore(t) {
  return String(t == null ? '' : t)
    .replace(/^[\s，,、：:（("\'\[{\\\/]+/, '')
    .replace(/[\s，,、：:）)"'\]}\\\/的]+$/, '')
}
const PERSON_RE_G = new RegExp(PERSON_HINT.source, 'g')
/** R-8 的人名判定：命中称呼式/裸姓名，但**排除普通名词**（PERSON_NOUNS）。 */
export function personHintHit(text) {
  const s = String(text == null ? '' : text)
  PERSON_RE_G.lastIndex = 0
  let m
  while ((m = PERSON_RE_G.exec(s)) !== null) {
    const core = nameCore(m[0])
    if (core && !PERSON_NOUNS.has(core)) return true
    if (PERSON_RE_G.lastIndex <= m.index) PERSON_RE_G.lastIndex = m.index + 1
  }
  return false
}

/** 代码里的网络库 API：与客户数据同现 = "写个脚本把表发出去"。 */
export const NET_LIBS = [
  /fetch\s*\(/i,
  /https?\.(request|get)\s*\(/i,
  /\baxios\b/i,
  /XMLHttpRequest/i,
  /FormData\s*\(/i,
  /\burllib\b/i,
  /\brequests\.(post|put|patch)\s*\(/i,
  /\.upload\s*\(/i,
  /WebSocket/i,
  /\bsmtplib\b/i,
  /nodemailer/i,
]

/** 走「查询/抓取」通道的模型工具（参数就是要发出去的正文）。 */
export const NETWORK_TOOLS = ['web_search', 'web_fetch']
/** 走「命令行」通道的工具（可执行任意外传脚本）。 */
export const SHELL_TOOLS = ['pwsh', 'bash', 'bash_persistent', 'pwsh_persistent', 'run_code']

// 2026-10-13 批次 5（审计 F12 修）：上面两个是**字面常量**——宿主后来新增/改名一个 shell 类工具
//   （例如换了新的执行器名），闸门就会因为"通道不认得它"而**整体放行**（fail-open）。
//   这里提供一条**只加不减**的并集注入：注册 guard 时把宿主实际工具名并进来（R-1..R-8 判据语义不动）。
//   为什么是并集而不是"白名单"：并集只会让**更多**调用被审，绝不会让原来被拦的放行 → 不会引入新的漏判。
//   幂等、去重、对畸形输入静默容忍（数组里非字符串一律忽略）；返回本次真正新增的名字，供 /sales/egress 自证。
const _injectedTools = []
// 只接受"看起来像工具名"的 token（ASCII 标识符 + _ . : -），其余（说明文字、数字、空串）一律忽略——
//   闸门这边宁可少并几个，也不能把一句中文说明当工具名塞进判定表。
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
export function injectEgressTools(names) {
  const added = []
  if (!Array.isArray(names)) return added
  for (const n of names) {
    if (typeof n !== 'string') continue            // 数字/对象等不是工具名，不做 String() 强转
    const s = n.trim()
    if (!TOOL_NAME_RE.test(s)) continue
    if (NETWORK_TOOLS.indexOf(s) >= 0 || SHELL_TOOLS.indexOf(s) >= 0) continue
    SHELL_TOOLS.push(s)
    _injectedTools.push(s)
    added.push(s)
  }
  return added
}
/** 已注入的额外工具名（只读自证用）。 */
export function egressInjectedTools() { return _injectedTools.slice() }

// 2026-10-13 批次 5（审计 F12 自证加强）：「拿不到工具清单」与「拿到了但没有新名字可并」必须一眼分得开，
//   否则 no-op 与成功并集在 /sales/egress 里长得一模一样（用户/探针无法判断这条防线到底生效没有）。
//   三种状态靠 guardToolsDiscover.ok + reason + guardToolsMerged 组合判定：
//     ok=false                       → 本次是 no-op；reason 说明是「宿主没暴露目录」还是「格式不认得」
//     ok=true  && merged=false       → 目录读到了，但没有需要并的新工具名
//     ok=true  && merged=true+added  → 真并入了 added 里的名字
//   纯自证字段：不参与 R-1..R-8 任何判据，没回填时默认值如实写「未尝试读取」。
let _lastDiscover = { ok: false, reason: '未尝试读取宿主工具目录（guard 注册没跑到或失败）', added: [] }
/** 由 index.js 在 guard 注册时回填本次「读宿主工具目录」的结果（只读取信号，不参与判定）。 */
export function noteEgressToolDiscover(ok, reason, added) {
  _lastDiscover = {
    ok: !!ok,
    reason: String(reason || (ok ? '已读到宿主工具目录' : '宿主没有暴露工具目录')),
    added: Array.isArray(added) ? added.filter((x) => typeof x === 'string').slice(0, 64) : [],
  }
}
/** 读一次本次「读宿主工具目录」的自证结果（/sales/egress 用）。 */
export function egressToolDiscover() {
  return { ok: !!_lastDiscover.ok, reason: _lastDiscover.reason, added: _lastDiscover.added.slice(), injected: _injectedTools.slice() }
}

/** 判定用的严重级：命中即为"这次调用正在把客户数据带出本机"。 */
const HITS = { SALE: 'sale-data', PII: 'pii' }

function hitOne(patterns, text) {
  for (const p of patterns) if (p.test(text)) return true
  return false
}

/**
 * 判一次工具调用该不该拦。
 * @param {string} name 工具名
 * @param {string} argsText 参数序列化后的文本（调用方负责序列化；序列化失败请传非字符串触发 fail-closed）
 * @param {'balanced'|'strict'} [mode]
 * @returns {{deny:boolean, rule?:string, reason?:string}}
 */
export function assessCall(name, argsText, mode = MODE) {
  // R-4 fail-closed：参数拿不到（没序列化出来）就没有把握，直接拒。
  if (typeof argsText !== 'string') {
    return { deny: true, rule: 'R-4', reason: '客户数据出口闸门：本次调用参数无法解析，已按最坏情况拒绝（fail-closed）。' }
  }
  const tool = String(name || '')
  // 2026-10-08 审计 B2 加固：原来只截前 200000 字符 —— 把敏感内容塞在头部填充之后即可绕过
  //   （实测 200001 字符前缀填充 → ALLOW）。现在超长时做**多段采样**：头 100K + 尾 100K + 每 200K 取 2K，
  //   采样不到不代表干净，因此再用 ENCODE 的「超长 base64」与「超大载荷」兜底 fail-closed。
  const CAP = 200000
  let text = argsText
  let oversize = false
  if (argsText.length > CAP) {
    oversize = true
    const parts = [argsText.slice(0, 100000), argsText.slice(-100000)]
    for (let i = CAP; i < argsText.length; i += CAP) parts.push(argsText.slice(i, i + 2000))
    text = parts.join('\n')
  }
  if (!text) return { deny: false }

  // 路径形状判定直接用 text（UNC_PATH 已按"路径段起点 + 反斜杠连续段"设计，见其注释：不反转义也能同时吃
  //   两种调用约定，且本机 Windows 路径不会被误判）。
  const sale = hitOne(SALE_HINTS, text)
  const pii = hitOne(PII, text)
  const verb = hitOne(VERBS, text)
  // 2026-10-08 审计 B2：超大载荷（>200KB）视为"有数据嫌疑" —— 采样可能漏，宁可让它必须过出网判据
  //   （oversize 且带出网动词 → R-2 拒；oversize 且是搜索/抓取工具 → R-1 拒）。纯本地大写入不受影响。
  const dataish = sale || pii || oversize

  // R-1：搜索/抓取的正文里带客户数据 → 拒
  if (NETWORK_TOOLS.indexOf(tool) >= 0 && dataish) {
    return {
      deny: true, rule: 'R-1',
      reason: '客户数据出口闸门（R-1）：这次 ' + tool + ' 的参数里带' + (sale ? '客户数据文件/目录' : '手机号等个人标识') +
        '，禁止出境。请改用本地 sales_* 工具；确实需要联网搜索时，把客户信息去掉再试。',
    }
  }

  // R-2：命令行工具里出现"出网动词" → 看模式
  if (SHELL_TOOLS.indexOf(tool) >= 0 && verb) {
    if (mode === 'strict' || dataish) {
      return {
        deny: true, rule: 'R-2',
        reason: '客户数据出口闸门（R-2）：检测到出网动作（' + (dataish ? '且参数带客户数据特征' : 'strict 模式下无条件拒绝') + '），' +
          '禁止把 sale 数据送出本机。请改用本地 sales_* 工具；纯本地开发命令（不联网）不受影响。',
      }
    }
  }

  // R-3：**只在可能出网的通道**（搜索/抓取/命令行）里，同时出现"出网动词"与"dsh-sales / sale 目录" → 拒（挡发布类动作）
  //   2026-09-29 审计修（sale-audit P1-2）：原实现对**任何工具**生效 → 连本地文件写入与团队协作工具都被拦
  //   （实测拦掉 2 次 spawn_teammate），而且**自锁**：改本文件、写含出网动词的报告都会被拒。
  //   通道限定后既挡得住院，又不误伤本地操作（NETWORK_TOOLS/SHELL_TOOLS 之外的通道传不出数据）。
  if ((NETWORK_TOOLS.indexOf(tool) >= 0 || SHELL_TOOLS.indexOf(tool) >= 0)
    && verb && hitOne([/dsh-sales/i, /[\\/]sale[-_]?data[\\/]/i, /营销资料库/], text)) {
    return {
      deny: true, rule: 'R-3',
      reason: '客户数据出口闸门（R-3）：该命令同时涉及 sale/dsh-sales 与出网动作（如 npm publish / git push），' +
        '为防客户数据随包上网，已拦截。发布类操作请另行人工确认后再执行。',
    }
  }

  // ---- R-5 / R-6 / R-7（2026-09-29 第二道锁：堵三个已知绕过口）----
  //   通道纪律与 R-3 相同：只判 NETWORK_TOOLS / SHELL_TOOLS（能真正把字节送出去的两类）。
  //   刻意不判 write/edit 等本地写工具 —— 否则"改一份含客户表名与 UNC 示例的回归用例"会被自锁
  //   （2026-09-29 审计 P1-2 就是这么发现 R-3 自锁的）。
  const transmissible = NETWORK_TOOLS.indexOf(tool) >= 0 || SHELL_TOOLS.indexOf(tool) >= 0
  if (transmissible) {
    //   UNC 判定见 UNC_PATH 注释：本机路径（反斜杠前是盘符/文件名）不命中，真 UNC（路径段起点 + 反斜杠段）命中。
    const unc = UNC_PATH.test(text)

    // R-5：客户数据 + UNC/网络共享路径（写 \\host\share）→ 拒
    if (unc && dataish) {
      return {
        deny: true, rule: 'R-5',
        reason: '客户数据出口闸门（R-5）：命令里同时出现客户数据与网络共享路径（\\\\主机\\共享），' +
          '等于把表写到别的机器上，已拦截。要备份请写本机磁盘。',
      }
    }

    // R-6：编码/混淆搬运（-EncodedCommand / base64 转换 / 超长 base64）→ 与客户数据或出网迹象同时出现即拒
    if (hitOne(ENCODE, text) && (dataish || verb || unc)) {
      return {
        deny: true, rule: 'R-6',
        reason: '客户数据出口闸门（R-6）：检测到编码/混淆式搬运（编码命令或长 base64）并伴随客户数据/出网迹象，' +
          '已按最坏情况拦截。本地 base64 传参（不带出网动作）不受影响。',
      }
    }

    // R-7：客户数据 + 代码里的网络库 API（"写个脚本读表再上传"）→ 拒
    //   这条比 R-2 宽：不看有没有现成的出网动词，只要脚本里既碰表又用网络库，就当外传处置。
    if (dataish && hitOne(NET_LIBS, text)) {
      return {
        deny: true, rule: 'R-7',
        reason: '客户数据出口闸门（R-7）：这段代码同时涉及客户数据与网络 API（fetch/axios/requests/上传…），' +
          '疑似把表发出去，已拦截。纯本地处理（sales-lib / 探针 / 看板）不受影响。',
      }
    }
  }

  // R-8（2026-10-08 审计 B5）：搜索/抓取里**同时出现称呼式人名与公司名** → 拒。
  //   背景：R-3 收窄到只判出网/命令行通道后，`spawn_teammate` 那条"把姓名+公司名交给子代理再搜"的
  //   中间人通道打开了（实测 `web_search "张三 深圳市某某科技有限公司"` 直接 ALLOW）。
  //   这里只判 NETWORK_TOOLS（真正把文本交给外部检索的通道），**不判 spawn_teammate**——
  //   否则团队协作再次自锁（2026-09-29 P1-2 的教训）。
  //   2026-10-17：人名判定改走 personHintHit()（排除 PERSON_NOUNS 里的普通词），
  //   否则「封面 + 帮助中心」这种正常检索会被误拦（实测误报，不是泄密）。
  if (NETWORK_TOOLS.indexOf(tool) >= 0 && personHintHit(text) && hitOne([ORG_HINT], text)) {
    return {
      deny: true, rule: 'R-8',
      reason: '客户数据出口闸门（R-8）：这次检索同时带"客户称呼（X先生/女士/总…）"与"公司名"——' +
        '把这两样一起送外部搜索引擎等于泄露客户身份。请去掉姓名/公司名，只搜行业或产品问题；' +
        '客户背景请用本地 sales_view / sales_next。',
    }
  }

  return { deny: false }
}

/** 审计日志用的短预览：截断 + 手机号打码（只影响日志，不影响模型看到的数据）。 */
export function logPreview(text, max = 120) {
  let s = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text)
  s = s.replace(/\b(1[3-9])\d{6}(\d{3})\b/g, '$1******$2')
  s = s.replace(/\s+/g, ' ')
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 命中判定的规则号 → 人类可读说明（doctor / 看板共用）。 */
export const RULES = {
  'R-1': '搜索/抓取参数含客户数据',
  'R-2': '命令行出网动词 + 客户数据（或 strict 模式）',
  'R-3': '出网动词 + sale/dsh-sales（publish/push 类）',
  'R-4': '参数无法解析（fail-closed）',
  'R-5': '客户数据 + UNC/网络共享路径',
  'R-6': '编码/混淆搬运（编码命令 / 长 base64）+ 客户数据或出网迹象',
  'R-7': '客户数据 + 代码里的网络库 API（读表再上传）',
  'R-8': '搜索/抓取同时出现称呼式人名 + 公司名（身份外泄）',
}
