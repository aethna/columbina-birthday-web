import { useEffect, useState } from 'react';

/* ★★ 开发版状态角标（`?stamp=0` 关闭，缺省开）
 *
 * 为什么要有它：本项目的验收者有**不能开 F12 / 看不了控制台**这个硬约束，
 * 于是「用户看到的到底是不是我改的这份代码」永远只能靠猜 —— 这一轮就撞上了：
 * 我这边实时路径逐项测过（`sep 29.6 cm → 4.9 cm`），用户那边回「没变化」。
 *
 * 所以把三件最容易被 URL 参数悄悄改掉的事直接画在屏幕上：
 *   ① 这份代码是**哪一份**（构建标记 = 源码 mtime 由 vite 注入的 `import.meta.env`）；
 *   ② 收尾回站立 / 布料方向性约束 / 肢体驱动 现在是**开还是关**；
 *   ③ **URL 里带了哪些非缺省参数**（尤其 `?settle=0`、`?landold=1`、`?cam=`、`?tfreeze=`）。
 *
 * 参数一栏是安全关键：`?cam=` 会让 WASD 整个失效、`?landold=1` 会关掉新的收尾逻辑、
 * 满屏的 `?tfreeze=1` 会把动画钉死 —— 这些都会让「功能没生效」和「代码没改」看起来一样。
 */

/** 危险的 URL 参数 → 它对功能的实际影响（会在角标里红字列出） */
const DANGER: Array<[string, (v: string) => boolean, string]> = [
    ['cam', () => true, '固定机位：WASD 整个失效（?cam 一出现 control 就不开）'],
    ['look', () => true, '同上（?look 只配 ?cam 用）'],
    ['tfreeze', (v) => v !== '0', '动画被定格：姿势验收看不到任何变化'],
    ['landold', (v) => v !== '0', '关掉本轮的新收尾逻辑（回到旧行为）'],
    ['settle', (v) => Number(v) <= 0, '关掉站姿合成（松手后仍是走路姿势）'],
    ['footlock', (v) => Number(v) <= 0, '关掉接地补偿'],
    ['secflare', (v) => Number(v) <= 0, '关掉袖子外撑（= 回到改动前的行为）'],
    ['secdrive', (v) => Number(v) <= 0, '关掉肢体驱动的向前摆'],
    ['secanti', (v) => Number(v) < 0, '关掉布料方向性约束'],
    ['secondary', (v) => Number(v) <= 0, '关掉头发/衣服弹簧骨'],
    ['legpose', (v) => Number(v) > 0, '腿姿被曲线覆盖（会和站姿合成打架）'],
    ['hold', (v) => Number(v) > 0, '原地走（不位移）'],
    ['autowalk', (v) => Number(v) > 0, '自动走（键盘输入被顶掉）'],
    ['ik', (v) => Number(v) > 0, '打开了 IK（脚会被钉住）'],
    ['props', (v) => Number(v) <= 0, '场景道具（树/石头）不渲染'],
    ['real', (v) => Number(v) <= 0, '切到老 OBJ 道具线'],
    ['mmd', (v) => Number(v) <= 0, '角色不渲染'],
];

const n1 = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v.toFixed(2) : '—');

