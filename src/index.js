#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULT_CONFIG = {
  projectsDir: '~/.claude/projects',
  sessionsDir: '~/.claude/sessions',
  command: 'claude --resume {sessionId}',
  sort: 'time',
  order: null,
};

const SORT_MODES = ['time', 'name', 'path', 'id'];
const COLUMNS = [
  { key: 'name', label: '项目', width: 20 },
  { key: 'path', label: '工作目录', flex: true },
  { key: 'time', label: '更新时间', width: 10 },
  { key: 'id', label: '会话', width: 8 },
];
const LEFT = 1;
const GAP = 2;
const LIST_START = 4;

function parseArgs(argv) {
  const args = { list: false, json: false, help: false, config: null, open: null, sort: null, order: null, plain: false, tui: false, mouse: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--plain') args.plain = true;
    else if (a === '--tui') args.tui = true;
    else if (a === '--mouse') args.mouse = true;
    else if (a === '--no-mouse') args.mouse = false;
    else if (a === '--sort') args.sort = argv[++i] ?? null;
    else if (a.startsWith('--sort=')) args.sort = a.slice('--sort='.length);
    else if (a === '--order') args.order = argv[++i] ?? null;
    else if (a.startsWith('--order=')) args.order = a.slice('--order='.length);
    else if (a === '--open') args.open = argv[++i] ?? null;
    else if (a.startsWith('--open=')) args.open = a.slice('--open='.length);
    else if (a === '--config') args.config = argv[++i] ?? null;
    else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
    else console.warn(`忽略未知参数: ${a}`);
  }
  return args;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function loadConfig(configPath) {
  const file = configPath
    ?? process.env.CLAUDE_SESSION_MANAGER_CONFIG
    ?? path.join(ROOT, 'config.json');
  let user = {};
  try {
    user = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`读取配置文件失败 ${file}: ${err.message}`);
    console.warn(`未找到配置文件 ${file}，使用默认配置`);
  }
  const cfg = { ...DEFAULT_CONFIG, ...user };
  const base = path.dirname(path.resolve(file));
  cfg.projectsDir = path.resolve(base, expandHome(String(cfg.projectsDir)));
  cfg.sessionsDir = path.resolve(base, expandHome(String(cfg.sessionsDir ?? DEFAULT_CONFIG.sessionsDir)));
  if (!String(cfg.command).includes('{sessionId}')) {
    throw new Error('config.command 缺少 {sessionId} 占位符，无法继续会话');
  }
  const sort = normalizeSort(cfg.sort, cfg.order);
  cfg.sort = sort.mode;
  cfg.order = sort.order;
  return cfg;
}

function normalizeSort(mode, order) {
  const m = String(mode ?? 'time').toLowerCase();
  if (!SORT_MODES.includes(m)) throw new Error(`排序方式只能是 ${SORT_MODES.join('/')}，收到 "${mode}"`);
  const o = order == null ? null : String(order).toLowerCase();
  if (o != null && o !== 'asc' && o !== 'desc') throw new Error(`排序方向只能是 asc/desc，收到 "${order}"`);
  return { mode: m, order: o ?? (m === 'time' ? 'desc' : 'asc') };
}

