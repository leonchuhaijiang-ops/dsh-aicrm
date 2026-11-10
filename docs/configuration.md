# 配置说明

> 全部配置只有一个 JSON 文件。**没有 API key 字段**——模型调用一律经 DSH 宿主，密钥由 DSH 自己管，插件永远看不到。

## 1. 配置文件在哪

| | 路径 |
|---|---|
| 默认 | `<你的 home>/.dsh/sales.config.json` |
| 覆盖 | 环境变量 `DSH_SALES_CONFIG=/绝对路径/sales.config.json` |

Windows 上默认就是 `%USERPROFILE%\.dsh\sales.config.json`（即用户主目录下的 `.dsh` 文件夹）。

配置是**每次调用现读**的：改完保存即生效，不需要重启 DSH。

## 2. 数据目录怎么解析（优先级从高到低）

1. 命令行参数 `--data-dir`（只影响 `scripts/*.mjs`，不写配置）；
2. 环境变量 **`SALE_DIR`**；
3. 配置文件里的 **`dataDir`**；
4. 默认目录 `<你的 home>/dsh-sales-data`。

模型工具和看板走 2→3→4；`setup.mjs` / `doctor.mjs` 额外认 1。四者规则完全一致，不会出现「命令行认一个目录、看板认另一个」。

两个硬约束：

- `dataDir` **必须是绝对路径**。写成相对路径（`./data`、`~/sales`）会被归一成空值，等于没配，回落到默认目录。
- 配置里的 `dataDir` 为空 + 环境变量也没设 = **未配置**。这时看板会拉你走首次设置向导。

## 3. 完整示例

```json
{
  "version": 1,
  "dataDir": "/home/you/sales-data",
  "ai": {
    "mode": "session",
    "provider": "",
    "model": "",
    "reasoningEffort": "",
    "local": {
      "provider": "local",
      "model": "",
      "reasoningEffort": "off"
    }
  },
  "features": {
    "rag": true
  },
  "profile": {
    "company": "示例咨询有限公司",
    "product": "示例 AI 智写"
  }
}
```

## 4. 字段表

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `version` | 数字 | `1` | 配置格式版本。当前固定 1，别手改 |
| `dataDir` | 字符串 | `""` | 数据目录**绝对路径**。空 = 走默认目录 |
| `ai.mode` | 枚举 | `session` | 模型通道三档：`session` / `fixed` / `local` |
| `ai.provider` | 字符串 | `""` | `fixed` 档用：DSH 里已配好的 provider id |
| `ai.model` | 字符串 | `""` | `fixed` 档用：该 provider 下的 model id |
| `ai.reasoningEffort` | 枚举 | `""` | `fixed`/`session` 档的思考档位：`""`（不传）/ `off` / `low` / `medium` / `high` |
| `ai.local.provider` | 字符串 | `local` | `local` 档用：本机 Ollama 之类 provider 的 id |
| `ai.local.model` | 字符串 | `""` | `local` 档用：本机模型名，例如 `qwen2.5:7b` |
| `ai.local.reasoningEffort` | 枚举 | `off` | `local` 档**强制** `off`（本地小模型吃不下思考档位，见第 5 节） |
| `features.rag` | 布尔 | `true` | 是否让模型参考 `营销资料库/` 里的语料 |
| `profile.company` | 字符串 | `""` | 你的公司名，只为让话术称呼/卖点对得上；留空则不加任何语境 |
| `profile.product` | 字符串 | `""` | 你的产品名，同上 |

`profile` 里填的是**你自己的**公司/产品名，用于生成话术时把「我们公司」「我们的产品」落到实处。不填也能用，只是话术更泛。

## 5. 模型通道三档

| 档 | 走哪个模型 | 要配什么 | 适合谁 |
|---|---|---|---|
| **`session`**（默认，推荐） | 当前 DSH 会话正在用的模型 | **什么都不用配** | 所有人。零配置、零额外费用、跟着你在 GUI 里换模型自动换 |
| `fixed` | 你钉死的一个 provider/model | `provider` + `model` | 想固定用某个便宜/快模型跑批量任务 |
| `local` | 本机 Ollama 等本地 provider | `provider`（默认 `local`）+ `model` | 完全不想让数据出本机（能力弱一些，见下） |

