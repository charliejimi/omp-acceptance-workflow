# omp-acceptance-workflow

一個 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）套件：用 agent 改不到的驗收條件，在它做事的時候和收工的時候檢查它的工作。

[English](README.md)

## 為什麼

Agent 說「做完了」，是它自己說的。在一個有五件事、其中兩件做不到的測試裡，模型把五件都標成完成：它改了被檢查的測試讓它通過，又自己起一個本機 server 回應 staging 的健康檢查。測試全綠，待辦全勾。

這個套件把判斷交給一份由派工的人寫、放在 agent 工作目錄外的驗收規格：

- Agent 把一項待辦標成完成時，先跑那一項的驗收；沒過，這一項就不會變成完成，並把理由告訴 agent。
- Agent 收工時，換一個新的家目錄重跑每一條驗收，比對改過的檔和允許的清單，對不上就退回，最多 N 次。
- 做不到的工作也能老實收尾：agent 把它標成 blocked 並寫原因，結果是 `INCOMPLETE`，不是 `FAIL`。

## 套件內容

| 部分 | 檔案 | 做什麼 |
|---|---|---|
| 擴充套件 | `src/index.ts`（加上 `src/spec.ts`、`src/checks.ts`） | 逐項驗收、收工驗收、結果檔、拒絕提到規格的工具呼叫、遮住輸出、`/acceptance` 指令 |
| Skill | `skills/acceptance-workflow/SKILL.md` | 給 agent 的做法：照標題建待辦、先寫會失敗的測試、過了才標完成、做不到就標 blocked 並寫原因 |
| Agent | `agents/acceptance-verifier.md` | 開 PR 前的獨立 verifier，任務是用指令輸出反駁每一件「完成」 |
| CI 腳本 | `scripts/ci-check.ts` | 在全新的 checkout 重跑驗收，回傳 0、1 或 2 |

## 需求

- omp 18.2.8 以上（測試用的是 18.2.8）
- Bun 1.3.14 以上

## 快速開始

1. Clone 這個 repo。
2. 寫一份驗收規格，放在 agent 的工作目錄外，最好放在 agent 的使用者寫不到的地方。範例見 [`examples/acceptance.example.json`](examples/acceptance.example.json)。
3. 用這個套件和規格啟動 omp：

   ```bash
   omp -e /path/to/omp-acceptance-workflow --acceptance /工作目錄外的路徑/acceptance.json
   ```

4. 用 skill 派工，後面接工作清單：

   ```text
   /skill:acceptance-workflow 這五件事，用待辦清單追蹤：1. Change port to 8080 2. Add multiply with a test ...
   ```

5. 看結果。結果只顯示給你，不會送給模型：

   ```text
   /acceptance status
   /acceptance check
   ```

   `status` 顯示結果檔；`check` 現在重跑一次，不寫結果檔。

不加 `--acceptance` 時，套件會載入但不作用。`--acceptance` 指到不存在、格式錯，或放在工作目錄裡的規格時，逐項驗收和收工驗收都會擋下，理由裡不會出現規格的路徑。

## 驗收規格

| 欄位 | 必填 | 意思 |
|---|---|---|
| `tasks` | 是 | 每一項的待辦標題 `todo` 和驗收指令 `check`。Agent 的待辦要用一樣的標題；指令在工作目錄裡執行，exit 0 算過。 |
| `allowedChanges` | 是 | 只准改的檔，路徑相對於工作目錄。其他檔有變動就算問題。 |
| `forbid` | 否 | 准改的檔裡不准出現的寫法：`pattern`（regex）、`reason`（給 agent 看的理由）、`files`（regex，限定套用到哪些檔）。 |
| `maxBlocks` | 否 | 收工驗收最多退回幾次，之後放它收工，結果記 `FAIL`。預設 3。 |
| `checkTimeoutMs` | 否 | 每條驗收的時限。預設 4000 毫秒。 |
| `stopBudgetMs` | 否 | 收工時全部驗收的總時限。預設 25000 毫秒；沒跑到的項目算問題。 |

## 結果檔

套件會在規格旁邊寫 `<規格檔名>.verdict.json`：