function sortLabel({ mode, order }) {
  const name = { time: '按日期', name: '按名称', path: '按路径', id: '按会话' }[mode];
  return `${name}${order === 'asc' ? '↑' : '↓'}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortSessions(sessions, { mode, order }) {
  const sign = order === 'asc' ? 1 : -1;
  const key = {
    time: (s) => s.mtimeMs,
    name: (s) => s.projectName,
    path: (s) => s.cwd ?? '',
    id: (s) => s.id,
  }[mode];
  return [...sessions].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    let r;
    if (typeof ka === 'number') r = ka - kb;
    else if (mode === 'id') r = ka.localeCompare(kb);
    else r = collator.compare(ka, kb);
    return r * sign || a.id.localeCompare(b.id);
  });
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 只取第一个 cwd 字段，找到即停止，不读会话其余内容
async function readSessionCwd(file) {
  let handle;
  const decoder = new StringDecoder('utf8');
  try {
    handle = await fsp.open(file, 'r');
    const chunkSize = 16 * 1024;
    const buf = Buffer.alloc(chunkSize);
    let offset = 0;
    let leftover = '';
    while (offset < 1024 * 1024) {
      const { bytesRead } = await handle.read(buf, 0, chunkSize, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const lines = (leftover + decoder.write(buf.subarray(0, bytesRead))).split('\n');
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        const rec = safeParse(line);
        if (rec && typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
      }
    }
    return null;
  } finally {
    await handle?.close();
  }
}

// sessions 目录下是 <pid>.json 状态文件，进程还在就视为存活
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isClaudeProcess(name) {
  return typeof name === 'string' && name.toLowerCase().includes('claude');
}

// tasklist 一次拿到所有进程名，用于确认 PID 确实是 claude 进程（防 PID 复用）
async function getProcessNames() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    const map = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]*)","(\d+)"/);
      if (m) map.set(Number(m[2]), m[1].toLowerCase());
    }
    return map;
  } catch {
    return null;
  }
}

async function readAliveSessionIds(sessionsDir) {
  const ids = new Set();
  let files;
  try {
    files = (await fsp.readdir(sessionsDir)).filter((n) => n.endsWith('.json'));
  } catch {
    return ids;
  }
  if (!files.length) return ids;

  const [states, procNames] = await Promise.all([
    Promise.all(files.map(async (n) => {
      try {
        return JSON.parse(await fsp.readFile(path.join(sessionsDir, n), 'utf8'));
      } catch {
        return null; // 单个状态文件损坏就跳过
      }
    })),
    getProcessNames(),
  ]);

  for (const data of states) {
    if (!data || typeof data.pid !== 'number' || !data.sessionId) continue;
    if (!isPidAlive(data.pid)) continue;
    if (procNames && !isClaudeProcess(procNames.get(data.pid))) continue;
    ids.add(String(data.sessionId).toLowerCase());
  }
  return ids;
}

async function applyAliveStatus(sessions, sessionsDir) {
  const ids = await readAliveSessionIds(sessionsDir);
  let changed = false;
  for (const s of sessions) {
    const alive = ids.has(s.id.toLowerCase());
    if (s.alive !== alive) changed = true;
    s.alive = alive;
  }
  return changed;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function scanSessions(projectsDir) {
  let projectDirs;
  try {
    projectDirs = (await fsp.readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch (err) {
    throw new Error(`无法读取 projects 目录 ${projectsDir}: ${err.message}`);
  }

  const sessions = [];
  for (const pd of projectDirs) {
    const dir = path.join(projectsDir, pd.name);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) continue;
        sessions.push({
          id: name.slice(0, -'.jsonl'.length),
          file,
          projectDirName: pd.name,
          mtimeMs: st.mtimeMs,
          cwd: null,
        });
      } catch {
        // 单个会话读不到就跳过
      }
    }
  }

  await mapLimit(sessions, 16, async (s) => {
    s.cwd = await readSessionCwd(s.file);
    s.projectName = s.cwd ? path.basename(s.cwd) : s.projectDirName;
  });

  return sessions;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f)
  );
}

function strWidth(s) {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

function truncate(s, width) {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > width) return w + 1 <= width ? out + '…' : out;
    w += cw;
    out += ch;
  }
  return out;
}

function padEndW(s, width) {
  return s + ' '.repeat(Math.max(0, width - strWidth(s)));
}

let COLORS = true;

function dim(s) {
  return COLORS ? `\x1b[2m${s}\x1b[0m` : s;
}

function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}小时前`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)}天前`;
  return new Date(ms).toISOString().slice(5, 10).replace('-', '/');
}

function filterSessions(sessions, term) {
  const q = String(term ?? '').trim().toLowerCase();
  if (!q) return sessions;
  const parts = q.split(/\s+/);
  return sessions.filter((s) => {
    const hay = `${s.projectName ?? ''} ${s.cwd ?? ''} ${s.id}`.toLowerCase();
    return parts.every((p) => hay.includes(p));
  });
}

function buildCommand(cfg, session, cwd) {
  const values = {
    sessionId: session.id,
    cwd,
    projectDir: path.dirname(session.file),
    projectName: session.projectName ?? '',
  };
  return String(cfg.command).replace(/\{(\w+)\}/g, (m, key) => {
    if (!(key in values)) return m;
    const v = String(values[key]);
    return key === 'sessionId' || key === 'projectName' ? v : `"${v}"`;
  });
}

function launch(cfg, session) {
  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : null;
  if (!cwd) {
    console.warn(`警告: 会话工作目录不存在或未知 (${session.cwd ?? '未记录'})，将在 ${process.cwd()} 启动`);
  }
  const workDir = cwd ?? process.cwd();
  const cmd = buildCommand(cfg, session, workDir);
  console.log(dim(`> ${cmd}  (cwd: ${workDir})`));
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: workDir, stdio: 'inherit', shell: true, env: process.env });
    child.on('error', (err) => {
      console.error(`启动失败: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) console.log(dim(`进程被信号 ${signal} 结束`));
      resolve(code ?? 1);
    });
  });
}

function printPlain(sessions) {
  console.log(['项目', '状态', '工作目录', '更新时间', '会话ID'].join('\t'));
  for (const s of sessions) {
    console.log([s.projectName, s.alive ? '存活' : '未运行', s.cwd ?? '(未知)', new Date(s.mtimeMs).toLocaleString(), s.id].join('\t'));
  }
}

