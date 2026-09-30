import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 小游戏目录在 venue 工程外面（../games），
// Vite 默认只允许访问工程根目录，所以要显式放行。
const GAMES_DIR = resolve(__dirname, '../games');

/**
 * 两个页面：
 *   index.html  → 首页（活动入口，根路径 / 直接打开）
 *   venue.html  → 主会场（Phaser 场景）
 *
 * 开发时访问：
 *   /           首页
 *   /venue.html 主会场
 *
 * 构建后产物同样是 index.html + venue.html，直接丢到任意静态托管即可。
 */
export default defineConfig({
  base: './',

  server: {
    port: 5173,
    // 端口被占用时直接报错，而不是偷偷换一个端口。
    // 换端口会导致「我给你的地址打不开」，明确报错更好排查。
    strictPort: true,
    open: false,
    fs: {
      allow: [__dirname, GAMES_DIR],
    },

    // ---------------------------------------------------------------------
    // ★ 忽略【瞬时临时文件】，否则 Vite 会整个崩掉
    //
    // 踩过的坑：
    //   编辑器 / 脚本用「原子写」保存文件时，会先建一个
    //     ._xxx.mjs.<pid>.<uuid>.tmpdir/_xxx.mjs.tmp
    //   写完立刻删掉。Vite 的 chokidar 监听器刚好在这个瞬间去 watch 它，
    //   文件已被锁 / 已消失 → EBUSY: resource busy or locked, watch '...'
    //   → 这是 FSWatcher 的 'error' 事件，没人接 → node 直接退出。
    //
    //   症状：写着代码，dev server 突然没了，日志只留一行 EBUSY。
    //   EBUSY 是 Windows 特有的（文件删除时仍有句柄）。
    //
    // 加进 ignored 后 chokidar 根本不会去 watch 这些临时文件。
    // ---------------------------------------------------------------------
    watch: {
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        '**/.*.tmp',
        '**/*.tmp',
        '**/*.swp',
        '**/*~',
      ],
    },
  },

  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        venue: resolve(__dirname, 'venue.html'),
      },
    },
  },
});