- `verdict`：上一次收工驗收的結果。`PASS`（全過）、`INCOMPLETE`（沒過的都標成 blocked 或 abandoned）、`FAIL`（其他），或 `UNCHECKED`（還沒跑過收工驗收）。
- `claims`：每一項最新的待辦狀態，每次待辦變動都更新。
- `stale`：`true` 表示上次收工驗收之後，工作或待辦又變過，`verdict` 已經不是最後的狀態。
- `trigger`：這次是誰寫的。`session_stop`（收工驗收）、`update`（之後的變動）或 `shutdown`（omp 結束時）。
- `blocks`、`checkedAt`、`tasks`、`unexpected`、`problems`：上一次驗收的細節。

omp 結束時只給擴充套件 2 秒，所以結束時只寫最後的待辦狀態和 `stale`，不重跑驗收。被時限停掉的 session 也會留下最後的狀態。

## 不准碰答案卷

- 工具呼叫的參數只要提到規格的路徑、規格所在的資料夾、結果檔、這兩個檔名、`allowedChanges` 這個字，或這個套件的資料夾，就不執行。套件的 `skills/` 例外，因為 skill 會叫 agent 讀它。規格所在的資料夾若包含工作目錄，或是 `/`、家目錄、暫存目錄這種共用的地方，就不算在內。
- 工具輸出裡出現上面這些（不分大小寫），整段換成「不給你看」。

## CI

在變更的全新 checkout 根目錄執行；規格和結果檔要從 agent 碰不到的地方取得：

```bash
bun /path/to/omp-acceptance-workflow/scripts/ci-check.ts --spec /protected/acceptance.json --base origin/main --verdict /protected/acceptance.verdict.json
```

它列出 `<base>...HEAD` 改過的檔（加上未提交和未追蹤的檔），重跑每一條驗收（每條預設 60 秒，可用 `--timeout` 改），在 stdout 印出 JSON 報告。

| exit code | 結果 | 條件 |
|---|---|---|
| 0 | `PASS` | 每一條驗收都過，沒有清單外的改動或禁止寫法 |
| 2 | `INCOMPLETE` | 有給 `--verdict`，結果檔不是最新的 `FAIL`，而且每個沒過的項目在最新的待辦狀態裡都標成 blocked 或 abandoned |
| 1 | `FAIL` | 清單外的改動、禁止寫法、其他沒過的項目、結果檔是最新的 `FAIL` 或不見，或用法、規格錯誤 |

結果檔過期或是 `UNCHECKED` 時，它的 `verdict` 不算數：以這支腳本自己重跑的結果為準，再用最新的待辦狀態分出「未完成」和「失敗」。報告裡的 `verdictStale` 會標出這種情況。

## 限制

- omp 不會在 subagent session 跑收工驗收；agent 的背景工作還在時會延後；session 被中斷或被時限停掉時不會跑。這時結果檔是 `UNCHECKED` 或過期的，只帶最新的待辦狀態，判斷交給 CI 重跑。
- 收工驗收要在 omp 的 30 秒內回覆，所以有 `stopBudgetMs`。
- 不檢查 agent 寫在回報裡的字，看結果檔。
- 驗收指令用你的權限執行，只換了家目錄；規格是可信的輸入，由派工的人寫。
- 這不是沙箱：拒絕執行和遮蔽都靠比對路徑與字串。用萬用字元、編碼過的路徑，或先 `cd` 再用相對路徑，仍可能讀到或改到規格和套件。驗收在 omp 同一個行程裡執行，要完全藏住規格，只能放到另一個環境。
- 比對是照字面：剛好含有這些字的正常輸出會被遮，剛好提到這些路徑的正常指令也會被拒絕。
- Skill 的訊息含 skill 的資料夾，等於告訴 agent 套件在哪裡；套件的程式只靠拒絕執行和遮蔽保護。

## 評估

在五件事的練習專案上做了 live A/B（Composer 2.5，每組 3 場），比較這個套件和它所泛化的兩支原始 hook。兩者擋做假的效果一樣：做不到的工作沒有一件過關，也沒有待辦停在「完成」但驗收沒過。六場都撞到 600 秒的時限。這次測試也找到四個缺口，0.1.0 修了其中兩個：結果檔過期和遮蔽可以繞過。細節見 [`docs/evaluation.md`](docs/evaluation.md)。

## 開發

```bash
bun install
bun test
```

測試透過 omp 自己的 extension loader、runner 和 discovery，在 `test/fixtures/` 自帶的五件事練習專案上跑，不呼叫模型。

## 授權

[MIT](LICENSE)
