# 架构说明

写给想改代码或 review 的人。plugin 的一半跑在宿主进程（Node），一半跑在页面（浏览器侧），中间只靠 DSH 的注册点和一条本机 HTTP 路由联系。

## 1. 目录

```text
dsh-sales/
├── cordis.patch.yml          # bundle 声明：往宿主里 insert 一个 id=sales 的组合单元
├── package.json              # dsh.bundle.patch / dsh.client 两个注册点
├── dsh/
│   ├── index.js              # 【宿主半】16 个模型工具 + /sales/* 路由 + AI 编排
│   ├── ai.js                 # 唯一的模型出口（llm.stream）
│   ├── config.js             # 配置解析：SALE_DIR > 配置文件 > 默认目录
│   ├── rag.js                # 本地词法检索（营销资料库）
│   ├── redact.js             # 字段级脱敏 / 回填
│   ├── egress-guard.js       # 客户数据出网闸门（R-1…R-8）
│   ├── dock.js               # AI 对话框（看板左侧）宿主侧实现
│   ├── dock-attach.cjs       # 对话框挂载辅助（CJS，供宿主注入的加载器用）
│   ├── contract-docx.js      # 生成 .docx（自带 zip 写法，不跨包）
│   ├── contract-review.js    # 合同规则初审
│   ├── contract-templates/   # 三份合同模板（standard / nda / enterprise）
│   ├── client.js             # 【页面半】侧边栏入口 + 全屏看板 + 通话记录台
│   └── ai-route.json         # AI 用途分派（哪些用途走哪档；代码内部用）
├── lib/
│   └── sales-lib.js          # 数据层（CJS）：Excel 读写、SOP 引擎、各类派生视图
├── scripts/                  # setup / doctor / check-no-pii / smoke（smoke 会加载 dsh/）
├── templates/营销资料库/     # 示例语料（setup 复制进数据目录）
└── docs/                     # 本目录
```

一条纪律：**数据层只认 `lib/sales-lib.js`**。任何地方要读写 Excel，都通过它以子进程方式调用，不在宿主进程里直接 `XLSX.readFile` 业务表。

## 2. 两个半区

### 宿主半 `dsh/index.js`

启动时做四件事：

1. `defineTool` 注册 16 个模型工具（见 [docs/tools.md](./tools.md)）；
2. 注册 `/sales/*` HTTP 前缀路由，给看板读配置、初始化目录、点按钮调模型；
3. 注入 `llm` 服务句柄（可选：宿主没装模型服务，插件也必须照常跑）；
4. 把 `egress-guard` 挂到工具调用之前。

### 页面半 `dsh/client.js`

通过 DSH 的 UI 扩展点挂三块：

| 扩展点 | 挂什么 |
|---|---|
| `sidebar.footer.action` | 侧边栏底部的销售入口（点开全屏看板） |
| `shell.overlay` ×2 | 全屏看板 `sales-board`；通话记录台浮层 `sales-live-panel` |
| `conversation.input.left` | `sales-live-wire`，渲染 `null`，只用来挂载通话转写的接线 |

看板 9 个页签：今日任务 / 待首触 / 挂起冷备 / 待定跟进 / 重点跟进 / 标品成交 / 定制开发 / 合同管理 / 查询指导（客户查询 + 销售指导合并页）；标题栏另有「⚙ 设置」面板（数据目录、模型通道、RAG、公司/产品名）。内容区**左侧**是 AI 对话框。

## 3. 数据层 `lib/sales-lib.js`

一个约 5800 行的 CJS 文件，形态是 CLI：

```bash
node lib/sales-lib.js <cmd> [json] --dir <数据目录>
```

宿主/工具侧用子进程调用它，JSON 走参数（大参数走 `b64` 变体，避免中文在 shell 里被转码）。它负责：

