import react from "@vitejs/plugin-react";
/* ⚠️ 2026-10-17：移除了 `vite-plugin-glsl` 的 import 与注册。
 *   它把 `.glsl/.vert/.frag` 文件当字符串 import，而全仓**一个 .glsl 都没有**
 *   （着色器全部写在 TS 里用 TSL 组装，例如 `src/core/shaders/worldHeight.ts`）。
 *   留着等于每次构建多跑一个不产生任何输出的 transform，且多一个必须维护的依赖。
 *   哪天真要加独立的 .glsl 文件，把这两行加回来即可。 */
import { resolve, join, basename } from "path";
import { createReadStream, existsSync, readdirSync } from "fs";
import basicSsl from "@vitejs/plugin-basic-ssl";

/* ────────────────────────────────────────────────────────────────────────────
 * `.wasm` 的 MIME（本地 dev 专用的小补丁）
 *
 * 背景：`@yohawing/three-mmd-loader` 的 MMD 动画核心是一个 wasm 模块，
 * wasm-bindgen 生成的代码里写的是
 *     module_or_path = new URL("mmd_anim_wasm_bg.wasm", import.meta.url);
 * vite 的依赖预打包（dep optimizer）**不会重写这行**。于是浏览器实际去请求
 *     https://.../node_modules/.vite/deps/mmd_anim_wasm_bg.wasm
 * 而 `node_modules/.vite/deps/` 里只有那个 .js 壳、**没有 .wasm 文件** ⇒
 * 请求落到 SPA 回退，返回 index.html（`Content-Type: text/html`）⇒
 *     WebAssembly.instantiateStreaming failed ... Incorrect response MIME type.
 *     Expected 'application/wasm'.
 * ⇒ 回退到 `WebAssembly.instantiate` 的慢路径（实测首屏多约 1650 ms）。
 *
 * 这个插件做的事：任何以 `.wasm` 结尾的请求，**先按项目根目录找真文件**；
 * 找不到就按文件名在 `node_modules` 里找一遍（带缓存），找到就直接用
 * `application/wasm` 流出去。找不到才交给 vite 后面的中间件。
 *
 * ⚠️ 只在 dev 生效。生产构建时 vite 会正常处理资源，不需要这段。
 * ──────────────────────────────────────────────────────────────────────────── */
function wasmMime() {
  let index = null; // 文件名 → 绝对路径，第一次请求时才建，之后复用

  const indexWasm = (root) => {
    if (index) return index;
    index = new Map();
    const walk = (dir, depth) => {
      // ⚠️ 深度要给够：pnpm 的目录是
      //   node_modules/.pnpm/@yohawing+three-mmd-loader@0.8.4_three@0.182.0/
      //     node_modules/@yohawing/three-mmd-loader/dist/parser/wasm/generated/xxx.wasm
      // 从 `node_modules` 数下去有 8 层。第一版写了 6，结果什么都没索引到，
      // 请求照样回退成 index.html —— 看起来「插件没生效」，其实是目录没走到。
      if (depth > 12) return;
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".wasm") && !index.has(e.name)) {
          index.set(e.name, p);
        }
      }
    };
    walk(join(root, "node_modules"), 0);
    return index;
  };

  const handler = (root) => (req, res, next) => {
    const url = (req.url || "").split("?")[0];
    if (!url.toLowerCase().endsWith(".wasm")) return next();

    const name = basename(decodeURIComponent(url));
    // ★ 查找顺序必须是「项目根 → public/ → node_modules」。
    //   踩过的坑：URL 形如 `/mmd/mmd_bullet.wasm` 时 `join(root, url)` 得到
    //   `<项目根>\mmd\mmd_bullet.wasm` —— **不存在**（真文件在 `public/mmd/`），
    //   于是直接掉到 node_modules 索引、供出**未经修改的原始 wasm**。
    //   症状极具迷惑性：`public/mmd/mmd_bullet.js` 是从 public 供的（所以改了 JS 立刻生效），
    //   而 wasm 却是 node_modules 里的原版 ⇒ 「明明改了 wasm 的内存上限，
    //   浏览器却一直报 Maximum memory size exceeded」。所以 public 必须显式查一次。
    let file = join(root, decodeURIComponent(url));
    if (!existsSync(file)) {
      const pub = join(root, "public", decodeURIComponent(url));
      if (existsSync(pub)) file = pub;
    }
    if (!existsSync(file)) file = indexWasm(root).get(name) || null;
    if (!file) return next();

    res.setHeader("Content-Type", "application/wasm");
    res.setHeader("Cache-Control", "no-cache");
    res.statusCode = 200;
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  };

  return {
    name: "dsh-wasm-mime",
    configureServer(server) {
      server.middlewares.use(handler(server.config.root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(server.config.root));
    },
  };
}

