# Diablo — Discord Copilot Agent Bridge 使用說明

從 Discord 操控 **GitHub Copilot**：每個危險動作都要人按下核准、專案之間彼此隔離、
專案知識可以跨 session 共用。

這座橋本身**不做任何推理**。Copilot 是引擎，Diablo 是它外面的調度、安全與互動層。

> 英文版說明與架構細節見 [README.md](./README.md)。

---

## 目錄

1. [前置需求](#1-前置需求)
2. [安裝](#2-安裝)
3. [Discord Bot 設定](#3-discord-bot-設定)
4. [設定檔說明](#4-設定檔說明)
5. [啟動](#5-啟動)
6. [實際使用流程](#6-實際使用流程)
7. [指令一覽](#7-指令一覽)
8. [安全機制（請務必看）](#8-安全機制請務必看)
9. [專案記憶](#9-專案記憶)
10. [疑難排解](#10-疑難排解)
11. [已知限制](#11-已知限制)

---

## 1. 前置需求

| 項目 | 要求 | 檢查方式 |
|---|---|---|
| Node.js | **≥ 22.14**（要用內建的 `node:sqlite`） | `node --version` |
| GitHub Copilot CLI | 已安裝**且已登入** | `copilot --version`；沒登入就跑 `copilot login` |
| Git | 專案要是 Git repo | `git --version` |
| Discord Bot | 選用（不用 Discord 也能跑） | 見第 3 節 |

> **Copilot 一定要先登入。** 沒登入的話 Bridge 會在 ACP 交握階段卡住，
> 然後回報「Copilot did not complete the ACP handshake」。

---

## 2. 安裝

```bash
cd D:\Developing\copilot-workflow\Diablo

npm install

# 複製設定檔範本（config/config.yaml 已被 gitignore，不會被提交）
copy config\config.example.yaml config\config.yaml

# 複製環境變數範本，然後把 Discord token 填進去
copy .env.example .env

npm run build
```

確認一切正常：

```bash
npm run typecheck    # 型別檢查
npm test             # 100 個測試，不需要 Copilot 登入、不燒 AI 額度
```

---

## 3. Discord Bot 設定

這一節最容易卡住，請照順序做。

### 3.1 建立 Bot

1. 前往 <https://discord.com/developers/applications>，點 **New Application**。
2. 左側選 **Bot** → **Add Bot**。
3. 點 **Reset Token** 取得 token，複製下來填進 `.env`：

   ```
   DISCORD_TOKEN=你的token
   ```

   > Token 等同密碼。`.env` 已被 gitignore，**絕對不要**貼到 config.yaml 或提交進 git。

### 3.2 開啟 Message Content Intent（**必做**）

在 **Bot** 頁面往下找到 **Privileged Gateway Intents**，把
**MESSAGE CONTENT INTENT** 打開並儲存。

> 沒開這個的話，Bot 收到的每則訊息內容都是空的，看起來就像完全沒反應。
> 這是最常見的「裝好了但沒用」原因。

### 3.3 邀請 Bot 進伺服器

左側選 **OAuth2** → **URL Generator**：

- **Scopes** 勾選：`bot`、`applications.commands`
- **Bot Permissions** 勾選：
  - View Channels（檢視頻道）
  - Send Messages（傳送訊息）
  - Send Messages in Threads（在討論串中傳送訊息）
  - **Create Public Threads（建立公開討論串）** ← 少了這個沒辦法自動開 thread
  - Embed Links（嵌入連結）
  - Attach Files（附加檔案）
  - Read Message History（讀取訊息紀錄）

把產生的 URL 貼到瀏覽器，選伺服器邀請進去。

### 3.4 取得頻道 ID

1. Discord 設定 → **進階** → 開啟**開發者模式**。
2. 對要用的頻道按右鍵 → **複製頻道 ID**。
3. 把這串數字填到 `config.yaml` 的 `discord.channel_id`。

### 3.5 取得你自己的使用者 ID

對自己的頭像按右鍵 → **複製使用者 ID**，填到 `security.allowed_users`。

> **這一步不能跳過。** 專案開了 `discord_enabled: true` 卻沒設
> `allowed_users` 或 `allowed_roles` 時，Bridge 會**直接拒絕啟動**。
> 這是刻意的：預設放行等於完全沒有安全邊界，比不啟動更糟。

---

## 4. 設定檔說明

編輯 `config/config.yaml`：

```yaml
discord:
  token: ${DISCORD_TOKEN}        # 從環境變數讀，不要直接寫死
  allowed_guilds: []             # 空的 = 不限制伺服器

projects:
  backend:                       # 這個 key 就是 project id
    name: Backend
    path: C:/Projects/Backend    # 專案的 Git 工作目錄（絕對路徑）

    discord_enabled: true
    discord:
      channel_id: "123456789012345678"   # 一個頻道只能對應一個專案

    memory:
      enabled: true

    security:
      require_approval: true     # 保持 true

      # discord_enabled 為 true 時必填其中一項
      allowed_users:
        - "234567890123456789"
      allowed_roles:
        - "Developer"            # 角色名稱或角色 ID 都可以

      allow_always: false        # 建議保持 false，理由見第 8 節

      # Bridge 會直接拒絕、連問都不問的指令（不分大小寫的正規表達式）
      deny_patterns:
        - "rm\\s+-rf\\s+/"
        - "git\\s+push\\s+.*--force(?!-with-lease)"

    copilot:
      model: claude-sonnet-5     # 可省略，用 Copilot 預設
      mode: agent

  # Discord 是選用的。這個專案完全不碰 Discord，只用 CLI 操作
  frontend:
    name: Frontend
    path: C:/Projects/Frontend
    discord_enabled: false
    memory:
      enabled: true
    security:
      require_approval: true

copilot:
  executable: copilot
  startup_timeout_ms: 60000

approval:
  timeout_ms: 1800000            # 30 分鐘。逾時不會核准，只是標記為過期

sessions:
  max_concurrent_per_project: 4  # 每個 session 一個 Copilot 行程，這裡限制記憶體用量
  idle_timeout_ms: 3600000       # 閒置多久後回收行程；0 = 不回收

output:
  show_thoughts: false           # Copilot 的內部思考很吵，預設關閉
  flush_interval_ms: 1200
  attach_threshold_chars: 6000   # 超過這個長度改用 .md 附件送出

storage:
  provider: sqlite
  connection_string: "Data Source=agent.db"
```

### 幾個重點

- **路徑用絕對路徑**，並且要是真的存在的目錄。啟動時只會警告，
  但真正要跑 Copilot 之前會再檢查一次，路徑不對就直接拒絕啟動 Copilot。
- **一個 Discord 頻道只能對應一個專案**。兩個專案填同一個 channel_id 會導致啟動失敗。
- **沒設定的頻道會被完全忽略**，不會有任何回應。

---

## 5. 啟動

```bash
# 用 Discord（有設定 discord_enabled: true 的專案）
npm start

# 只用終端機，不需要 Discord token
npm run cli

# 指定用哪個專案跑 CLI
node dist/main.js --project=backend --cli

# 指定設定檔位置
node dist/main.js --config=C:/path/to/config.yaml
```

啟動成功會看到：

```
INFO [bridge] config loaded from ...
INFO [bridge:projects] loaded 2 project(s); 1 mapped to a Discord channel
INFO [bridge:memory-mcp] memory MCP server listening on http://127.0.0.1:xxxxx/mcp
INFO [discord] Discord connected as YourBot#1234
INFO [bridge] bridge ready
```

> 啟動時會看到 `ExperimentalWarning: SQLite is an experimental feature`。
> 這是 Node 22 對內建 `node:sqlite` 的正常提示，不影響運作。
> 想消掉的話用 `node --no-warnings=ExperimentalWarning dist/main.js`。

停止：按 `Ctrl+C`。Bridge 會關閉所有 Copilot 行程後再退出。

---

## 6. 實際使用流程

### 6.1 開始一個任務

在**已對應的頻道**直接發言：

```
修一下 Redis 連線逾時的問題
```

Bridge 會：

1. 用你的訊息開一條 **thread**（討論串）
2. 建立一個獨立的 **session**
3. 啟動一個專屬的 Copilot 行程（工作目錄鎖定在該專案）
4. 把專案記憶當前言一起送給 Copilot

### 6.2 接著對話

**在同一條 thread 裡**繼續講話，就會延續同一個 session、同一份上下文：

```
你剛剛找到什麼？
```

你**不需要**輸入任何 session ID，Bridge 用 thread ID 自己對應。

### 6.3 核准動作

Copilot 想執行任何動作時，thread 裡會出現：

```
┌───────────────────────────────────────────┐
│ ⚠️ Copilot Action Approval                │
│                                           │
│ 🟡 Needs approval                         │
│                                           │
│ dotnet test                               │
│                                           │
│ Action: execute command                   │
│ Project: Backend                          │
│ Session: 修一下 Redis 連線逾時的問題        │
│                                           │
│ [✅ Approve]  [❌ Reject]                  │
└───────────────────────────────────────────┘
```

危險動作會變成紅色，並且明確寫出**為什麼**危險：

```
┌───────────────────────────────────────────┐
│ 🚨 Copilot Action Approval — destructive  │
│                                           │
│ 🔴 HIGH RISK — destructive                │
│                                           │
│ git push --force origin main              │
│                                           │
│ Why this matters: overwrites remote history│
│                                           │
│ [✅ Approve]  [❌ Reject]                  │
└───────────────────────────────────────────┘
```

- 按 **Approve** → Copilot 繼續
- 按 **Reject** → Copilot 收到拒絕，會改用別的做法或回報失敗
- 按完按鈕會失效，並顯示是誰核准／拒絕的

### 6.4 多任務並行

在同一個頻道開多條 thread，就是多個互相獨立的 session，可以同時跑：

```
#backend-copilot
├── Thread「修 Redis 逾時」      → Session A → Copilot 行程 A
├── Thread「加上身分驗證」        → Session B → Copilot 行程 B
└── Thread「重構 repository」    → Session C → Copilot 行程 C
```

它們的對話、上下文、待核准項目完全隔離，A 不會拿到 B 的東西。
但它們**共用同一份專案記憶**。

---

## 7. 指令一覽

Discord 用斜線指令，CLI 用同名指令。

| 指令 | 作用 |
|---|---|
| `/status` | 顯示專案、session、狀態、目前動作、待核准數量 |
| `/cancel` | 取消這條 thread 的 session，並停止 Copilot |
| `/reset` | 結束目前 session，下一則訊息會開新的。**專案記憶保留** |
| `/project` | 顯示這個頻道對應的專案資訊 |
| `/memory` | 列出專案記憶 |
| `/memory add <事實>` | 手動加一筆記憶 |
| `/memory remove <id>` | 刪掉一筆（id 前 8 碼就夠） |
| `/memory search <關鍵字>` | 搜尋記憶 |
| `/approve` / `/reject` | 跟按鈕一樣，按鈕不方便時用 |

CLI 額外的快捷鍵：

| 按鍵 | 作用 |
|---|---|
| `a` | 核准最新的請求 |
| `r` | 拒絕最新的請求 |
| `m` | 同意存入記憶 |
| `n` | 拒絕存入記憶 |
| `/quit` | 離開 |

---

## 8. 安全機制（請務必看）

這幾條是設計核心，理解了才不會覺得「怎麼一直在問我」。

### 8.1 為什麼每個動作都要問

Bridge 啟動 Copilot 時**絕對不會**加上 `--allow-all-tools`、`--allow-all`
或 `--yolo`。這些參數會讓 Copilot 完全不再發出權限請求，整套安全機制就沒了。
**這一點不可設定。**

在預設的手動權限模式下，Copilot 的每個危險動作都會變成一個
**阻塞式**的權限請求 —— Copilot 在你回答之前，物理上就是無法繼續。

### 8.2 沒有人在線 ≠ 同意

如果 Copilot 要權限的時候 Discord 剛好斷線：

- 請求會被記錄下來
- session 進入 `WaitingForApproval` 狀態
- log 會印出很明顯的錯誤
- **什麼都不會被核准**

Discord 回來之後，用 `/approve` 處理那筆卡住的請求，工作就會繼續。

### 8.3 逾時不等於核准

超過 `approval.timeout_ms`（預設 30 分鐘）後，請求標記為 `Expired`，
但 **Copilot 仍然被卡住**，按鈕**仍然有效** —— 你晚點才按也算。
只有 `/cancel` 會真正解開它。

### 8.4 危險等級是 Bridge 自己判斷的

ACP 送過來的 `git status` 和 `git push --force` 長得一模一樣。
所以 Bridge 自己做分級（`src/approval/risk.ts`），高風險的會標紅並說明原因：

- `git reset --hard`、`git clean -fd`、`git push --force`、`git branch -D`
- `rm -rf`、`Remove-Item -Recurse`
- `DROP TABLE`、沒有 WHERE 的 `DELETE FROM`
- `curl ... | sh`
- `.env` / `.pem` / `.key` 等憑證檔案
- `shutdown`、`chmod 777`、`terraform destroy`

`security.deny_patterns` 命中的指令會**直接拒絕，連問都不問**。

### 8.5 為什麼不建議開 `allow_always`

ACP 有「永遠允許」這個選項，但選了之後 Copilot 就**不會再為同類動作發出請求**。
那等於開了一條 Bridge 看不到、也記不到審計紀錄的自動核准通道。
所以預設不顯示這顆按鈕，要開得在專案設定裡明確打開。

### 8.6 只有授權的人能核准

按鈕**存在不代表你能按**。每一則訊息、每一次按鈕、每一個斜線指令
都會重新檢查 `allowed_users` / `allowed_roles`。
而且一筆核准只能在它所屬的專案與 session 範圍內被解決。

---

## 9. 專案記憶

記憶屬於**專案**，不屬於 thread。存在 SQLite 裡，會在每個 Copilot session
的第一個 prompt 之前當前言注入。

**Bridge 不會寫進你的 repo。** 偷偷改動不屬於自己的工作樹裡的 `AGENTS.md`
不是使用者要的行為。

適合放進記憶的（長期不變的知識）：

```
- 這個專案用 .NET 8
- 資料庫存取用 Dapper
- 測試用 xUnit
- 不要修改產生出來的檔案
- Redis 連線由 RedisConnectionFactory 管理
```

不適合的（屬於當次任務的暫時資訊）：

```
- 目前正在修的 bug
- 這次的測試結果
- 目前的除錯假設
```

### Copilot 主動要求記住

Copilot 本身沒有「我想記住某件事」這種輸出。所以 Bridge 給了它一個工具：
一個跑在 localhost 的 MCP server，提供 `remember_project_fact`。
Copilot 呼叫它的時候，你會看到：

```
┌────────────────────────────────────────┐
│ 🧠 Project Memory Request              │
│                                        │
│ Copilot wants to remember:             │
│                                        │
│ > 這個專案用 Dapper 存取資料庫            │
│                                        │
│ [✅ Remember]  [❌ Discard]             │
└────────────────────────────────────────┘
```

安全性關鍵：那組 bearer token **就是 session 身分**。
在專案 A 產生的 token 只能寫入專案 A 的記憶 —— 跨專案隔離是由傳輸層保證的，
不是靠某個可能忘記寫的檢查。

---

## 10. 疑難排解

### Bot 在線但完全不回應

依序檢查：

1. **Message Content Intent 有開嗎？** 見 3.2。這是最常見原因。
2. **頻道 ID 對嗎？** `/project` 沒反應就表示這個頻道沒對應到任何專案。
3. **你有被授權嗎？** 沒授權會收到 🚫 的回覆。
4. 看 log 有沒有 `loaded N project(s); M mapped to a Discord channel`，M 是 0 就是沒對應到。

### 啟動就失敗：`Invalid configuration`

錯誤訊息會把所有問題一次列出來。常見的：

| 訊息 | 原因 |
|---|---|
| `neither security.allowed_users nor security.allowed_roles is configured` | 開了 Discord 但沒設誰能核准，見 3.5 |
| `discord_enabled is true but discord.channel_id is missing` | 少填頻道 ID |
| `discord.token is empty — set DISCORD_TOKEN` | `.env` 沒填或沒被讀到 |
| `mapped by more than one project` | 兩個專案共用同一個頻道 |
| `path is not a directory` | 專案路徑寫錯 |

### `Copilot did not complete the ACP handshake within 60000ms`

Copilot 沒登入。跑 `copilot login`。
若網路慢，可以調高 `copilot.startup_timeout_ms`。

### `project ... path does not exist`

專案路徑不存在或磁碟沒掛上。Bridge 在啟動 Copilot 前會再檢查一次，
不會讓 Copilot 跑在錯誤的目錄裡。

### `already has N Copilot session(s) running, which is its configured maximum`

同時開的 thread 太多。用 `/cancel` 結束不用的，或調高
`sessions.max_concurrent_per_project`（注意每個 session 都是一個獨立行程，會吃記憶體）。

### 「我不想每次都按核准」

**不建議**，但如果是丟棄式的沙箱環境，可以在該專案設
`security.require_approval: false`。啟動時會印出很明顯的警告。
**不要對真正的專案這樣做。**

### 無法自動建立 thread

Bot 缺少 **Create Public Threads** 權限。補上權限，
或你自己先開好 thread，然後在裡面對話。

---

## 11. 已知限制

1. **Session 在兩次任務之間維持 `Running`。** 規格 §11 說 `Completed` 是終態，
   §13 又要求同一條 thread 的後續訊息要進到同一個 session。兩者不能同時成立，
   所以「任務完成」是用完成通知表示，session 本身要等 `/reset` 才變 `Completed`。

2. **記憶前言是每個 Copilot session 注入一次**，不是每次對話都注入。
   後續對話依賴 Copilot 自己還記著。如果在 Copilot 裡執行 `/compact`
   可能會把它擠掉，Bridge 目前不會偵測這件事。

3. **記憶請求沒人回答時，會當成「不儲存」**，而不是一直卡住。
   不存一筆筆記是安全的，把 Copilot 卡在任務中間不是。
   動作核准則相反 —— 它會一直卡住。這個不對稱是刻意的。

4. **每個 session 一個 Copilot 行程**，會吃記憶體，所以有併發上限與閒置回收。

5. **Phase 6（Git 模組）沒有實作成獨立模組。** §27 的大部分已經免費涵蓋了：
   Copilot 自己執行的 git 指令會變成權限請求，危險的會被分級提升。
   真正缺的是由 Bridge 主動建立 PR 與管理分支。Phase 7 完全未動。

6. **重啟後不保留執行中的工作。** Copilot 行程是 Bridge 的子行程，
   所以啟動時仍標記為執行中的 session 會被標成 `Failed`，
   而不是假裝它還活著。

7. **`node:sqlite` 在 Node 22 仍是實驗性功能**，啟動會印警告。

---

## 附錄：確認整套流程能跑

不需要 Copilot 登入、不燒額度：

```bash
npm test
```

對**真的** Copilot 做一次端到端測試（會花 AI 額度）：

```bash
npm run build
node scripts/smoke-copilot.mjs .
```

會看到權限請求被攔下來的完整過程：

```
=== PERMISSION REQUESTED (this is the approval interception point) ===
  title:   Check Node.js version
  kind:    execute
  command: node --version
  options: allow_once(allow_once), allow_always(allow_always), reject_once(reject_once)
  -> auto-approving with allow_once
--- stopReason: end_turn; permission requests seen: 1 ---
```