- **写入口唯一**：`cmdLog` / `cmdAdd` / `writeMaster` / `writeFlow` —— 写锁（`.sales-lock`）+ 表头断言 + 原子写（tmp→rename）+ 变更日志。禁止绕过它们直接写表。
- **表头契约**：`HEADERS_MASTER`(31) / `HEADERS_FLOW`(11) / `HEADERS_CONTACT`(5)，新建表只能 `aoa_to_sheet([headers])`。
- **派生视图**：`tasks` / `view` / `sop` / `next` / `plan` / `brief` / `settle` / `enterprise` / `flywheel` / `campaign` / `digest` / `summary` / `live` / `clienttip` / `contract`。所有「今天该打给谁」「飞轮哪一环堵了」都是**现算**，不落盘缓存 —— 缓存的派生字段一定会过期，过期数据比没有数据更危险。
- **SOP 引擎**：13 段有序漏斗 + 2 个出口；等级随六分类归一；`知识点/话术` 从营销资料库现取。

它**不知道 DSH 的存在**：`--dir` 传进来就能跑，所以 `scripts/*.mjs` 可以脱离插件单独自检。

## 4. 一次「记跟进」的完整路径

```text
你在 AI 助手输入框说一句话
  → 助手按九要素抽字段 → 可编辑确认卡（卡头「已填 N/9」）
  → 你确认（args = 卡上改后的值）
  → 模型调用 sales_log(args)
  → index.js 校验/归一参数（按 11 位手机号定位客户；nextDate 三态、level 哨兵 "-"）
  → egress-guard 检查（本例不出网，直接放行）
  → 子进程 node lib/sales-lib.js log '<json>' --dir <dir>
       → 拿 .sales-lock
       → 读流水表 + 主表（sheet_to_json，defval:''）
       → 追加一行流水、回写主表状态/排期/等级
       → 表头断言 → 原子写两张表 → 释放锁 → 写变更留痕
  → 回执给助手（含 nextStage 提示；只显示手机号，不显示内部客户ID）
```

`nextDate` 的三态（写日期 / 清空 / 不动原排期）在 `index.js` 里显式构造：**没传就不带这个键**，让数据层能区分「未提供」和「显式清空」。这是被真实事故打出来的补丁 —— 早期实现恒传空串，导致每次不带日期的跟进都会静默抹掉排期。

## 5. 模型出口 `dsh/ai.js`

- 全插件**唯一**允许 `llm.stream(` 的文件；别的文件要调模型只能 import `aiStream`。
- 只走宿主 `ctx.llm` / `ctx.get('llm')`；不新增 `fetch`、不直连 provider、不持有 key。
- 任何异常返回 `{ok:false, error}`，**绝不抛**：模型面挂了，规则版必须照常出结果。
- 每次调用有硬超时与字数上限（不同用途不同，如实时话术 16s、整段文案 30s），超时就回落规则版，并且**失败一次会冷却一段时间**，避免每次调用都先白等一个超时。
- 台账 `logs/ai-calls.log` 只记 purpose / 模型 / 耗时 / 字数 / 成败。
- `ai.mode` 三档的解析在 `dsh/config.js`：`session` 现读当前会话模型；`fixed` 用配置的 provider+model；`local` 用本机 provider 且强制 `reasoningEffort=off`。

**思考档位**是跟 provider 能力绑定的可选项。不填就不传参数；某些 provider 收到不支持的档位会整发请求失败，所以默认留空。

## 6. HTTP 面

统一形态：`GET /sales/<method>?<urlencoded json>` 或 `POST /sales/<method>`（body = 原始 JSON）。

| 端点 | 作用 | 写客户表？ |
|---|---|---|
| `config` | 读配置状态 | 否 |
| `configset` | 打补丁改配置 | 否 |
| `setup` | 建目录 + 空表 + 示例语料 | 否（只建空表） |
| `configtest` | 真发一次极短模型请求 | 否 |
| `plan` / `tasks` / `view` / `sop` / `next` / `brief` / `digest` / `summary` / `flywheel` / `enterprise` / `campaign` / `live` / `clienttip` | 派生视图 | 否 |
| `profile` | 客户档案读写（`action=get\|set\|list\|draft`） | 否（写的是 `客户档案.json`） |
| `stagefix` | 给一条「其他跟进记录」归段 | **是**（只改这条流水的「阶段」，不新建、不动主表当前阶段） |
| `contract` | 合同台账读 | 否 |
| `ai` | 看板按钮按需调模型（`action=live\|clienttip\|next\|brief\|digest\|contract`；`purpose=profile` 提炼档案） | 否 |

