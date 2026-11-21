# ai-agent-session-manager

读取 Claude Code 的会话记录，用交互列表选择并 `--resume` 继续。纯 Node，无第三方依赖。npm 包名 `ai-agent-session-manager`，命令别名 `agent-sm`。

## 运行

```powershell
npm start                          # 交互界面
npm run list                       # 纯文本列表
node src/index.js --json           # JSON 输出
node src/index.js --open <id前缀>  # 直接进入某会话
node src/index.js --sort name      # 按项目名排序（time | name | path | id）
node src/index.js --sort time --order asc
```

交互界面操作：

- 项目名后的圆点：绿色 = 会话进程仍在运行，红色 = 已结束（每 2 秒刷新）
- 点击表头：按该列排序，再点一次切换正序/倒序
- ↑↓ / 滚轮：移动、滚动
- Enter / 双击行：打开会话
- 输入关键字：按项目名、路径、会话 id 过滤；Esc 退出

鼠标事件使用 SGR 协议（`?1000` + `?1006`），需要 Windows Terminal 等现代终端；旧版 conhost 不支持时只能用键盘。

## 配置（config.json）

- `projectsDir`：会话目录，支持 `~`，默认 `~/.claude/projects`
- `sessionsDir`：运行中会话的状态目录，支持 `~`，默认 `~/.claude/sessions`
- `command`：恢复命令模板，必须含 `{sessionId}`；另支持 `{cwd}` `{projectDir}` `{projectName}`（路径类占位符会自动加引号）
- `sort`：`time` | `name` | `path` | `id`，默认 `time`
- `order`：`asc` | `desc`；默认 time 为 desc，其余 asc

配置路径优先级：`--config <path>` > 环境变量 `CLAUDE_SESSION_MANAGER_CONFIG` > 项目根目录 `config.json`。

## 实现要点

- 一个 `<uuid>.jsonl` 即一个会话，文件名就是会话 id。
- 存活判断：读 `sessionsDir` 下的 `<pid>.json`，先用 `process.kill(pid, 0)` 确认 PID 存在，再用 `tasklist` 确认该 PID 的进程名包含 `claude`（防止 PID 被复用时误判）；非 Windows 或 `tasklist` 失败时退化为只查 PID。
- 项目文件夹名是有损编码，`:` `\` `_` `-` 和中文都变成 `-`，不能反推真实路径；因此只读 jsonl 的第一个 `cwd` 字段，找到即停止，不读标题和正文。
- 界面是自己用 ANSI 转义序列画的（`src/index.js` 的 `runTui`），没有用 inquirer 等库，因为那些库不支持鼠标点击。
- 会话结束后会重新扫描并回到列表。
- `--list` / `--json` / `--open` 不进入交互界面，可用于脚本或管道。