// 识别终端能力：是否交互、是否支持 ANSI、是否能接收鼠标事件
function detectCapabilities(args) {
  const env = process.env;
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const term = String(env.TERM || '');

  // 现代终端：Windows Terminal、VS Code、WezTerm、ConEmu、Git Bash/mintty 等
  const modern = Boolean(env.WT_SESSION)
    || env.TERM_PROGRAM === 'vscode'
    || env.TERM_PROGRAM === 'WezTerm'
    || env.TERM_PROGRAM === 'Apple_Terminal'
    || env.ConEmuANSI === 'ON'
    || Boolean(env.ANSICON)
    || Boolean(term);

  // 老式 Windows 控制台对备用屏/256 色/宽字符支持不一致，默认不用全屏界面
  const ansi = tty && term !== 'dumb' && (process.platform === 'win32' ? modern || args.tui : true);

  const color = ansi && !env.NO_COLOR;
  let mouse = false;
  if (tty) {
    if (process.platform === 'win32') {
      mouse = modern && /xterm|256color|vscode|wezterm/i.test(`${term} ${env.TERM_PROGRAM ?? ''}`)
        || Boolean(env.WT_SESSION)
        || env.ConEmuANSI === 'ON'
        || Boolean(env.ANSICON);
    } else {
      mouse = /xterm|screen|tmux|rxvt|alacritty|kitty|wezterm/i.test(term) || Boolean(env.TERM_PROGRAM);
    }
  }
  if (args.mouse != null) mouse = args.mouse && tty;
  return { tty, ansi, color, mouse };
}

// 普通终端回退：不使用全屏/备用屏/光标定位，只靠回车覆盖底部状态行
// 探测终端是否支持光标定位（DSR 应答）；不支持就只能用整表输出
function probeCursorOps() {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (/\x1b\[\d+;\d+R/.test(buf)) finish(true);
    };
    try {
      process.stdin.setRawMode(true);
    } catch {
      finish(false);
      return;
    }
    process.stdin.resume();
    process.stdin.on('data', onData);
    timer = setTimeout(() => finish(false), 300);
    process.stdout.write('\x1b[6n');
  });
}