### `session`

插件每次调用都现读「当前会话模型」，你在 DSH 里换了模型，插件的 AI 功能跟着换，不会钉死在加载那一刻。这是默认档，也是**最不容易配错**的一档。

### `fixed`

填 DSH 里已经配好的 provider id 和 model id。插件只做选择，不持有密钥、不直连网络——请求照样经宿主发出。

```json
{ "ai": { "mode": "fixed", "provider": "<provider-id>", "model": "<model-id>" } }
```

两个字段必须**同时**有值，否则自动回落到 `session`。

### `local`

接本机模型（最常见是 Ollama）。`provider` 一般是 `local`，`model` 填本地模型名。这一档**强制** `reasoningEffort=off`：本地小模型普遍不支持思考档位，某些 provider 收到档位甚至会整发请求失败。

```json
{ "ai": { "mode": "local", "local": { "provider": "local", "model": "qwen2.5:7b" } } }
```

本地模型窗口通常只有 32K 左右，长台账/长流水会被截断，效果明显弱于云端。想「数据一步不出本机」就选它，但要接受质量下降。

### 关于 `reasoningEffort`

这是**跟 provider 能力绑定**的可选项，不是所有 provider 都吃：

- 留空 `""` = 不传这个参数，最保险；
- 某些 provider 没声明支持档位，收到 `low`/`medium` 会直接抛错，整发请求作废；
- 所以**不确定就别填**。`local` 档不用你填，插件强制关掉。

### 进阶：按 purpose 分工（`dsh/ai-route.json`）

除上面三档「全局选一条通道」，插件还带一张可选的**分工表** `dsh/ai-route.json`：给每个动作（purpose）单独指定走本地还是云端。

**优先级**：设置面板/配置里的 `ai.mode` 更高。选了 `fixed` 或 `local`，所有动作都按那个走，本文件不参与；只有 `ai.mode = "session"`（默认）且本文件 `enabled: true` 时，`routes` 才生效。

**什么时候需要动它**：只有你想「短输出走本机、长输出走云端」这类混合分工时才改。默认 `enabled: false` = 全部动作走当前会话的云端模型，零 API key、开箱即用，**平时不用管这个文件**。

**改动不用重启**：每次调用现读；改坏了（JSON 语法错误）会被当作不可用、全部回落云端，不会崩。

| 字段 | 作用 |
|---|---|
| `enabled` | 总开关。`false`（默认）= 忽略 `routes`，全部走云端 |
| `routes` | purpose → `"local"` / `"cloud"`。六个 purpose：`sales-live`、`sales-clienttip`、`sales-next`、`sales-brief`、`sales-digest`、`contract` |
| `local` | 本地档的 `provider` / `model` / `reasoningEffort`（本机 provider 一般是 `local`，模型名按你本机实际拉取的写） |
| `cloud` | 云端档的 `reasoningEffort` 与 `perPurpose`（按 purpose 覆盖思考档；默认 `off`，长思考会明显变慢） |
| `onLocalFail` | 本地失败后去哪：`"cloud"`（默认，转云端再试一次，结果里标 `fellBack:'cloud'`）/ `"rule"`（不转，由调用方回落规则版） |
| `localCooldownMs` | 本地失败后的熔断冷却毫秒；`0` = 关掉熔断 |

建议只把「几百字以内」的短输出放本地（实时接话、一句话建议），要写上千字的动作（复盘、合同初审）放云端，否则容易撞超时。

> 这个文件在插件目录里（`dsh/ai-route.json`），随包发布。升级插件会整体替换它——改过分工的话，升级后要重改一次；想长期保留可以把配置抄到自己的笔记里。

## 6. RAG：让模型参考你自己的语料

`features.rag = true`（默认）时，插件会从 `<数据目录>/营销资料库/` 里检索片段，塞进提示词：

