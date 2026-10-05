#!/usr/bin/env node
/**
 * 一键部署到 Cloudflare Pages
 *
 *   node deploy.mjs          # 首次部署（自动创建项目）
 *   node deploy.mjs --prod   # 部署到生产环境
 *
 * 或直接用 npm：
 *   npm run deploy
 *
 * 前置：只需 Node 18+，无需全局安装任何东西。
 * 首次运行会自动安装 wrangler 并打开浏览器登录 Cloudflare。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const NPX = isWin ? 'npx.cmd' : 'npx';

const PROJECT = 'cf-weather';
const OUT = 'public';

/* ---------- 输出样式 ---------- */
const C = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[36m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const log = {
  step: (n, t) => console.log(`\n${C.b('▸')} ${C.bold(`[${n}/4]`)} ${t}`),
  ok: (t) => console.log(`  ${C.g('✓')} ${t}`),
  warn: (t) => console.log(`  ${C.y('!')} ${t}`),
  err: (t) => console.log(`  ${C.r('✗')} ${t}`),
  info: (t) => console.log(`  ${C.d(t)}`),
};

/* ---------- 前置检查 ---------- */
function preflight() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    log.err(`Node.js 版本过低（当前 ${process.versions.node}），请升级到 18 或更高版本`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, OUT, 'index.html'))) {
    log.err(`未找到 ${OUT}/index.html，请在项目根目录运行本脚本`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'functions', 'api', '[[path]].js'))) {
    log.err('未找到 functions/api/[[path]].js，项目结构不完整');
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'wrangler.toml'))) {
    log.err('未找到 wrangler.toml');
    process.exit(1);
  }
}

/* ---------- 运行命令 ---------- */
function run(args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(NPX, args, {
      cwd: ROOT,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: isWin,
    });
    let out = '';
    if (quiet) {
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (out += d));
    }
    p.on('close', (code) => resolve({ code, out }));
  });
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log('');
  console.log(C.bold('  ⛅  cf-weather  ·  部署到 Cloudflare Pages'));
  console.log(C.d('  ─────────────────────────────────────────────'));

  preflight();

  /* 1. 确保 wrangler 可用 */
  log.step(1, '检查部署工具 wrangler');
  let wranglerReady = false;
  if (existsSync(join(ROOT, 'node_modules', 'wrangler'))) {
    const v = await run(['wrangler', '--version'], { quiet: true });
    if (v.code === 0) {
      log.ok('wrangler 已就绪 ' + C.d(v.out.trim().split('\n').pop()));
      wranglerReady = true;
    }
  }
  if (!wranglerReady) {
    log.info('首次运行，正在安装 wrangler（约 10 秒）…');
    const r = await run(['--yes', 'wrangler@4', '--version'], { quiet: true });
    if (r.code !== 0) {
      // 本地安装作为兜底
      const r2 = await run(['--yes', 'npm', 'install', '--save-dev', 'wrangler@4', '--no-audit', '--no-fund'], { quiet: true });
      if (r2.code !== 0) {
        log.err('wrangler 安装失败，请检查网络');
        log.info(r2.out.slice(-500));
        process.exit(1);
      }
    }
    log.ok('wrangler 安装完成');
  }

  /* 2. 检查登录状态 */
  log.step(2, '检查 Cloudflare 登录状态');
  const who = await run(['wrangler', 'whoami'], { quiet: true });
  const loggedIn = who.code === 0 && !/not authenticated|You are not logged in/i.test(who.out);
  if (loggedIn) {
    const m = /([\w.\-]+@[\w.\-]+)/.exec(who.out);
    log.ok('已登录' + (m ? ' ' + C.d(m[1]) : ''));
  } else {
    log.warn('尚未登录，即将打开浏览器进行授权');
    log.info('（在浏览器中点击 Allow 即可，无需手动输入密钥）');
    const login = await run(['wrangler', 'login']);
    if (login.code !== 0) {
      log.err('登录失败，请重新运行');
      process.exit(1);
    }
    log.ok('登录成功');
  }

  /* 3. 创建项目（已存在则跳过） */
  log.step(3, `准备 Pages 项目 ${C.b(PROJECT)}`);
  const create = await run(
    ['wrangler', 'pages', 'project', 'create', PROJECT, '--production-branch=main'],
    { quiet: true }
  );
  if (create.code === 0) {
    log.ok('项目创建成功');
  } else if (/already exists|already taken|conflict/i.test(create.out)) {
    log.ok('项目已存在，直接使用');
  } else {
    log.warn('项目创建返回非零，继续尝试部署');
    log.info(create.out.trim().split('\n').slice(-3).join('\n'));
  }

  /* 4. 部署 */
  log.step(4, '部署到生产环境');
  const deploy = await run([
    'wrangler', 'pages', 'deploy', OUT,
    '--project-name', PROJECT,
    '--branch', 'main',
    '--commit-dirty=true',
  ]);

  if (deploy.code !== 0) {
    log.err('部署失败');
    process.exit(1);
  }

  console.log('');
  console.log(C.g('  ┌─────────────────────────────────────────────┐'));
  console.log(C.g('  │') + C.bold('   部署成功  🎉                              ') + C.g('│'));
  console.log(C.g('  └─────────────────────────────────────────────┘'));
  console.log('');
  console.log(`  访问地址  ${C.bold(C.b(`https://${PROJECT}.pages.dev`))}`);
  console.log(`  控制台    ${C.d(`https://dash.cloudflare.com/?to=/:account/pages/view/${PROJECT}`)}`);
  console.log('');
  console.log(C.d('  提示：在 Cloudflare 控制台可为该项目绑定自定义域名。'));
  console.log('');
}

main().catch((e) => {
  log.err(String(e.message || e));
  process.exit(1);
});