async function runPlain(cfg, initialSessions, initialSort) {
  let sessions = initialSessions;
  let sort = initialSort;
  let sorted = sortSessions(sessions, sort);
  let query = '';
  let rows = filterSessions(sorted, query);
  let cursor = 0;
  let top = 0;
  let renderedLines = 0;
  let typed = '';
  let statusLen = 0;
  let ended = false;
  let busy = false;
  let escTimer = null;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const inPlace = await probeCursorOps();
  const VIEW = 10;

  return new Promise((resolve) => {
    const widthOf = () => Math.max(30, process.stdout.columns || 80);
    const write = (s) => process.stdout.write(s);

    function truncateAscii(s, width) {
      let w = 0;
      let out = '';
      for (const ch of s) {
        const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
        if (w + cw > width - 2) return out + '..';
        w += cw;
        out += ch;
      }
      return s;
    }

    function clearStatus() {
      if (statusLen) write('\r' + ' '.repeat(statusLen) + '\r');
      statusLen = 0;
    }

    function ensureVisible() {
      if (!inPlace) return;
      if (cursor < top) top = cursor;
      if (cursor >= top + VIEW) top = cursor - VIEW + 1;
    }

    function viewLines() {
      const width = widthOf() - 1;
      const lines = [truncateAscii(`------ 排序: ${sortLabel(sort)}  ${rows.length ? cursor + 1 : 0}/${rows.length} ------`, width)];
      for (let i = 0; i < VIEW; i++) {
        const idx = top + i;
        if (idx >= rows.length) {
          lines.push('');
          continue;
        }
        const s = rows[idx];
        lines.push(truncateAscii(`${idx === cursor ? '>' : ' '}${String(idx + 1).padStart(3)}. ${s.alive ? '*' : '-'} ${s.projectName}  ${s.cwd ?? '(cwd 未知)'}  ${relTime(s.mtimeMs)}`, width));
      }
      lines.push(truncateAscii(`输入: ${typed || '-'}  Up/Down Enter Tab Esc`, width));
      return lines;
    }

    function redraw() {
      const lines = viewLines();
      if (renderedLines) write(`\x1b[${renderedLines - 1}A`);
      write('\r');
      lines.forEach((line, i) => {
        write('\x1b[2K' + line);
        if (i < lines.length - 1) write('\r\n');
      });
      renderedLines = lines.length;
      statusLen = 0;
    }

    function showStatus() {
      if (inPlace) {
        redraw();
        return;
      }
      const width = widthOf();
      const cur = rows[cursor];
      const label = cur ? `${cursor + 1}. ${cur.projectName}` : '无匹配';
      const typedPart = typed ? `  输入: ${typed}` : '';
      const text = `> ${label} (${rows.length ? cursor + 1 : 0}/${rows.length})${typedPart}  Up/Down Enter Tab Esc`;
      const line = truncateAscii(text, width - 1);
      const pad = ' '.repeat(Math.max(0, statusLen - strWidth(line)));
      write('\r' + line + pad);
      statusLen = Math.max(statusLen, strWidth(line));
    }

    function printList() {
      if (inPlace) {
        renderedLines = 0;
        write('\n');
        redraw();
        return;
      }
      clearStatus();
      write(`------ 排序: ${sortLabel(sort)}  共 ${rows.length} 条 ------\n`);
      if (!rows.length) write('(无匹配会话)\n');
      rows.forEach((s, i) => {
        const line = `${i === cursor ? '>' : ' '}${String(i + 1).padStart(3)}. ${s.alive ? '*' : '-'} ${s.projectName}  ${s.cwd ?? '(cwd 未知)'}  ${relTime(s.mtimeMs)}  ${s.id.slice(0, 8)}`;
        write(truncateAscii(line, widthOf()) + '\n');
      });
      showStatus();
    }

    function resort() {
      sorted = sortSessions(sessions, sort);
      rows = filterSessions(sorted, query);
      cursor = 0;
      top = 0;
      typed = '';
      if (inPlace) redraw();
      else printList();
    }

    function move(delta) {
      if (!rows.length) return;
      cursor = Math.max(0, Math.min(rows.length - 1, cursor + delta));
      ensureVisible();
      showStatus();
    }

    function syncTypedIndex() {
      if (/^\d+$/.test(typed)) {
        const n = Number(typed);
        if (n >= 1 && n <= rows.length) {
          cursor = n - 1;
          ensureVisible();
        }
      }
    }

    function handleKey(key) {
      if (ended || busy) return;
      switch (key) {
        case 'up': move(-1); break;
        case 'down': move(1); break;
        case 'pageup': move(-10); break;
        case 'pagedown': move(10); break;
        case 'home': cursor = 0; ensureVisible(); showStatus(); break;
        case 'end': cursor = Math.max(0, rows.length - 1); ensureVisible(); showStatus(); break;
        case 'enter': {
          if (typed && !/^\d+$/.test(typed)) {
            query = typed;
            typed = '';
            rows = filterSessions(sorted, query);
            cursor = 0;
            top = 0;
            if (inPlace) redraw();
            else printList();
            break;
          }
          const idx = typed ? Number(typed) - 1 : cursor;
          typed = '';
          if (idx >= 0 && idx < rows.length) open(rows[idx]);
          else showStatus();
          break;
        }
        case 'escape':
          if (typed) {
            typed = '';
            showStatus();
          } else {
            quit();
          }
          break;
        case 'tab':
          sort = normalizeSort(SORT_MODES[(SORT_MODES.indexOf(sort.mode) + 1) % SORT_MODES.length]);
          resort();
          break;
        case 'ctrl-r':
          sort = { mode: sort.mode, order: sort.order === 'asc' ? 'desc' : 'asc' };
          resort();
          break;
        case 'clear':
          if (typed) {
            typed = '';
            showStatus();
          }
          break;
        case 'backspace':
          if (typed) {
            typed = [...typed].slice(0, -1).join('');
            syncTypedIndex();
            showStatus();
          }
          break;
        case 'left': case 'right': case 'other': break;
        default:
          if (key.length === 1 && key.codePointAt(0) >= 32) {
            typed += key;
            syncTypedIndex();
            showStatus();
          }
      }
    }

    function quit() {
      if (ended) return;
      ended = true;
      if (escTimer) clearTimeout(escTimer);
      if (inPlace) {
        write('\n');
        renderedLines = 0;
      } else {
        clearStatus();
        write('\n');
      }
      detach();
      resolve();
    }

    function attach() {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
    }

    function detach() {
      process.stdin.removeListener('data', onData);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // 流已关闭时忽略
      }
      process.stdin.pause();
    }

    async function open(session) {
      if (busy || !session) return;
      busy = true;
      detach();
      if (inPlace) {
        write('\n');
        renderedLines = 0;
      } else {
        clearStatus();
        write('\n');
      }
      await launch(cfg, session);
      try {
        sessions = await scanSessions(cfg.projectsDir);
        await applyAliveStatus(sessions, cfg.sessionsDir);
      } catch (err) {
        console.error(err.message ?? err);
      }
      sorted = sortSessions(sessions, sort);
      rows = filterSessions(sorted, query);
      cursor = Math.min(cursor, Math.max(0, rows.length - 1));
      typed = '';
      attach();
      printList();
      busy = false;
    }

    function onData(chunk) {
      pending += decoder.write(chunk);
      pump();
    }

    function pump() {
      while (pending.length) {
        const ch = pending[0];
        if (ch === '\x1b') {
          const arrow = pending.match(/^\x1b\[(A|B|C|D|H|F)/);
          if (arrow) {
            pending = pending.slice(arrow[0].length);
            handleKey({ A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }[arrow[1]]);
            continue;
          }
          const tilde = pending.match(/^\x1b\[(\d+)~/);
          if (tilde) {
            pending = pending.slice(tilde[0].length);
            handleKey({ 5: 'pageup', 6: 'pagedown' }[tilde[1]] ?? 'other');
            continue;
          }
          const csi = pending.match(/^\x1b\[[0-9;?]*[A-Za-z]/);
          if (csi) {
            pending = pending.slice(csi[0].length);
            continue;
          }
          if (pending.length === 1) {
            if (!escTimer) {
              escTimer = setTimeout(() => {
                escTimer = null;
                if (pending === '\x1b') {
                  pending = '';
                  handleKey('escape');
                } else {
                  pump();
                }
              }, 40);
            }
            return;
          }
          pending = pending.slice(1);
          continue;
        }
        if (ch === '\x00' || ch.codePointAt(0) === 0xfffd) {
          if (pending.length < 2) return;
          const code = pending[1];
          pending = pending.slice(2);
          handleKey({
            H: 'up', P: 'down', K: 'left', M: 'right',
            I: 'pageup', Q: 'pagedown', G: 'home', O: 'end', S: 'delete',
          }[code] ?? 'other');
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          pending = pending.slice(1);
          handleKey('enter');
          continue;
        }
        if (ch === '\x7f' || ch === '\b') {
          pending = pending.slice(1);
          handleKey('backspace');
          continue;
        }
        if (ch === '\x03') {
          pending = pending.slice(1);
          quit();
          continue;
        }
        if (ch === '\x15') {
          pending = pending.slice(1);
          handleKey('clear');
          continue;
        }
        if (ch === '\t') {
          pending = pending.slice(1);
          handleKey('tab');
          continue;
        }
        if (ch === '\x12') {
          pending = pending.slice(1);
          handleKey('ctrl-r');
          continue;
        }
        const cp = String.fromCodePoint(pending.codePointAt(0));
        pending = pending.slice(cp.length);
        handleKey(cp);
      }
    }

    printList();
    attach();
  });
}

function printHelp() {
  console.log(`用法: node src/index.js [选项]

选项:
  --list             列出所有会话（纯文本，不进入交互界面）
  --json             以 JSON 输出会话列表
  --open <id前缀>    直接进入指定会话，不显示列表
  --sort <mode>      排序方式: time | name | path | id（默认 time）
  --order <dir>      排序方向: asc | desc（time 默认 desc，其余 asc）
  --plain            强制使用逐行交互模式（不支持全屏的终端）
  --tui              强制使用全屏界面（老式控制台默认会降级）
  --mouse            强制启用鼠标支持
  --no-mouse         强制关闭鼠标支持
  --config <path>    指定配置文件（默认 ./config.json）
  -h, --help         显示帮助

配置项 (config.json):
  projectsDir  Claude projects 目录，支持 ~，默认 ~/.claude/projects
  sessionsDir  运行中会话的状态目录，支持 ~，默认 ~/.claude/sessions
  command      继续会话的命令模板，占位符: {sessionId} {cwd} {projectDir} {projectName}
  sort         排序方式: time | name | path | id
  order        排序方向: asc | desc

交互界面:
  点击表头      按该列排序，再次点击切换正序/倒序（终端支持鼠标时）
  Tab           按 项目 → 路径 → 时间 → 会话 循环切换排序
  Ctrl+R        切换正序/倒序
  ↑↓ / 滚轮     移动 / 滚动
  Enter / 双击  打开所选会话
  Esc          退出

终端适配:
  非 Windows Terminal / VS Code / WezTerm / ConEmu / Git Bash 等现代终端，
  或窗口小于 60x10、加了 --plain 时，自动改用逐行交互模式。
  逐行模式：↑↓ 移动（底部状态行显示当前项）、PgUp/PgDn 翻页、Enter 打开、
  Tab 切换排序、Ctrl+R 正逆序、Esc 退出；也可输入编号或关键字后回车。
  非交互环境（管道）会直接输出列表。加 --tui 可强制全屏界面。

环境变量:
  CLAUDE_SESSION_MANAGER_CONFIG  配置文件的替代路径`);
}

// ---------- 交互界面 ----------

function computeLayout(width) {
  const fixed = COLUMNS.filter((c) => !c.flex).reduce((n, c) => n + c.width, 0);
  const flexWidth = Math.max(10, width - LEFT - fixed - GAP * (COLUMNS.length - 1));
  let x = LEFT;
  const cells = COLUMNS.map((c) => {
    const w = c.flex ? flexWidth : c.width;
    const cell = { key: c.key, label: c.label, width: w, x };
    x += w + GAP;
    return cell;
  });
  return { cells };
}

function sessionCell(s, key) {
  switch (key) {
    case 'name': return s.projectName ?? '';
    case 'path': return s.cwd ?? '(未知)';
    case 'time': return relTime(s.mtimeMs);
    case 'id': return s.id.slice(0, 8);
    default: return '';
  }
}

const RESET_FG = '\x1b[22;39m';
const SELECTED_BG = '\x1b[48;5;240m';

// 只复位前景色/亮度，保留选中行背景色
function fg(code, text) {
  return COLORS ? `\x1b[${code}m${text}${RESET_FG}` : text;
}

function timeColor(ms) {
  const age = Date.now() - ms;
  if (age < 3_600_000) return 32;
  if (age < 86_400_000) return 33;
  return 2;
}

function renderHeader(cells, sort) {
  const parts = cells.map((c) => {
    const active = sort.mode === c.key;
    const marker = active ? (sort.order === 'asc' ? ' ↑' : ' ↓') : '';
    const text = padEndW(truncate(c.label + marker, c.width), c.width);
    if (!COLORS) return text;
    return active ? `\x1b[1m\x1b[36m${text}\x1b[0m` : `\x1b[1m${text}\x1b[0m`;
  });
  return ' '.repeat(LEFT) + parts.join(' '.repeat(GAP));
}

function renderRow(cells, s, selected, width) {
  const parts = cells.map((c) => {
    const raw = sessionCell(s, c.key);
    if (c.key === 'name') {
      const label = truncate(raw, Math.max(1, c.width - 2));
      const pad = ' '.repeat(Math.max(0, c.width - strWidth(label) - 2));
      return fg(36, label) + ' ' + fg(s.alive ? 32 : 31, '●') + pad;
    }
    const shown = truncate(raw, c.width);
    const pad = ' '.repeat(Math.max(0, c.width - strWidth(shown)));
    if (c.key === 'time') return fg(timeColor(s.mtimeMs), shown) + pad;
    return fg(2, shown) + pad;
  });
  const used = LEFT + cells.reduce((n, c) => n + c.width, 0) + GAP * (cells.length - 1);
  const lead = COLORS ? ' '.repeat(LEFT) : (selected ? '>' : ' ');
  const line = lead + parts.join(' '.repeat(GAP)) + ' '.repeat(Math.max(0, width - used));
  return selected && COLORS ? SELECTED_BG + line + '\x1b[0m' : line;
}

function runTui(cfg, initialSessions, initialSort, caps) {
  return new Promise((resolve) => {
    let sessions = initialSessions;
    let sort = initialSort;
    let sorted = sortSessions(sessions, sort);
    let query = '';
    let filtered = sorted;
    let cursor = 0;
    let top = 0;
    let viewH = 1;
    let layout = computeLayout(100);
    let busy = false;
    let ended = false;
    let attached = false;
    let aliveRefreshing = false;
    let aliveTimer = null;
    let lastClick = { index: -1, at: 0 };
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let escTimer = null;

    const enableScreen = () => process.stdout.write('\x1b[?1049h\x1b[?25l' + (caps.mouse ? '\x1b[?1000h\x1b[?1006h' : ''));
    const disableScreen = () => process.stdout.write((caps.mouse ? '\x1b[?1000l\x1b[?1006l' : '') + '\x1b[?25h\x1b[?1049l');

    function attach() {
      attached = true;
      enableScreen();
      process.stdout.on('resize', onResize);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
      render();
    }

    function detach() {
      attached = false;
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // 流已关闭时忽略
      }
      process.stdin.pause();
      disableScreen();
    }

    function quit() {
      if (ended) return;
      ended = true;
      if (escTimer) clearTimeout(escTimer);
      clearInterval(aliveTimer);
      detach();
      resolve();
    }

    async function refreshAlive() {
      if (ended || aliveRefreshing) return;
      aliveRefreshing = true;
      try {
        const changed = await applyAliveStatus(sessions, cfg.sessionsDir);
        if (changed && attached && !ended) render();
      } finally {
        aliveRefreshing = false;
      }
    }

    function onResize() {
      render();
    }

    function onData(chunk) {
      pending += decoder.write(chunk);
      pump();
    }

    function pump() {
      while (pending.length) {
        const ch = pending[0];
        if (ch === '\x1b') {
          const mouse = pending.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (mouse) {
            pending = pending.slice(mouse[0].length);
            onMouse(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4] === 'M');
            continue;
          }
          const arrow = pending.match(/^\x1b\[(A|B|C|D|H|F)/);
          if (arrow) {
            pending = pending.slice(arrow[0].length);
            handleKey({ A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }[arrow[1]]);
            continue;
          }
          const tilde = pending.match(/^\x1b\[(\d+)~/);
          if (tilde) {
            pending = pending.slice(tilde[0].length);
            handleKey({ 5: 'pageup', 6: 'pagedown' }[tilde[1]] ?? 'other');
            continue;
          }
          const csi = pending.match(/^\x1b\[[0-9;?]*[A-Za-z]/);
          if (csi) {
            pending = pending.slice(csi[0].length);
            continue;
          }
          if (pending.length === 1) {
            if (!escTimer) {
              escTimer = setTimeout(() => {
                escTimer = null;
                if (pending === '\x1b') {
                  pending = '';
                  handleKey('escape');
                } else {
                  pump();
                }
              }, 40);
            }
            return;
          }
          pending = pending.slice(1);
          continue;
        }
        // 老式 Windows 控制台的按键是 \x00 / \xe0 + 扫描码，不是 ANSI 序列
        // 0xE0 不是合法 UTF-8，解码后会变成替换字符，这里一并识别
        if (ch === '\x00' || ch === '\xe0' || ch === '�') {
          if (pending.length < 2) return;
          const code = pending[1];
          pending = pending.slice(2);
          handleKey({
            H: 'up', P: 'down', K: 'left', M: 'right',
            I: 'pageup', Q: 'pagedown', G: 'home', O: 'end', S: 'delete',
          }[code] ?? 'other');
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          pending = pending.slice(1);
          handleKey('enter');
          continue;
        }
        if (ch === '\x7f' || ch === '\b') {
          pending = pending.slice(1);
          handleKey('backspace');
          continue;
        }
        if (ch === '\x03') {
          pending = pending.slice(1);
          handleKey('escape');
          continue;
        }
        if (ch === '\x15') {
          pending = pending.slice(1);
          handleKey('clear');
          continue;
        }
        if (ch === '\t') {
          pending = pending.slice(1);
          handleKey('tab');
          continue;
        }
        if (ch === '\x12') {
          pending = pending.slice(1);
          handleKey('ctrl-r');
          continue;
        }
        const cp = String.fromCodePoint(pending.codePointAt(0));
        pending = pending.slice(cp.length);
        handleKey(cp);
      }
    }

    function onMouse(code, x, y, press) {
      if (!press) return;
      if (code === 64) return move(-3);
      if (code === 65) return move(3);
      if ((code & 3) !== 0 || code >= 32) return;
      if (y === 2) {
        for (const c of layout.cells) {
          if (x >= c.x && x < c.x + c.width) {
            clickHeader(c.key);
            return;
          }
        }
        return;
      }
      if (y >= LIST_START && y < LIST_START + viewH) {
        const idx = top + (y - LIST_START);
        if (idx >= filtered.length) return;
        const now = Date.now();
        if (lastClick.index === idx && now - lastClick.at < 450) {
          lastClick = { index: -1, at: 0 };
          open(filtered[idx]);
          return;
        }
        lastClick = { index: idx, at: now };
        cursor = idx;
        render();
      }
    }

    function setSort(next) {
      sort = next;
      sorted = sortSessions(sessions, sort);
      filtered = filterSessions(sorted, query);
      cursor = 0;
      top = 0;
      lastClick = { index: -1, at: 0 };
      render();
    }

    function clickHeader(key) {
      setSort(sort.mode === key
        ? { mode: key, order: sort.order === 'asc' ? 'desc' : 'asc' }
        : normalizeSort(key));
    }

    function move(delta) {
      if (!filtered.length) return;
      cursor = Math.max(0, Math.min(filtered.length - 1, cursor + delta));
      render();
    }

    function handleKey(key) {
      if (ended || busy) return;
      switch (key) {
        case 'up': move(-1); break;
        case 'down': move(1); break;
        case 'pageup': move(-viewH); break;
        case 'pagedown': move(viewH); break;
        case 'home': cursor = 0; render(); break;
        case 'end': cursor = Math.max(0, filtered.length - 1); render(); break;
        case 'enter': open(filtered[cursor]); break;
        case 'escape': quit(); break;
        case 'tab': {
          const next = SORT_MODES[(SORT_MODES.indexOf(sort.mode) + 1) % SORT_MODES.length];
          setSort(normalizeSort(next));
          break;
        }
        case 'ctrl-r':
          setSort({ mode: sort.mode, order: sort.order === 'asc' ? 'desc' : 'asc' });
          break;
        case 'clear':
          if (query) {
            query = '';
            refresh();
          }
          break;
        case 'backspace':
          if (query) {
            query = [...query].slice(0, -1).join('');
            refresh();
          }
          break;
        case 'left': case 'right': case 'other': break;
        default:
          if (key.length === 1 && key.codePointAt(0) >= 32) {
            query += key;
            refresh();
          }
      }
    }

    function refresh() {
      filtered = filterSessions(sorted, query);
      cursor = 0;
      top = 0;
      lastClick = { index: -1, at: 0 };
      render();
    }

    function render() {
      if (ended) return;
      const width = process.stdout.columns || 100;
      const height = Math.max(8, process.stdout.rows || 30);
      if (width < 60) {
        process.stdout.write(`\x1b[H\x1b[J终端宽度 ${width} 列，全屏界面至少需要 60 列。请放大窗口，或按 Esc 退出后使用 --plain。\x1b[K`);
        return;
      }
      layout = computeLayout(width);
      viewH = Math.max(1, height - 5);

      if (cursor < top) top = cursor;
      if (cursor >= top + viewH) top = cursor - viewH + 1;
      top = Math.max(0, Math.min(top, Math.max(0, filtered.length - viewH)));

      const qMax = Math.max(4, width - 20);
      const qShown = strWidth(query) > qMax ? '…' + [...query].slice(-(qMax - 1)).join('') : query;

      const title = truncate(`Claude 会话 (${sessions.length})`, width);
      const meta = `   排序: ${sortLabel(sort)}   ${cfg.projectsDir}`;
      const metaRoom = width - strWidth(title);
      const titleLine = (COLORS ? `\x1b[1m\x1b[36m${title}\x1b[0m` : title)
        + (metaRoom > 6 ? dim(truncate(meta, metaRoom)) : '');

      const searchLine = dim(' 筛选: ') + (COLORS ? `\x1b[1m${truncate(qShown, Math.max(1, width - 14))}\x1b[0m` : truncate(qShown, Math.max(1, width - 14)))
        + (COLORS ? '\x1b[7m \x1b[0m' : '_') + dim(`  (${filtered.length} 条)`);

      const lines = [];
      lines.push(titleLine);
      lines.push(searchLine);
      lines.push(renderHeader(layout.cells, sort));
      lines.push(dim(' ' + '─'.repeat(Math.max(0, width - 1))));
      for (let i = 0; i < viewH; i++) {
        const idx = top + i;
        lines.push(idx < filtered.length ? renderRow(layout.cells, filtered[idx], idx === cursor, width) : '');
      }
      const sortHint = caps.mouse ? '点击表头排序  Tab 切换排序' : 'Tab 切换排序  Ctrl+R 正逆序';
      const hints = ` ↑↓ 移动  Enter 打开  ${sortHint}  Esc 退出  `;
      lines.push(dim(truncate(hints, Math.max(0, width - 20)))
        + (COLORS ? '\x1b[32m●\x1b[0m' : '*') + dim(' 运行中  ')
        + (COLORS ? '\x1b[31m●\x1b[0m' : '-') + dim(' 已结束'));

      process.stdout.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J');
    }

    async function open(session) {
      if (busy || !session) return;
      busy = true;
      detach();
      await launch(cfg, session);
      console.log(dim('正在刷新会话列表…'));
      try {
        sessions = await scanSessions(cfg.projectsDir);
        await applyAliveStatus(sessions, cfg.sessionsDir);
        sorted = sortSessions(sessions, sort);
      } catch (err) {
        console.error(err.message ?? err);
      }
      filtered = filterSessions(sorted, query);
      cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
      busy = false;
      attach();
    }

    aliveTimer = setInterval(refreshAlive, 2000);
    aliveTimer.unref?.();
    attach();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const cfg = await loadConfig(args.config);
  const initialSort = normalizeSort(
    args.sort ?? cfg.sort,
    args.order ?? (args.sort ? undefined : cfg.order),
  );
  const sessions = sortSessions(await scanSessions(cfg.projectsDir), initialSort);
  if (!fs.existsSync(cfg.sessionsDir)) {
    console.warn(`未找到 sessions 目录 ${cfg.sessionsDir}，存活状态将全部显示为已结束`);
  }
  await applyAliveStatus(sessions, cfg.sessionsDir);
  if (!sessions.length) {
    console.log(`未在 ${cfg.projectsDir} 找到任何会话`);
    return;
  }
  if (args.list) {
    printPlain(sessions);
    return;
  }
  if (args.json) {
    console.log(JSON.stringify(sessions.map(({ id, cwd, projectName, mtimeMs, file, alive }) => ({ id, alive: Boolean(alive), cwd, projectName, mtimeMs, file })), null, 2));
    return;
  }
  if (args.open) {
    const q = args.open.toLowerCase();
    const hits = sessions.filter((s) => s.id.toLowerCase().startsWith(q));
    if (!hits.length) throw new Error(`没有以 "${args.open}" 开头的会话`);
    if (hits.length > 1) throw new Error(`前缀 "${args.open}" 匹配到多个会话:\n${hits.map((s) => `  ${s.id}  ${s.projectName}  ${s.cwd ?? ''}`).join('\n')}`);
    process.exitCode = await launch(cfg, hits[0]);
    return;
  }
  const caps = detectCapabilities(args);
  if (!caps.tty) {
    printPlain(sessions);
    console.log('\n当前不是交互终端，已输出列表。恢复会话请用: node src/index.js --open <会话id前缀>');
    return;
  }
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const tooSmall = cols < 60 || rows < 10;
  if (args.plain || !caps.ansi || tooSmall) {
    if (!args.plain) {
      if (!caps.ansi) console.log('当前终端不是 Windows Terminal 等现代终端，已切换到逐行模式（↑↓ 选择，Enter 打开；加 --tui 可强制全屏）。');
      else if (tooSmall) console.log(`终端尺寸 ${cols}x${rows} 太小，已切换到逐行模式（↑↓ 选择，Enter 打开）。`);
    }
    await runPlain(cfg, sessions, initialSort, caps);
    return;
  }
  COLORS = caps.color;
  await runTui(cfg, sessions, initialSort, caps);
}

main().catch((err) => {
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
  console.error(err.message ?? err);
  process.exit(1);
});