- 只读这个目录下的 `.md` 和 `.json`（最多 20 个 `.md`）；
- **永远不读 Excel**——客户数据不会因为开 RAG 而被塞进语料；
- **纯本地词法检索，零依赖、零出网**，不建向量库、不下载模型；
- 目录不存在或开关关掉时，功能自动降级为空，不报错。

语料长什么样、怎么加，见 [docs/data-model.md](./data-model.md) 的数据目录结构一节。`templates/营销资料库/` 里有示例，`setup.mjs` 会复制一份到你的数据目录，你可以直接改。

> 不想让模型看到任何额外语料，就把 `rag` 关掉：`{"features":{"rag":false}}`。

## 7. 三种改配置的方式

### 7.1 看板「⚙ 设置」（推荐）

标题栏右侧的齿轮：改数据目录、模型通道（含「测试连接」）、RAG 开关、公司/产品名。保存即写配置文件，当前看板刷新就生效。

### 7.2 HTTP 端点

看板用的就是这套接口，你也可以在脚本里调。路径形态：`POST /sales/<method>`，body 是原始 JSON；或 `GET /sales/<method>?<urlencoded json>`。

| 端点 | 方法 | 作用 |
|---|---|---|
| `/sales/config` | GET | 读当前配置状态：`configured`、`source`（`env`/`config`/`default`）、`dataDir`、`defaultDataDir`、`configFile`、`ai`、`features`、`profile` 等 |
| `/sales/configset` | POST | 打补丁式改配置：`{dataDir?, ai?, features?, profile?}`。`dataDir` 不是绝对路径会返回 `ok:false` + 错误信息 |
| `/sales/setup` | POST | 建目录骨架 + 空表 + 补示例语料（幂等） |
| `/sales/configtest` | POST | 真发一次极短模型请求，验证当前通道能不能用 |
| `/sales/demo` | POST | 示例数据开关：`{"mode":"seed"}` 生成 3 条示例客户、`clean` 清除、`info` 查看（只删它生成的 ID） |

```bash
curl -s http://127.0.0.1:<DSH端口>/sales/config
curl -s -X POST http://127.0.0.1:<DSH端口>/sales/configset \
     -H 'content-type: application/json' \
     -d '{"features":{"rag":false}}'
```

> HTTP 面**只读客户表**：任何写客户数据的意图（例如带 `settle`/`facts` 的请求）会被 403 拒绝。写操作只能通过模型工具、在 DSH 里经过写入口守卫。

未配置时（`dataDir` 为空、目录不存在等）读接口不会崩，而是返回结构化错误 `{ok:false, code:'UNCONFIGURED'}`，看板据此拉起首次设置向导。所以自动化脚本里判断「能不能用」请看 `ok` 与 `code`，不要靠 HTTP 200 就当成功。

### 7.3 直接编辑 JSON

停用 DSH 里正在跑的任务，用文本编辑器改 `<home>/.dsh/sales.config.json`，保存即生效（配置每次现读）。改坏了也不致命：解析失败会被当成「没有配置」，看板会重新拉你走向导。

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 看板一直提示去设置向导 | `dataDir` 为空、是相对路径，或目录不存在 | 用「⚙ 设置」选一个已存在的绝对路径 |
| 「测试连接」失败 | 当前会话没有可用模型 / `fixed` 的 provider+model 不存在 / 本地模型没起 | 先切回 `session` 档验证；`fixed` 要填短 id；`local` 要确认 Ollama 在跑 |
| 改了配置没反应 | 改的是另一台机器 / 另一个 home / `DSH_SALES_CONFIG` 指到别处 | `GET /sales/config` 看 `configFile` 和 `source` 到底读的是哪份 |
| 工具读到的客户是空的 | `SALE_DIR` 环境变量指到了旧目录（它的优先级高于配置文件） | 清掉环境变量，或让两者指向同一个目录 |

---

下一步：[模型工具清单](./tools.md) · [数据模型](./data-model.md) · [隐私与数据边界](./privacy.md)
