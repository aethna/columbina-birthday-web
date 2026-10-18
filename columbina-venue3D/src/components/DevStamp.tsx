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
