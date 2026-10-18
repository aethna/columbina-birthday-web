/* ===== 基础 FBM（无主地带 / 森林的地面）· CPU 侧真值 =====
 *
 * ★ 为什么要这个文件
 * GPU 侧的地形高度 `getWorldHeight()`（`core/shaders/worldHeight.ts`）里，**基础 FBM** 那一项是
 * 「会场那套 MaterialX 噪声」，写成 `mx_fractal_noise_float(xz*freq + seed) * amp`
 * （`core/shaders/terrainHelpers.ts:24` 的 `getTerrainHeight`）。
 *
 * 2026-10-11 删掉浅海（用户 m05607）之后，**无主地带（将来的森林）也归这一项管**：
 *   旧公式 `worldHeightCPU()` 在会场返回 0、在月球只算环形山 + 微观起伏，
 *   **完全不含基础 FBM** —— 因为当年无主地带是海，海床是另一套 `basinNode`。
 *   海一没，CPU 那边无主地带的高度就变成 **0**，而 GPU 上那里有 ±1.5 m 的起伏，
 *   两边不再相等 ⇒ 森林里的道具会浮空/陷地，角色也会陷进坡里。
 *
 * 所以这里把 MaterialX 的 `mx_fractal_noise_float` **逐字移植到 JS**，
 * 让 `worldHeightCPU()` 能把基础 FBM 也算进去，与 GPU 重新对齐。
 *
 * ★ 移植来源（three 源码，不是猜的）
 *   · `three/src/nodes/materialx/MaterialXNodes.js:83`
 *     `mx_fractal_noise_float(p, octaves=3, lacunarity=2, diminish=0.5, amplitude=1)`
 *       = Σ_{i<octaves} amp_i · mx_perlin_noise_float(p_i)，amp 每层 ×diminish，p 每层 ×lacunarity
 *   · `three/src/nodes/materialx/lib/mx_noise.js`
 *     `mx_perlin_noise_float_1`（3D 分支，我们的 p 是 vec3(z=0) 所以走这条）
 *       = mx_gradient_scale3d(mx_trilerp(8 个角, u,v,w))，scale3d = ×0.9820
 *     `mx_hash_int_2(x,y,z)` / `mx_bjmix` / `mx_bjfinal` / `mx_rotl32`（Bob Jenkins 整数散列）
 *
 * ★ 与 GPU 的误差
 *   两边唯一的差异是 float32（GPU）与 float64（JS）。Perlin 是**连续**的（跨格不跳变），
 *   所以即使某个格坐标的 floor 因为 1e-6 的舍入差一格，高度差也可忽略。
 *   实测口径：噪声场的格距是 `1/freq = 20 m`，位置误差 ⇒ 高度误差在 1e-4 m 量级，
 *   远小于道具自身的尺寸，摆位看不出偏移。
 */

const U = (x: number): number => x >>> 0;

/** `mx_rotl32(x, k)` —— 32 位循环左移 */
function rotl32(x: number, k: number): number {
    x = x >>> 0;
    return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * `mx_bjmix(a, b, c)` —— Bob Jenkins 混合，**原地**改 a / b / c。
 * ⚠️ 必须用 `[a,b,c]` 数组接住，JS 没有引用出参。
 */
function bjMix(v: [number, number, number]): [number, number, number] {
    let a = v[0] >>> 0, b = v[1] >>> 0, c = v[2] >>> 0;
    a = (a - c) >>> 0; a = (a ^ rotl32(c, 4)) >>> 0;
    c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rotl32(a, 6)) >>> 0;
    a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rotl32(b, 8)) >>> 0;
    b = (b + a) >>> 0;
    a = (a - c) >>> 0; a = (a ^ rotl32(c, 16)) >>> 0;
    c = (c + b) >>> 0;
    b = (b - a) >>> 0; b = (b ^ rotl32(a, 19)) >>> 0;
    a = (a + c) >>> 0;
    c = (c - b) >>> 0; c = (c ^ rotl32(b, 4)) >>> 0;
    b = (b + a) >>> 0;
    return [a, b, c];
}

/** `mx_bjfinal(a, b, c)` —— 收尾混淆，返回 uint32 */
function bjFinal(a0: number, b0: number, c0: number): number {
    let a = a0 >>> 0, b = b0 >>> 0, c = c0 >>> 0;
    c = (c ^ b) >>> 0; c = (c - rotl32(b, 14)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rotl32(c, 11)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rotl32(a, 25)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rotl32(b, 16)) >>> 0;
    a = (a ^ c) >>> 0; a = (a - rotl32(c, 4)) >>> 0;
    b = (b ^ a) >>> 0; b = (b - rotl32(a, 14)) >>> 0;
    c = (c ^ b) >>> 0; c = (c - rotl32(b, 24)) >>> 0;
    return c >>> 0;
}

