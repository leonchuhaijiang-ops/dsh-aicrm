# Changelog

本项目从 1.0.0 起以开源形式发布。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

## [1.1.1] - 2026-11-10

### 新增

- **「其他跟进记录」桶**：归不进 13 段漏斗、也不属于两个出口的跟进（老数据没写阶段、随手记的行业闲聊、跨段杂事）现在有明确去处——`sales_log` 传 `stage: "其他跟进记录"`（同义：`其他` / `未归类`）即落该桶：流水「阶段」留空、**主表当前阶段不动**；看板 SOP 面板底部显示「其他跟进记录」，`sales_sop` 返回 `unlabeled` + `unlabeledLabel`。历史里阶段为空的记录同样落这个桶，不会丢。

### 修复

- 集成冒烟里 `sales_log` 写读闭环原来因客户ID取错字段被静默跳过，现在真正执行；新增 4 条断言覆盖上述桶行为（共 35 条）。

## [1.1.0] - 2026-11-10

### 新增

- **示例数据（demo）**：新库不再只能看到空表。三种入口任选：命令行 `node scripts/demo.mjs`（`--clean` 清除、`--info` 查看）、看板首次设置向导里的「先生成 3 条示例看看」、看板「⚙ 设置 → 示例数据」。示例客户 ID 固定 `DEMO-001`~`DEMO-003`、公司名带「示例」、电话为示例号段，并在数据目录写 `示例数据.json` 登记清单；清除只删登记过的 ID，**不会碰真实客户**。写入仍走 `lib` 的 `writeMaster` / `writeFlow`（写锁 + 表头断言 + 原子写 + 变更留痕）。
- **`POST /sales/demo`**：`{ mode: 'seed' | 'clean' | 'info' }`，供看板调用；只收 POST。
- **`npm run demo`** 脚本别名。

### 文档

- README 新增「装不上怎么办」四条速查（启用失败 / npm install 失败 / 404 白屏 / 空库）。
- `docs/install.md` 常见问题补充「`npm install` 装不上」「示例数据怎么清」；§5 补示例数据入口。

### 修复

- 新建客户的默认责任人不再写死某个具体人名（改为留空，由使用者自己填）。

## [1.0.0] - 2026-11-10

首个开源版本。整理自一个长期自用的 DSH 桌面端插件，把与特定使用者绑定的部分全部剔除或改成可配置项。

### 新增

- **配置系统**：`dsh/config.js` 解析数据目录与模型通道。数据目录优先级 `SALE_DIR` 环境变量 > 配置文件 `dataDir` > 默认 `<home>/dsh-sales-data`；配置文件默认 `<home>/.dsh/sales.config.json`，可用 `DSH_SALES_CONFIG` 覆盖。
- **模型通道三档** `ai.mode`：
  - `session`（默认）：跟随当前 DSH 会话模型，零配置、不需要 API key；
  - `fixed`：钉死一个 provider + model；
  - `local`：走本机模型 provider（如 Ollama），数据不出本机。
- **首次设置向导**：未配置时看板自动进入三步向导（数据目录 → 模型通道含「测试连接」→ 建库进入看板）；标题栏另有「⚙ 设置」面板可随时修改。
- **配置 HTTP 端点**：`GET /sales/config`，`POST /sales/configset`、`POST /sales/setup`、`POST /sales/configtest`；未配置时返回 `{ok:false, code:'UNCONFIGURED'}` 而不是崩掉。
- **本地词法 RAG**：`dsh/rag.js` 只读 `<数据目录>/营销资料库/` 下的 `.md` / `.json`，零依赖、零出网；`features.rag` 可关。
- **字段级脱敏**：`dsh/redact.js` 把姓名 / 公司 / 手机 / 微信昵称换成带标签的占位符再发给模型，返回后回填。
- **出网闸门**：`dsh/egress-guard.js` 拦 8 类「agent 把客户数据传出去」的动作（含搜索带数据、命令行出网动词、UNC 路径、编码混淆、网络库 API 等），fail-closed。
- **自检与初始化脚本**：`scripts/setup.mjs`（幂等建库）、`scripts/doctor.mjs`（只读体检，项数随版本增加）、`scripts/check-no-pii.mjs`（隐私/品牌扫描，CI 也跑）、`scripts/smoke.mjs`（集成冒烟：假 ctx 加载插件，真跑 `/sales` 路由与数据层，不需要 DSH、不调真模型）。除 smoke 外都不 import `dsh/`，可脱离 DSH 独立运行。
- **原有示例语料**：`templates/营销资料库/`（3 篇 markdown + 1 份结构化 JSON），`setup` 时复制进用户数据目录，只补缺不覆盖。
- **合同 `.docx` 生成**：`fflate` 为可选优化（有则用它压缩，体积更小）；运行环境里没有 `fflate` 时走内置零依赖 ZIP 写入（STORE + 自算 CRC32），合同生成照常可用。
- **文档**：安装、配置、数据模型、工具清单、隐私边界、架构说明，以及 README / CONTRIBUTING / 本 CHANGELOG。

### 变更

- 去掉所有与特定使用者绑定的默认值：公司名 / 产品名改由 `profile.company`、`profile.product` 配置；不再内置任何真实客户、真实品牌或私有路径。
- 数据目录不再写死：插件、工具、看板统一从 `config.js` 解析。
- 数据层 `lib/sales-lib.js` 保持 CommonJS；因仓库根是 `"type":"module"`，在 `lib/` 下增加只声明 `"type":"commonjs"` 的 `package.json`（Node 标准约定，勿删）。
- 15 个模型工具的名称与参数保持稳定（`sales_*`），此版本只清理内部实现与文案，不破坏已有调用方式。

### 已知限制

- 脱敏是字段级的，自由文本（沟通内容、备注）里客户自述的姓名/公司不会被遮。
- 出网闸门是正则闸门，拦不住分两步外传、也拦不住脚本自己读表再上传。
- 合同初审判定是规则提示，不构成法律意见。