export default {
  /* ★ 2026-10-17 由 `"./"` 改成 `"/"`。
   *
   *   原来写成相对路径是为了「双击 dist/index.html 也能开」，但源码里有**约 100 处
   *   `/` 开头的绝对资源路径**（`/models/...`、`/venue/...`、`/textures/...`：
   *   `src/core/forest.ts` 29 处、`src/components/venue/VenuePropsReal.tsx` 14 处、
   *   `src/app/App.tsx` 7 处、`src/components/world/RegionProps.tsx` 7 处 …），
   *   这些**不会**跟着 `base` 走。于是 `base: "./"` 只在「部署在域名根」时碰巧正确，
   *   一旦放到子路径（例如 `https://host/birthday/`）就变成：
   *     index.html 去 `/birthday/assets/xxx.js`（因为 base=./ ⇒ 相对）
   *     而 JS 里去 `/models/xxx.glb`（绝对 ⇒ 跑到域名根）⇒ **全站 404**。
   *   部署形态既定是「一个站点/一个子域」，所以显式写 `/`，语义与源码一致；
   *   `dist/index.html` 必须经 http 服务打开（WebGPU 需要安全上下文，file:// 本来也不行）。 */
  base: "/",
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'packages/three-core/src')
    },
  },
  plugins: [react(), basicSsl(), wasmMime()],
  server: {
    host: true,
    https: true,
    /* ★ 2026-10-17：固定端口。原来的配置没写 port ⇒ vite 用默认 5173，
     *   而 `src/components/DevStamp.tsx:71` 的状态角标上硬写着「@5181」
     *   （那是 2026-09 时的端口，后来没人改过），于是"角标显示 5181、实际跑在 5173"。
     *   截图脚本、交接文档、以及 `_tools/` 里的几十个探针都按 5181 写死了 URL，
     *   现在把它**钉死**在一个端口上：`strictPort` 让端口被占时直接报错而不是
     *   悄悄换成 5174 —— 静默换端口正是这类脚本集体失准的根源。 */
    port: 5181,
    strictPort: true,
    // DSH 的编辑工具是「原子写」：会在源文件旁边建 .<name>.<pid>.<uuid>.tmpdir/ 再改名过去。
    // chokidar 去 watch 那个临时文件时 Windows 上会 EBUSY，直接把 vite 进程打崩（exit 1）。
    // 忽略掉这些临时产物，就能一边开着 dev server 一边改代码。
    // ★ `public/**` 也要忽略。往 `public/columbina/` 里拷 少女.pmx（4.4 MB）时
    //   chokidar 去 watch 这个刚落地的大文件同样 EBUSY，vite 又崩了一次：
    //   `Error: EBUSY: resource busy or locked, watch '...\public\columbina\少女.pmx'`。
    //   public 下的东西是静态资源，本来就不需要 HMR，忽略掉没有副作用。
    watch: { ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/public/**'] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    /* ★ 2026-10-17：`sourcemap: true` → 缺省**不产出**（`SOURCE_MAP=1` 时才产 `hidden` 版）。
     *
     *   原来无条件产出，结果是 dist 里躺着一个 **15.7 MB 的 index-*.js.map**，
     *   而且 `//# sourceMappingURL=` 会把它**暴露给浏览器**：任何人打开 DevTools
     *   就能读到全部源码（含 `_tools/` 里那些带内部 URL、探针脚本注释的东西）。
     *   对一个要发出去的生日会站点，这既没必要也不合适。
     *   需要排查线上问题时 `SOURCE_MAP=1 pnpm build`，`hidden` 只写文件、不加
     *   `sourceMappingURL` 注释 ⇒ 不会自动被下载，手工上传给错误收集器仍然可用。 */
    sourcemap: process.env.SOURCE_MAP ? "hidden" : false,
    /**
     * ★ 2026-10-17 新增：拆包。
     *
     * 原来没有 `manualChunks` ⇒ 全部 1800 个模块打成一坨 **4.17 MB（gzip 1.16 MB）**
     * 的 index-*.js。哪怕只改一行文案，用户的浏览器也得把 three.js 重新下一遍。
     * 按「变更频率」拆开之后：
     *   · `three` / `r3f` / `react` 这几个包体大、几乎不变 ⇒ 能长期吃浏览器缓存；
     *   · 业务代码（本项目 src/）单独一 chunk，改一次只重下这一份。
     *
     * ⚠️ 顺序要紧：`@react-three/*` 的 id 里也含 "react"，必须先判 three 系。
     * ⚠️ `three` 与 `three/addons`、`three/tsl` 必须落在**同一个** chunk，
     *    否则会出现两份 three 实例（`instanceof` 全线失效，最典型的是
     *    `o.isMesh`、`o.isTexture` 判不出，材质静默不回退）。所以判据只用
     *    `node_modules/three/` 这一个前缀，不要按子路径细拆。
     */
    rollupOptions: {
      output: {
        /* 实测（2026-10-17，vite 7.3.6 / 1800 modules）：
         *   · 不拆：1 个 index 4.17 MB（gzip 1156 KB）
         *   · 细拆成 7 份（three / r3f / react / mmd / leva / vendor / index）：
         *     **合计 gzip 1330 KB —— 反而大了 15%**。原因是跨 chunk 边界之后 rollup
         *     不能再按「谁真的用了」做 tree-shaking，模块必须把自己所有导出都留着
         *     （另一份 chunk 随时可能来拿）。对一个**一次性访客**为主的生日会站点，
         *     首屏总字节比缓存命中率重要得多。
         *   · 只拆「库 / 业务」两份：库体基本不变、可以长期吃缓存；业务代码改一次只
         *     重下这一份。这才是这个项目真正需要的粒度。
         * 所以这里只用一条规则：`node_modules` 全进 `lib`。
         * ⚠️ 别再按库名细分 —— 上面那 15% 是实打实测出来的，不是猜的。 */
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          /* ⚠️ `eruda` 必须**排除**（返回 undefined = 交给 rollup 默认行为）。
           *   它是 `WorldController.tsx:210` 里 `?debug=true` 才触发的 `import()`
           *   动态加载 —— 默认会单独成一块、**只有开了调试才下载**。
           *   而 `manualChunks` 是"强制归块"，一旦把它塞进 `lib`，
           *   这个 506 KB（gzip 161 KB）的手机调试面板就变成**首屏必下**了。
           *   （第一次改这里时踩过：拆包后总 gzip 从 1156 KB 涨到 1369 KB，
           *    多出来的正好是它。） */
          if (id.includes("/eruda/")) return;
          return "lib";
        },
      },
    },
  },
};