/** `mx_hash_int_2(x, y, z)` —— 3 参数重载，`len = 3`，无 bjmix（只有 3 个参数） */
function hashInt3(x: number, y: number, z: number): number {
    const len = 3;
    const base = U(0xdeadbeef + (len << 2) + 13);
    const a = U(base + (x | 0));
    const b = U(base + (y | 0));
    const c = U(base + (z | 0));
    return bjFinal(a, b, c);
}

/** `mx_fade(t)` —— Perlin 的 6t⁵−15t⁴+10t³ */
function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * `mx_gradient_float_1(hash, x, y, z)` —— 12 个梯度方向里挑一个做点积。
 * `mx_select(b,t,f)` = b ? t : f；`mx_negate_if(v,b)` = b ? −v : v。
 */
function gradFloat3(hash: number, x: number, y: number, z: number): number {
    const h = (hash & 15) >>> 0;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

/** `mx_trilerp_0` —— 注意参数顺序是 v0..v7 再 s,t,r，且 s↔x、t↔y、r↔z */
function trilerp(
    v0: number, v1: number, v2: number, v3: number,
    v4: number, v5: number, v6: number, v7: number,
    s: number, t: number, r: number,
): number {
    const s1 = 1 - s, t1 = 1 - t, r1 = 1 - r;
    return r1 * (t1 * (v0 * s1 + v1 * s) + t * (v2 * s1 + v3 * s))
        + r * (t1 * (v4 * s1 + v5 * s) + t * (v6 * s1 + v7 * s));
}

/** `mx_perlin_noise_float_1(p)` —— 3D 分支，返回乘过 0.9820 的值，范围约 ±1 */
export function perlin3(px: number, py: number, pz: number): number {
    const X = Math.floor(px), Y = Math.floor(py), Z = Math.floor(pz);
    const fx = px - X, fy = py - Y, fz = pz - Z;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const r = trilerp(
        gradFloat3(hashInt3(X, Y, Z), fx, fy, fz),
        gradFloat3(hashInt3(X + 1, Y, Z), fx - 1, fy, fz),
        gradFloat3(hashInt3(X, Y + 1, Z), fx, fy - 1, fz),
        gradFloat3(hashInt3(X + 1, Y + 1, Z), fx - 1, fy - 1, fz),
        gradFloat3(hashInt3(X, Y, Z + 1), fx, fy, fz - 1),
        gradFloat3(hashInt3(X + 1, Y, Z + 1), fx - 1, fy, fz - 1),
        gradFloat3(hashInt3(X, Y + 1, Z + 1), fx, fy - 1, fz - 1),
        gradFloat3(hashInt3(X + 1, Y + 1, Z + 1), fx - 1, fy - 1, fz - 1),
        u, v, w,
    );
    return 0.9820 * r;
}

/** `mx_fractal_noise_float(p, octaves=3, lacunarity=2, diminish=0.5)`（默认值） */
export function fractalNoise3(
    px: number, py: number, pz: number,
    octaves = 3, lacunarity = 2, diminish = 0.5,
): number {
    let result = 0;
    let amp = 1;
    let x = px, y = py, z = pz;
    for (let i = 0; i < octaves; i++) {
        result += amp * perlin3(x, y, z);
        amp *= diminish;
        x *= lacunarity; y *= lacunarity; z *= lacunarity;
    }
    return result;
}

/* ── 与 GPU 完全对齐的三个默认值（`core/shaders/uniforms.ts:22-24`）── */
export const TERRAIN_DEFAULT_AMP = 1.5;
export const TERRAIN_DEFAULT_FREQ = 0.05;
export const TERRAIN_DEFAULT_SEED = 0.0;

/**
 * **基础 FBM 地形高度** —— `terrainHelpers.ts:24` `getTerrainHeight` 的 JS 孪生。
 *
 * GPU 表达式：`mx_fractal_noise_float( (xz + 0.001) * freq + vec2(seed, 0) ) * amp`
 * ⚠️ `vec2(0.001)` 是**两个分量都加** 0.001；`vec2(seed, 0)` 只加在 x 上。
 *
 * @returns 高度（米），基准 0，幅值 ±1.5 m
 */
export function baseHeightCPU(
    x: number, z: number,
    amp = TERRAIN_DEFAULT_AMP,
    freq = TERRAIN_DEFAULT_FREQ,
    seed = TERRAIN_DEFAULT_SEED,
): number {
    return fractalNoise3((x + 0.001) * freq + seed, (z + 0.001) * freq, 0) * amp;
}