**HTTP 面原则上不写客户表**：请求里带写意图（写 `settle`、带 `facts`、带 `by`+`to` 这类）一律 **403**；写操作只能通过模型工具，经 `ctx.tools.guard` 那层护栏。唯一例外是归段 `stagefix`——它只修正已有流水的一条「阶段」标注（必须带 `phone` + `flowId`，不能新建记录），是看板上的显式人工操作。这是刻意的不对称：页面负责展示与触发 AI，落库以可审计的工具入口为准。

## 7. 合同生成

`dsh/contract-docx.js` 自己拼 OOXML（zip + XML），**不跨包 import**，也不调用模型（生成层不碰 AI）。这样做的原因：`.docx` 只是 zip 里几个 XML，引第三方 docx 库会把依赖树放大，而生成内容完全由模板 JSON 决定。

> 生成时优先用 `fflate`（已声明依赖；有它则压缩，`.docx` 体积更小）。运行环境里没有 `fflate` 时**不会失败**：`contract-docx.js` 内置零依赖 ZIP 写入（STORE 方式，局部头 + 中央目录 + EOCD + 自算 CRC32）照常产出合法 `.docx`；台账读写和规则初审不受这两条路径影响。

`contract-review.js` 是**规则初审**：条款缺失、金额/税率异常、付款节点不闭合、期限倒挂等，输出高风险 / 中风险 / 待人工 + 免责声明。它给的是提示，不是法律意见。

## 8. 自检脚本（不依赖 DSH）

| 脚本 | 用途 | 何时跑 |
|---|---|---|
| `scripts/setup.mjs` | 建目录骨架 + 空表 + 示例语料 + 配置档；幂等 | 首次安装 |
| `scripts/doctor.mjs` | 只读体检（Node 版本、表头契约、目录可写、语料完整…；项数随版本增加） | 装完 / 换机 / 升级前 |
| `scripts/check-no-pii.mjs` | 扫手机号、邮箱、身份证、API key、本机绝对路径、私有品牌词 | 每次发版 / CI |
| `scripts/smoke.mjs` | 集成冒烟：假 ctx 加载 `dsh/index.js`，真跑 `/sales` 路由与数据层（不需要 DSH、不调真模型；首次跑在 `node_modules` 造 `dsh-tools` 桩） | 提交前 / CI |

`setup` / `doctor` / `check-no-pii` 三个脚本都**故意不 import `dsh/`**：它们要能在没有 DSH 的机器上跑（比如 CI）。代价是它们各自复制了一份表头常量与目录规则 —— 所以 `doctor.mjs` 会从 `lib/sales-lib.js` 源码里提取 `HEADERS_*` **逐字比对**，防止两份漂移。`smoke.mjs` 相反：它就是要加载 `dsh/index.js`，用假 ctx 把路由与工具真跑一遍。

## 9. 想扩展的话

| 想加什么 | 改哪里 | 注意 |
|---|---|---|
| 新工具 | `dsh/index.js` 里 `defineTool` | 参数用中文名可以，但保持与现有风格一致；写操作走 `run('…')` → `sales-lib` |
| 新派生视图 | `lib/sales-lib.js` 加 cmd，再在 `index.js` 挂工具/路由 | 派生数据**现算不缓存** |
| 新列 | 先改 `HEADERS_*`，再改 `scripts/setup.mjs` 的同名常量 | 改完必须跑 `npm run doctor`；老数据要迁移 |
| 新合同模板 | `dsh/contract-templates/*.json` | 结构照抄 `standard.json` |
| 换模型通道 | 只改配置，不改代码 | 见 [docs/configuration.md](./configuration.md) |

三条不许破的线：

1. **不许**在 `dsh/ai.js` 以外出现 `llm.stream(`；
2. **不许**绕过 `sales-lib` 的写入口直接写 xlsx；
3. **不许**在插件里 new 一个网络请求（`fetch` / `http.request`）——出网只经宿主。

---

下一步：[模型工具清单](./tools.md) · [隐私与数据边界](./privacy.md) · [参与贡献](../CONTRIBUTING.md)