export default function DevStamp() {
    const [txt, setTxt] = useState('哥伦比娅 · WebGPU 开发版：正在读取状态…');

    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        // 非缺省参数 + 危险参数（只在挂载时算一次，URL 不会中途变）
        const keys = [...new Set([...q.keys()])];
        const warns: string[] = [];
        for (const [k, test, msg] of DANGER) {
            if (!q.has(k)) continue;
            const vals = q.getAll(k);
            if (vals.some((v) => test(v))) warns.push(`⚠ ?${k}=${vals.join(',')} → ${msg}`);
        }
        const paramLine = keys.length
            ? keys.map((k) => `${k}=${q.getAll(k).join(',')}`).join('  ')
            : '（无，全部走缺省）';

        let alive = true;
        const tick = () => {
            if (!alive) return;
            const M = (window as any).__mmd;
            if (!M || typeof M.gait !== 'function') {
                setTxt('哥伦比娅 · WebGPU 开发版\n等待模型加载（还没有 window.__mmd）');
                return;
            }
            let g: any = null, s: any = null, f: any = null;
            try { g = M.gait(); s = g && g.secondary; f = M.flags && M.flags(); } catch { /* 忽略 */ }
            const ph = M.phase ? M.phase() : null;
            const set = M.settle ? M.settle() : null;
            const done = M.landDone ? M.landDone() : null;
            const lines = [
                '哥伦比娅 · WebGPU 开发版（源码热更新 @5181）',
                `① 收尾回站立：${set ? `${set.on ? '开' : '关'} 权重 ${n1(set.t)} 左腿偏角 ${set.qL == null ? '—' : set.qL + '°'}（0° = 腿已站直）` : '（无读数）'}`
                    + `　两踝间距 ${set && set.sep != null ? (set.sep * 100).toFixed(1) + ' cm（走路叉开 ~30，站定 ~5）' : '—'}`
                    + `　落位 ${done === null || done === undefined ? '—' : (done ? '完成' : '未完成')}　相位 ${ph == null ? '—' : n1(ph)}`,
                `布料：方向性约束 ${s ? s.antiDeg + '°' : '—'}（${s ? s.antiBones : '—'} 根）`
                    + `　肢体驱动 ${s ? s.driveDeg + '°' : '—'}（前襟 ${s ? s.driveFrontBones : '—'} / 袖 ${s ? s.driveArmBones : '—'}）`
                    + `　本帧驱动 腿 ${s ? n1(s.driveFwd) : '—'} 臂 ${s ? n1(s.driveArm) : '—'} 推动 ${s ? s.driveN : '—'} 根`
                    + `　相位超前 ${s ? s.driveLead + ' s' : '—'}`,
                /* ★ 袖子外撑（`?secflare=`）。**这一行只读数据 + 拼字符串**，不放判定/计算逻辑：
                 *   判定放在 secondaryMotion 里，这里放逻辑就会变成「两个真相」。
                 *   三个数各证明一件事：
                 *   `袖骨 N 根` = 构建期静态分类（N>0 才可能真的撑）；
                 *   `本帧撑 M 根` = 运行期实际执行（M=0 而 N>0 ⇒ 速度信号没上来 / 被门挡了）；
                 *   `驱动 K 根` 必须与 `本帧驱动 推动` 同时看 —— driveN=0 且 flare 有数，
                 *   才证明这次只开了外撑、**没有顺手把肢体驱动打开**。 */
                `袖子外撑：参数 ${s ? s.flareDeg + '°' : '—'}（袖骨 ${s ? s.flareBones : '—'} 根`
                    + `　本帧撑 ${s ? s.flareN : '—'} 根　平均 ${s ? n1(s.flareMeanDeg) : '—'}°）`
                    + `　撑开量 ${s ? n1(s.flareAmt) : '—'}　速度 ${s ? n1(s.flareSpd) + ' m/s' : '—'}`
                    + `　离体轴 ${s ? n1(s.flareOlMean) + ' / ' + n1(s.flareOlMax) + ' m' : '—'}`
                    + `　净外移 ${s ? n1(s.flareShiftMean * 1000) + ' / ' + n1(s.flareShiftMax * 1000) + ' mm' : '—'}`
                    + `　驱动 ${s ? s.driveN : '—'} 根`,
                /* ★★★ 袖子**侧向**飘（`?secside=`，用户 m18305：「袖子的摆动方向向两侧，
                 *   不随手臂前后」）。与上面「袖子外撑」是**两条独立通道**，读数必须分开：
                 *   - `参数 X°` = `?secside=` 的设定值（构建期算出的目标角）；
                 *   - `本帧摆 N 根 / 平均 Y°` = 运行期真的执行了多少根、生效多少度；
                 *     两者都取 `rig.sideN / rig.sideDeg`（`sideDeg` 是**生效**角，不是设定值）；
                 *   - `离体 向前↔两侧` = `measureSleeve()` 的 X（侧向）/ Z（前后）均值 ——
                 *     这一对比才是验收判据：侧向应显著大于前后，`?secside=-1` 时应掉回去。
                 *   `?secside=-1` 时 `sideBones` 应为 0（分类没跑），三者同时归 0。 */
                (() => {
                    const sd = s ? s.sideDeg : null;
                    const n = s ? s.sideN : null;
                    const bonesN = s ? s.sideBones : null;
                    let sv: any = null;
                    try { sv = M.sleeve ? M.sleeve() : null; } catch { sv = null; }
                    return `袖子侧向：参数 ${sd == null ? '—' : sd + '°'}（臂饰 ${bonesN == null ? '—' : bonesN} 根`
                        + `　本帧摆 ${n == null ? '—' : n} 根　平均 ${sd == null ? '—' : sd}°）`
                        + `　离体 向前 ${sv ? n1((sv.z || 0) * 100) + ' cm' : '—'} ↔ 两侧 ${sv ? n1((sv.x || 0) * 100) + ' cm' : '—'}`
                        + `　侧向优势 ${sv && sv.z > 1e-6 ? n1(sv.x / sv.z) + '×' : '—'}`;
                })(),
                /* ★★★ 第二十四轮：四片布（编号1袖 / 4披肩 / 6披风 / 8带）的**幅度读数**。
                 *  用户原话：「?clothamp 参数不起作用，且游戏内无任何变化」——
                 *  实测参数确实生效（`dev` 69°→32°），但四片布本来只有 ±9°/±5°，
                 *  肉眼看不出差别 ⇒ 必须把数字打出来，让他能**边调边看**，不用靠眼睛比。
                 *  `设定` = URL 决定的角（已乘 clothamp）；`本帧` = 真的转了多少 —— 两者要一起看。 */
                (() => {
                    const cf = s ? s.clothFlat : null;
                    if (!cf) return '布料幅度：—';
                    return `布料幅度 clothamp=${cf.amp}　`
                        + `1袖 设定 ${cf.set.sleeve}°(+${cf.set.sleeveOsc} 往复) 本帧 ${cf.now.sleeve}°　`
                        + `4披肩 设定 ${cf.set.shawl}° 本帧 ${cf.now.shawl}°　`
                        + `6披风 设定 ${cf.set.cape}°　8带 设定 ${cf.set.ribbon}° 本帧合 ${cf.now.piece}°`;
                })(),
                `操作：${f ? `控制 ${f.ctrl ? '已开' : '未开'}　走 ${f.move ? '走' : '停'}` : '—'}`,
                `URL 参数：${paramLine}`,
            ];
            if (warns.length) lines.push(...warns);
            setTxt(lines.join('\n'));
        };
        tick();
        const id = window.setInterval(tick, 500);
        return () => { alive = false; window.clearInterval(id); };
    }, []);

    return (
        <div
            style={{
                position: 'fixed', left: 8, bottom: 8, zIndex: 9999,
                font: '11px/1.5 ui-monospace, Consolas, "Microsoft YaHei", monospace',
                color: '#e9e9f4', background: 'rgba(12,10,24,0.74)',
                padding: '6px 9px', borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.14)',
                pointerEvents: 'none', whiteSpace: 'pre',
                maxWidth: 'min(66vw, 780px)',
                textShadow: '0 1px 2px rgba(0,0,0,0.9)',
            }}
        >
            {txt}
        </div>
    );
}
