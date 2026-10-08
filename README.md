# my-aime.cn 每日自动签到

每天早上在**随机时间**自动登录 <https://my-aime.cn/hellowhen/> 并点击"每日奖励"（签到）按钮，跑在 GitHub Actions 上，不需要自己的电脑开机。

- 零第三方依赖，只用 Node 18+ 自带的 `fetch` / `crypto`
- 一次运行只要几秒钟，不需要装浏览器
- 幂等：今天已经签过就自动跳过，不会重复领
- 失败自动重试 3 次，当天还有十几次定时补签机会

---

## 一、上传到 GitHub（3 分钟）

### 1. 建仓库

在 GitHub 上新建一个仓库，**建议选 Private**（私有仓库也能用 Actions）。

### 2. 上传文件

把这个文件夹里的**全部内容**传上去，注意 `.github` 这个隐藏文件夹也要一起传：

```
.github/workflows/daily-checkin.yml   ← 定时任务配置
checkin.js                            ← 签到脚本
package.json
README.md
.gitignore
```

用命令行最省事（在解压后的文件夹里打开终端）：

```bash
git init
git add -A
git commit -m "每日自动签到"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

也可以在网页上点 **Add file → Upload files**，把文件拖进去（`.github` 文件夹拖拽上传同样有效）。

### 3. ⚠️ 配置账号密码（唯一必做的一步）

密码不要写进代码里，改用 GitHub 的 Secret：

> 仓库页面 → **Settings** → 左侧 **Secrets and variables** → **Actions** → **New repository secret**

添加两条：

| Name | Secret |
| --- | --- |
| `JINALE_USERNAME` | `wudi9331` |
| `JINALE_PASSWORD` | `chopper06` |

### 4. 手动跑一次验证

> 仓库页面 → **Actions** 标签 → 左边选 **每日签到** → 右边 **Run workflow** → 绿色按钮

第一次会提示启用 workflow，点 **I understand my workflows, go ahead and enable them** 即可。

运行完点进去看日志，出现下面这样的内容就是成功了：

```
======== my-aime.cn 每日签到 ========
北京时间：2026-10-09 10:23
今日随机签到时刻：10:23（窗口 08:00 ~ 11:30）
（FORCE 已开启，忽略随机时间判断）
账号：w***1
✅ 登录成功：wudi9331
✅ 签到成功！服务器返回：领取成功
```

之后就什么都不用管了，每天自动完成。

---

## 二、随机时间是怎么实现的

GitHub 的定时任务只支持固定 cron 表达式，没法直接写"随机"。所以：

1. `daily-checkin.yml` 让任务在**北京时间 08:00 ~ 12:50 之间每 10 分钟跑一次**（对应 cron `*/10 0-4 * * *`，cron 用的是 UTC）。
2. `checkin.js` 拿**当天日期**做哈希种子，算出当天上午的一个随机时刻（默认落在 **08:00 ~ 11:30**）。
3. 没到点的那几次运行，打印一行"还没到随机时间"就结束，耗时两三秒。
4. 到点之后的那一次才真正登录 + 签到。

好处：

- 每天的时间都不一样（由日期决定，同一天结果固定，方便排查）；
- 万一某次运行刚好赶上 GitHub 排队延迟或网络抖动，后面十几次运行会自动补上，不会漏签。

想改时间段，编辑 `.github/workflows/daily-checkin.yml` 里的这两行（北京时间）：

```yaml
      WINDOW_START: '08:00'
      WINDOW_END: '11:30'
```

---

## 三、原理说明

网页上点"每日奖励"按钮时，前端实际发了三个请求：

| 接口 | 作用 |
| --- | --- |
| `POST https://api.jinale.com/web/login` | 登录，返回 token |
| `POST https://api.jinale.com/web/dailyBonus` | 查询今天还能不能领 |
| `POST https://api.jinale.com/web/dailyBonus/receive` | 领取奖励（**这就是签到**） |

`checkin.js` 调用的是同样三个接口，所以效果和手动打开网页点按钮完全一样，只是更快更省资源。

其中密码不是明文发送的，站点前端会先算一遍
`HMAC-SHA1(key = 站点固定密钥, msg = 明文密码)` 取十六进制小写再提交，脚本里做了同样的处理。

---

## 四、本地测试（可选）

装了 Node 18 以上，在项目目录里执行：

**Windows PowerShell**

```powershell
$env:JINALE_USERNAME='wudi9331'; $env:JINALE_PASSWORD='chopper06'; $env:FORCE='1'; node checkin.js
```

**macOS / Linux**

```bash
JINALE_USERNAME=wudi9331 JINALE_PASSWORD=chopper06 FORCE=1 node checkin.js
```

其他可选环境变量：

| 变量 | 说明 |
| --- | --- |
| `FORCE=1` | 忽略随机时间，立刻签到（手动触发时用） |
| `DRY_RUN=1` | 只登录和查询，不真的领奖 |
| `WINDOW_START` / `WINDOW_END` | 随机时间段，如 `08:00` / `11:30` |

---

## 五、常见问题

**Q：会不会重复签到 / 领两次？**
不会。脚本先查 `dailyBonus`，返回 `false`（今天已领）就直接退出；就算并发撞上了，服务器也会返回"今日奖励已领取"，脚本按成功处理。

**Q：仓库 60 天没人动，Actions 停了？**
GitHub 对长期无活动的仓库会自动停用定时任务。随便提交一次（改改 README），或者去 Actions 页面点一下 **Enable workflow** 就能恢复。

**Q：私有仓库额度够用吗？**
够。这个任务每次运行按 1 分钟计费，一天 30 次左右 ≈ 900 分钟/月，在免费额度 2000 分钟/月以内。如果想把次数降到 20 次/天，把 cron 改成 `*/15 0-4 * * *`。

**Q：日志里显示"今天已经签到过了"是失败吗？**
不是，是正常结果，说明当天已经领过了。

**Q：提示登录失败？**
先确认 Secret 里的用户名密码没写错、没带多余空格。如果密码改过，记得同步更新 Secret。

**Q：安全提醒**
`JINALE_PASSWORD` 只存在 GitHub Secret 里，不会出现在代码和日志中。但请注意：
- 不要把密码直接写进 `checkin.js` 或 workflow 文件后再推到公开仓库；
- 如果在别处（比如聊天记录里）泄露过密码，建议去站点改一次密码，然后更新 Secret。
