/**
 * 程序化 NPC 头像 —— **简笔画 / 涂鸦风**（用户原话：「信纸上带有邀请的对应NPC头像，
 * 简笔画或者涂鸦就行，可以自己画也可以交给制图AI」）。
 *
 * ── 为什么是「现画」而不是「贴 15 张 PNG」────────────────────────────
 * ① 走 AI 出图要多 15 张资源 + 一次网络/磁盘加载，而信纸是**逐行实时弹出来**的，
 *    头像晚到半秒就会先看到空位再"跳"出来一张脸，很廉价。
 * ② 这个项目的自我要求是「没有一张草贴图」（见 LoadingScreen 的文案），
 *    头像用 canvas 现场画气质才对得上。零资源、零网络、零加载态。
 *
 * ── 为什么抖动必须走确定性伪随机 ────────────────────────────────────
 * 手绘感来自「线条是抖的」。但如果用 `Math.random()`，同一封邀请函每次重渲染
 * （React 重挂载 / 切信纸）都会给同一个角色换一张脸 —— 玩家会看见芙宁娜的
 * 发际线在跳。所以所有抖动都走**以 npcId 为种子**的 PCG 整数混合
 * （与 `core/venueRing.ts` 的 `hash01` 同一套思路：不用 `sin` 那种在大索引上会退化的写法）。
 *
 * ── 怎么保证 15 个角色「一眼能分开」──────────────────────────────────
 * 64px 的头像上真正能被认出来的只有三样东西，按权重排：
 *   ① **剪影**（礼帽 / 猫耳 / 兜帽 / 潜水盔 / 双马尾 / 头巾）—— 最大信号，所以配件画得比脸还大；
 *   ② **色块**（发色）—— 橙色双马尾 vs 黑红短发 vs 白蓝长发，隔 5 米也能分；
 *   ③ **眼神**（星眼 / 竖瞳 / 死鱼眼 / 大眼）—— 近看时的性格。
 * 五官本身刻意画得很简（点、弧线），因为「简笔画」本来就不该靠五官区分。
 */

/* ==================================================================
 * 特征表
 * ================================================================== */

/** 发色/配件等「每个角色不一样」的全部参数。改这里就能改长相。 */
interface NpcFeature {
    /** 纸底（极淡，避免 15 张纯白糊成一片） */
    bg: string;
    /** 主发色 */
    hair: string;
    /** 发色暗部（后层头发用它，拉开前后景） */
    hair2: string;
    /** 肤色 */
    skin: string;
    /** 发型 —— 决定**后层**轮廓（剪影的主要来源之一） */
    style: 'curly' | 'long' | 'short' | 'twin' | 'bun' | 'hood' | 'helmet' | 'braid' | 'wisp';
    /** 眼睛画法 —— 近看的性格 */
    eyes: 'star' | 'dot' | 'arc' | 'sleepy' | 'slit' | 'big' | 'cool' | 'doll' | 'droop';
    /** 嘴 */
    mouth: 'smile' | 'grin' | 'flat' | 'small' | 'pout' | 'open';
    /** 配件（可叠多个，按数组顺序画） */
    acc: string[];
    /** 整颗头的倾斜角（度）。给角色加"姿态"，比正正地立着生动 */
    tilt: number;
}

/**
 * 15 个角色的特征表 —— 顺序与 `copy.ts` 的 `NPCS` 无关，查表按 id。
 * ⚠️ 只认 id，不认数组下标：`copy.ts` 里 NPC 顺序随时可能调整，
 *    用下标索引会静默地把派蒙画成那维莱特。
 */
const FEATURES: Record<string, NpcFeature> = {
    /* 芙宁娜：浅蓝白卷发 + 礼帽 + 星眼，得意 */
    furina: {
        bg: '#eef4fa', hair: '#dbeaf6', hair2: '#b9d3e8', skin: '#f7e6d8',
        style: 'curly', eyes: 'star', mouth: 'grin', acc: ['tophatBlue', 'cravat'], tilt: -5,
    },
    /* 菈乌玛：长发 + 兽耳 + 羽饰，温和 */
    lauma: {
        bg: '#f2f0e6', hair: '#7d5b3e', hair2: '#5d4229', skin: '#f0d9c2',
        style: 'long', eyes: 'droop', mouth: 'smile', acc: ['beastEars', 'feather'], tilt: 3,
    },
    /* 林尼：紫色礼帽 + 魔术师笑容 + 扑克牌 */
    lyney: {
        bg: '#f6f0f6', hair: '#c9a3e0', hair2: '#a37fc4', skin: '#f7e3d2',
        style: 'short', eyes: 'arc', mouth: 'grin', acc: ['tophatPurple', 'card'], tilt: -6,
    },
    /* 琳妮特：猫耳 + 面无表情 + 短发 */
    lynette: {
        bg: '#f0eef4', hair: '#cdb0dd', hair2: '#a98cc4', skin: '#f6e2d4',
        style: 'short', eyes: 'sleepy', mouth: 'flat', acc: ['catEars', 'ribbon'], tilt: 4,
    },
    /* 那维莱特：长直白蓝发 + 竖瞳 + 额饰，冷淡 */
    neuvillette: {
        bg: '#eaf0f5', hair: '#e4ecf3', hair2: '#b7c8da', skin: '#f4e0d3',
        style: 'long', eyes: 'slit', mouth: 'flat', acc: ['gem', 'cravat'], tilt: 0,
    },
    /* 奈芙尔：沙漠风头巾 + 耳饰，精明 */
    naifuer: {
        bg: '#f7f0e0', hair: '#4a3a52', hair2: '#33273b', skin: '#e8c9a4',
        style: 'long', eyes: 'cool', mouth: 'small', acc: ['desertScarf', 'earring'], tilt: -4,
    },
    /* 荧：金色短发 + 花饰，明亮 */
    lumine: {
        bg: '#faf5e4', hair: '#f0d78a', hair2: '#d4b45e', skin: '#f9e7d6',
        style: 'short', eyes: 'big', mouth: 'smile', acc: ['flower', 'scarf'], tilt: 5,
    },
    /* 桑多涅：紫色 + 人偶球关节 + 高傲 */
    sandrone: {
        bg: '#f5eff7', hair: '#c3a2d8', hair2: '#9d7cb8', skin: '#f7e6dc',
        style: 'bun', eyes: 'doll', mouth: 'pout', acc: ['puppet', 'ribbon'], tilt: -7,
    },
    /* 伊涅芙：机械女仆 + 发条齿轮 + 呆萌 */
    ineffa: {
        bg: '#eff1f2', hair: '#c8d2da', hair2: '#9fadb8', skin: '#f3e2d6',
        style: 'bun', eyes: 'dot', mouth: 'small', acc: ['maidband', 'gear'], tilt: 2,
    },
    /* 阿蕾奇诺：黑红短发 + 黑白瞳 + 冷峻 */
    arlecchino: {
        bg: '#f2eeee', hair: '#26212a', hair2: '#171319', skin: '#f2ded0',
        style: 'short', eyes: 'cool', mouth: 'flat', acc: ['redStreak', 'cravat'], tilt: -2,
    },
    /* 爱诺：橙发双马尾 + 元气大眼 + 星形发夹 */
    aino: {
        bg: '#fdf2e4', hair: '#f2a24a', hair2: '#d47f2c', skin: '#fae3cd',
        style: 'twin', eyes: 'big', mouth: 'open', acc: ['starClip'], tilt: 6,
    },
    /* 菲林斯：深色兜帽 + 灯塔看守，沉稳 */
    flins: {
        bg: '#eef0ef', hair: '#2f3742', hair2: '#20262e', skin: '#eed7c4',
        style: 'hood', eyes: 'dot', mouth: 'flat', acc: ['lamp'], tilt: -3,
    },
    /* 菲米尼：潜水头盔 + 短发，内向低头 */
    freminet: {
        bg: '#e9f0f4', hair: '#c2d2dc', hair2: '#9db0bc', skin: '#f2e0d2',
        style: 'helmet', eyes: 'droop', mouth: 'small', acc: ['diveHelmet'], tilt: 8,
    },
    /* 空：金发辫子 + 围巾，少年 */
    aether: {
        bg: '#faf4e6', hair: '#f2d98c', hair2: '#d6b862', skin: '#f6e0c8',
        style: 'braid', eyes: 'dot', mouth: 'smile', acc: ['scarf'], tilt: -4,
    },
    /* 派蒙：白色小精灵 + 飘带 + 圆脸大眼 */
    paimon: {
        bg: '#f7f8fb', hair: '#fbfbfd', hair2: '#d9dcea', skin: '#fceada',
        style: 'wisp', eyes: 'big', mouth: 'open', acc: ['halo', 'crown'], tilt: 0,
    },
};

/** 查不到 id 时的兜底：一个不偏不倚的简笔小人头（**不抛错**，信纸不能因为少一个角色就白屏）。 */
const FALLBACK: NpcFeature = {
    bg: '#f6f1e6', hair: '#8a7f6d', hair2: '#6b6252', skin: '#f2ddc8',
    style: 'short', eyes: 'dot', mouth: 'smile', acc: [], tilt: 0,
};

/* ==================================================================
 * 确定性伪随机
 * ================================================================== */

/** 与 `core/venueRing.ts` 同款的 PCG 整数混合。 */
function hash01(a: number, b: number, salt = 0): number {
    let h = (Math.imul(a | 0, 0x27d4eb2d)
        ^ Math.imul(b | 0, 0x165667b1)
        ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 字符串 → 32 位种子（FNV-1a）。 */
function seedOf(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h >>> 0;
}

/**
 * 一次绘制专用的线性同余发生器。
 * 用它（而不是全局 Math.random）才能保证「同一个 id 每次画出同一张脸」。
 */
function rngOf(id: string): () => number {
    let s = seedOf(id) || 0x9e3779b9;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/* ==================================================================
 * 画法基元
 * ================================================================== */

/** 墨色 —— 比纯黑柔，像铅笔/钢笔。 */
const INK = '#3a3226';
/** 设计尺寸。所有坐标都按 128 写，最后整体缩放，改 size 不用重算坐标。 */
const DESIGN = 128;

/**
 * 一圈「手抖」的闭合曲线：把椭圆按 n 段采样、每段半径加确定性抖动，
 * 再以相邻采样点的中点为锚、采样点为控制点连二次曲线。
 * 这样得到的是**平滑但不规则**的轮廓 —— 直接用折线会变成多边形，不像手画的。
 */
function blob(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, rx: number, ry: number,
    n: number, jit: number, rnd: () => number, rot = 0,
): void {
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const k = 1 + (rnd() - 0.5) * 2 * jit;
        pts.push(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k);
    }
    ctx.beginPath();
    const midX = (i: number, j: number) => (pts[i * 2] + pts[j * 2]) / 2;
    const midY = (i: number, j: number) => (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2;
    ctx.moveTo(midX(n - 1, 0), midY(n - 1, 0));
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        ctx.quadraticCurveTo(pts[i * 2], pts[i * 2 + 1], midX(i, j), midY(i, j));
    }
    ctx.closePath();
}

/** 描一条「手画」的线（轻微抖动 + 圆头圆角）。 */
function stroke(ctx: CanvasRenderingContext2D): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.stroke();
}

/**
 * 画一条二次贝塞尔「抖」线（眉毛、嘴、刘海）。
 * 只用一个控制点，够简单；抖动加在控制点上，比逐点采样省事且更"手写"。
 */
function curve(
    ctx: CanvasRenderingContext2D,
    x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
    rnd: () => number, amp = 1.1,
): void {
    const j = () => (rnd() - 0.5) * 2 * amp;
    ctx.beginPath();
    ctx.moveTo(x0 + j(), y0 + j() * 0.4);
    ctx.quadraticCurveTo(cx + j(), cy + j(), x1 + j(), y1 + j() * 0.4);
    stroke(ctx);
}

/** 实心圆（眼睛的高光、火漆里的点）。 */
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

/** 五角星（星眼 / 发夹）。手绘感的星：顶点半径带抖动。 */
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rnd: () => number): void {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const rr = (i % 2 === 0 ? r : r * 0.42) * (1 + (rnd() - 0.5) * 0.18);
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
}

/* ==================================================================
 * 分部件绘制
 * ================================================================== */

/** 后层头发（在脸之前画，形成剪影）。 */
function drawHairBack(ctx: CanvasRenderingContext2D, f: NpcFeature, rnd: () => number): void {
    ctx.fillStyle = f.hair2;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    switch (f.style) {
        case 'long':
            /* 披肩长发：一个往下拉长的大水滴 */
            blob(ctx, 64, 92, 38, 42, 16, 0.07, rnd);
            ctx.fill(); ctx.stroke();
            break;
        case 'curly':
            /* 卷发：外圈一圈鼓包（先画大底再叠小球，边缘才毛） */
            blob(ctx, 64, 76, 40, 42, 16, 0.05, rnd);
            ctx.fill(); ctx.stroke();
            for (let i = 0; i < 10; i++) {
                const a = (i / 10) * Math.PI * 2;
                const r = 12 + rnd() * 4;
                ctx.beginPath();
                ctx.arc(64 + Math.cos(a) * 38, 76 + Math.sin(a) * 40, r, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
            }
            break;
        case 'twin':
            /* 双马尾：左右两个外扩的辫子，是这个角色最大的剪影信号 */
            for (const s of [-1, 1]) {
                blob(ctx, 64 + s * 42, 82, 14, 26, 10, 0.12, rnd);
                ctx.fill(); ctx.stroke();
            }
            blob(ctx, 64, 72, 36, 36, 14, 0.05, rnd);
            ctx.fill(); ctx.stroke();
            break;
        case 'bun':
            /* 双丸子 + 盘发 */
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.arc(64 + s * 30, 44, 13, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
            }
            blob(ctx, 64, 74, 36, 36, 14, 0.05, rnd);
            ctx.fill(); ctx.stroke();
            break;
        case 'braid':
            /* 麻花辫：右侧一串交错的椭圆 */
            blob(ctx, 64, 74, 36, 36, 14, 0.05, rnd);
            ctx.fill(); ctx.stroke();
            for (let i = 0; i < 5; i++) {
                ctx.beginPath();
                ctx.ellipse(94 + (i % 2 ? 2 : -2), 74 + i * 11, 7, 6, (i % 2 ? 1 : -1) * 0.5, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
            }
            break;
        case 'hood':
            /* 兜帽：一个大三角把整个头包住，只留脸洞 */
            ctx.beginPath();
            ctx.moveTo(64, 12);
            ctx.quadraticCurveTo(118, 40, 104, 118);
            ctx.lineTo(24, 118);
            ctx.quadraticCurveTo(10, 40, 64, 12);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            break;
        case 'helmet':
            /* 潜水盔：大圆，里面才是脸 */
            ctx.beginPath();
            ctx.arc(64, 68, 46, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
            break;
        case 'wisp':
            /* 飘带/披风：左右两片尖角 */
            for (const s of [-1, 1]) {
                ctx.beginPath();
                ctx.moveTo(64, 60);
                ctx.quadraticCurveTo(64 + s * 52, 74, 64 + s * 30, 122);
                ctx.quadraticCurveTo(64 + s * 14, 96, 64, 60);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
            }
            break;
        case 'short':
        default:
            blob(ctx, 64, 72, 34, 34, 12, 0.06, rnd);
            ctx.fill(); ctx.stroke();
            break;
    }
}

/** 前层头发（刘海）—— 在脸之后画，压住额头。 */
function drawHairFront(ctx: CanvasRenderingContext2D, f: NpcFeature, rnd: () => number): void {
    ctx.fillStyle = f.hair;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    if (f.style === 'helmet') return; // 头盔下看不见刘海
    if (f.style === 'hood') {
        /* 兜帽只露出一撮碎发 */
        ctx.beginPath();
        ctx.moveTo(48, 44);
        ctx.quadraticCurveTo(64, 30, 80, 44);
        ctx.quadraticCurveTo(64, 40, 48, 44);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        return;
    }

    /* 刘海：一个盖住上半张脸的波浪帽檐 */
    const top = f.style === 'curly' ? 30 : 34;
    ctx.beginPath();
    ctx.moveTo(34, 70);
    ctx.quadraticCurveTo(36, top - 6, 64, top - 8);
    ctx.quadraticCurveTo(92, top - 6, 94, 70);
    /* 下缘做成锯齿/波浪，避免所有角色都是同一条"锅盖" */
    const n = f.style === 'curly' ? 7 : 5;
    for (let i = 0; i < n; i++) {
        const x1 = 94 - (i * 60) / n;
        const x0 = 94 - ((i + 1) * 60) / n;
        const dip = f.style === 'curly' ? 62 + rnd() * 8 : 58 + rnd() * 6;
        ctx.quadraticCurveTo((x0 + x1) / 2, dip, x0, 70 - i * 0.6);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    /* 长发的两侧鬓发（压住脸缘，让脸显小） */
    if (f.style === 'long' || f.style === 'curly' || f.style === 'braid' || f.style === 'twin') {
        for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(64 + s * 30, 40);
            ctx.quadraticCurveTo(64 + s * 40, 74, 64 + s * 32, 104);
            ctx.quadraticCurveTo(64 + s * 26, 74, 64 + s * 24, 44);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
        }
    }
}

/** 眼睛（含眉毛）。 */
function drawEyes(ctx: CanvasRenderingContext2D, f: NpcFeature, rnd: () => number): void {
    const LX = 52, RX = 76, Y = 72;
    ctx.lineCap = 'round';

    for (const [x, side] of [[LX, -1], [RX, 1]] as [number, number][]) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2.2;
        switch (f.eyes) {
            case 'star': {
                star(ctx, x, Y, 8, rnd);
                ctx.fillStyle = INK; ctx.fill();
                dot(ctx, x - 3, Y - 3, 2.2, '#ffffff');
                break;
            }
            case 'big': {
                ctx.beginPath();
                ctx.ellipse(x, Y, 7.5, 9, 0, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
                dot(ctx, x + side * 0.8, Y + 1.2, 4.6, INK);
                dot(ctx, x - 2.4, Y - 3, 2.2, '#ffffff');
                dot(ctx, x + 2.6, Y + 4, 1.4, '#ffffff');
                break;
            }
            case 'slit': {
                ctx.beginPath();
                ctx.ellipse(x, Y, 7, 5.4, 0, 0, Math.PI * 2);
                ctx.fillStyle = '#d8c8b4'; ctx.fill(); ctx.stroke();
                /* 竖瞳：龙类的唯一识别点 */
                ctx.beginPath();
                ctx.ellipse(x, Y, 1.7, 5, 0, 0, Math.PI * 2);
                ctx.fillStyle = INK; ctx.fill();
                break;
            }
            case 'sleepy': {
                /* 死鱼眼：上眼睑压平，下眼睑一道弧 */
                curve(ctx, x - 7, Y - 1, x, Y - 5.5, x + 7, Y - 1, rnd, 0.6);
                curve(ctx, x - 6, Y + 2, x, Y + 4.5, x + 6, Y + 2, rnd, 0.6);
                dot(ctx, x, Y + 0.5, 2.4, INK);
                break;
            }
            case 'cool': {
                /* 冷峻：眼睛画成带尖角的窄形 */
                ctx.beginPath();
                ctx.moveTo(x - 7, Y + 2);
                ctx.lineTo(x, Y - 4.5);
                ctx.lineTo(x + 7, Y + 1);
                ctx.quadraticCurveTo(x, Y + 5, x - 7, Y + 2);
                ctx.closePath();
                ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
                dot(ctx, x, Y, 2.6, INK);
                break;
            }
            case 'doll': {
                /* 人偶：眼白 + 十字高光，机械感 */
                ctx.beginPath();
                ctx.arc(x, Y, 7, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
                dot(ctx, x, Y, 3.4, INK);
                ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.moveTo(x - 2.6, Y); ctx.lineTo(x + 2.6, Y);
                ctx.moveTo(x, Y - 2.6); ctx.lineTo(x, Y + 2.6);
                ctx.stroke();
                break;
            }
            case 'droop': {
                /* 下垂眼：温和、没攻击性 */
                ctx.beginPath();
                ctx.ellipse(x, Y + 1, 6, 5.4, side * 0.16, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
                dot(ctx, x, Y + 1.5, 3.4, INK);
                curve(ctx, x - 7.5, Y - 4, x, Y - 7.5, x + 6, Y - 4.5, rnd, 0.5);
                break;
            }
            case 'arc': {
                /* 弯月笑眼 ^ ^ */
                curve(ctx, x - 7, Y + 3, x, Y - 6, x + 7, Y + 3, rnd, 0.7);
                break;
            }
            case 'dot':
            default: {
                dot(ctx, x, Y, 4, INK);
                dot(ctx, x - 1.4, Y - 1.6, 1.5, '#ffffff');
                break;
            }
        }
    }

    /* 眉毛：位置/斜率跟眼神走，不然"冷峻眼 + 平眉"会很怪 */
    const brow = f.eyes === 'cool' ? -4 : f.eyes === 'droop' ? 3 : 0;
    ctx.strokeStyle = f.hair2;
    ctx.lineWidth = 2.4;
    for (const [x, side] of [[LX, -1], [RX, 1]] as [number, number][]) {
        ctx.beginPath();
        ctx.moveTo(x - 7, 59 + brow + side * 0.6);
        ctx.quadraticCurveTo(x, 55 + brow, x + 7, 58 + brow + side * 0.6);
        ctx.stroke();
    }
    /* 阿蕾奇诺的异色瞳：左眼纯白无瞳（黑白瞳）。放这里是因为要盖在眉毛之后。 */
    if (f.acc.includes('redStreak')) {
        ctx.beginPath();
        ctx.arc(LX, Y, 6.4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; ctx.fill();
        ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
    }
}

/** 嘴。 */
function drawMouth(ctx: CanvasRenderingContext2D, f: NpcFeature, rnd: () => number): void {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    switch (f.mouth) {
        case 'grin': {
            curve(ctx, 54, 86, 64, 94, 74, 86, rnd, 0.7);
            curve(ctx, 57, 85, 64, 87, 71, 85, rnd, 0.4); // 牙线
            break;
        }
        case 'open': {
            ctx.beginPath();
            ctx.ellipse(64, 88, 5.5, 7, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#8a4a44'; ctx.fill(); ctx.stroke();
            break;
        }
        case 'flat': {
            curve(ctx, 57, 87, 64, 87.6, 71, 87, rnd, 0.5);
            break;
        }
        case 'small': {
            dot(ctx, 64, 87, 2.4, INK);
            break;
        }
        case 'pout': {
            curve(ctx, 57, 89, 64, 84, 71, 89, rnd, 0.6);
            break;
        }
        case 'smile':
        default: {
            curve(ctx, 56, 85, 64, 92, 72, 85, rnd, 0.7);
            break;
        }
    }
}

/** 配件 —— 剪影的主要来源，所以画得偏大。 */
function drawAcc(ctx: CanvasRenderingContext2D, f: NpcFeature, rnd: () => number): void {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const a of f.acc) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2.2;
        switch (a) {
            case 'tophatBlue':
            case 'tophatPurple': {
                /* 礼帽：帽檐 + 帽筒 + 一道缎带。故意画歪一点，像随手扣上去的 */
                const c = a === 'tophatBlue' ? '#e8f2fb' : '#b98bd6';
                const band = a === 'tophatBlue' ? '#8fb8d8' : '#7a55a0';
                ctx.fillStyle = c;
                ctx.beginPath();
                ctx.ellipse(64, 34, 34, 7.5, -0.04, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(44, 34);
                ctx.lineTo(46, 6);
                ctx.quadraticCurveTo(64, 2, 82, 6);
                ctx.lineTo(84, 34);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                ctx.fillStyle = band;
                ctx.beginPath();
                ctx.moveTo(45, 30);
                ctx.lineTo(83, 30);
                ctx.lineTo(83.6, 36);
                ctx.lineTo(44.4, 36);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'catEars': {
                ctx.fillStyle = f.hair;
                for (const s of [-1, 1]) {
                    ctx.beginPath();
                    ctx.moveTo(64 + s * 16, 40);
                    ctx.lineTo(64 + s * 30, 8 + rnd() * 4);
                    ctx.lineTo(64 + s * 38, 44);
                    ctx.closePath();
                    ctx.fill(); ctx.stroke();
                    /* 内耳 */
                    ctx.beginPath();
                    ctx.moveTo(64 + s * 22, 38);
                    ctx.lineTo(64 + s * 30, 20);
                    ctx.lineTo(64 + s * 33, 40);
                    ctx.closePath();
                    ctx.fillStyle = '#e0a8b4'; ctx.fill();
                    ctx.fillStyle = f.hair;
                }
                break;
            }
            case 'beastEars': {
                /* 兽耳：比猫耳更圆更大，横向 */
                ctx.fillStyle = f.hair;
                for (const s of [-1, 1]) {
                    ctx.beginPath();
                    ctx.ellipse(64 + s * 28, 22, 11, 16, s * 0.5, 0, Math.PI * 2);
                    ctx.fill(); ctx.stroke();
                }
                break;
            }
            case 'feather': {
                ctx.fillStyle = '#e8dcc0';
                ctx.beginPath();
                ctx.moveTo(96, 34);
                ctx.quadraticCurveTo(116, 18, 118, 44);
                ctx.quadraticCurveTo(104, 50, 96, 34);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'gem': {
                /* 额饰：菱形宝石 */
                ctx.fillStyle = '#9fd8e8';
                ctx.beginPath();
                ctx.moveTo(64, 36);
                ctx.lineTo(71, 45);
                ctx.lineTo(64, 54);
                ctx.lineTo(57, 45);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'flower': {
                ctx.fillStyle = '#ffffff';
                for (let i = 0; i < 5; i++) {
                    const ang = (i / 5) * Math.PI * 2;
                    dot(ctx, 92 + Math.cos(ang) * 6, 40 + Math.sin(ang) * 6, 5, '#ffffff');
                }
                dot(ctx, 92, 40, 4, '#f0c860');
                break;
            }
            case 'maidband': {
                /* 女仆头饰：一道白箍 + 两侧荷叶边 */
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.moveTo(34, 42);
                ctx.quadraticCurveTo(64, 26, 94, 42);
                ctx.quadraticCurveTo(64, 36, 34, 42);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                for (const s of [-1, 1]) {
                    ctx.beginPath();
                    ctx.ellipse(64 + s * 30, 40, 9, 7, 0, 0, Math.PI * 2);
                    ctx.fill(); ctx.stroke();
                }
                break;
            }
            case 'gear': {
                /* 齿轮：发条女仆的机械感 */
                ctx.fillStyle = '#c8b48a';
                const cx = 100, cy = 66;
                ctx.beginPath();
                for (let i = 0; i < 16; i++) {
                    const ang = (i / 16) * Math.PI * 2;
                    const rr = i % 2 === 0 ? 13 : 9;
                    const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                dot(ctx, cx, cy, 3.6, INK);
                break;
            }
            case 'diveHelmet': {
                /* 潜水盔：外圈金属 + 正面玻璃窗 + 铆钉 */
                ctx.fillStyle = '#a8b8c4';
                ctx.beginPath();
                ctx.arc(64, 68, 44, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#cfe6ee';
                ctx.beginPath();
                ctx.arc(64, 70, 28, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                for (let i = 0; i < 8; i++) {
                    const ang = (i / 8) * Math.PI * 2 + 0.4;
                    dot(ctx, 64 + Math.cos(ang) * 38, 68 + Math.sin(ang) * 38, 2.6, INK);
                }
                break;
            }
            case 'desertScarf': {
                /* 沙漠头巾：包住头 + 一条垂到肩的尾巴 */
                ctx.fillStyle = '#e0c890';
                ctx.beginPath();
                ctx.moveTo(64, 24);
                ctx.quadraticCurveTo(108, 34, 100, 84);
                ctx.quadraticCurveTo(88, 60, 64, 52);
                ctx.quadraticCurveTo(40, 60, 28, 84);
                ctx.quadraticCurveTo(20, 34, 64, 24);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(94, 72);
                ctx.quadraticCurveTo(118, 88, 108, 120);
                ctx.quadraticCurveTo(100, 100, 88, 84);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'earring': {
                ctx.fillStyle = '#e8c860';
                for (const s of [-1, 1]) {
                    dot(ctx, 64 + s * 27, 86, 4.2, '#e8c860');
                    ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
                    ctx.beginPath(); ctx.arc(64 + s * 27, 86, 4.2, 0, Math.PI * 2); ctx.stroke();
                    ctx.lineWidth = 2.2;
                }
                break;
            }
            case 'card': {
                /* 扑克牌：魔术师身份 */
                ctx.fillStyle = '#ffffff';
                ctx.save();
                ctx.translate(104, 96);
                ctx.rotate(0.32);
                ctx.beginPath();
                ctx.moveTo(-9, -13); ctx.lineTo(9, -13); ctx.lineTo(9, 13); ctx.lineTo(-9, 13);
                ctx.closePath(); ctx.fill(); ctx.stroke();
                dot(ctx, 0, 0, 3.6, '#c0392b');
                ctx.restore();
                break;
            }
            case 'puppet': {
                /* 人偶球关节：脖子上一颗圆球，机械人偶的招牌 */
                dot(ctx, 64, 100, 7, '#d8c8e8');
                ctx.strokeStyle = INK; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(64, 100, 7, 0, Math.PI * 2); ctx.stroke();
                break;
            }
            case 'ribbon': {
                ctx.fillStyle = '#d8687a';
                for (const s of [-1, 1]) {
                    ctx.beginPath();
                    ctx.moveTo(64 + s * 12, 30);
                    ctx.lineTo(64 + s * 30, 22);
                    ctx.lineTo(64 + s * 30, 40);
                    ctx.closePath();
                    ctx.fill(); ctx.stroke();
                }
                dot(ctx, 64, 31, 4, '#b84a5c');
                break;
            }
            case 'starClip': {
                ctx.fillStyle = '#f0d040';
                star(ctx, 92, 40, 11, rnd);
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'redStreak': {
                /* 阿蕾奇诺的黑红挑染：两撮红发 */
                ctx.strokeStyle = '#c0392b';
                ctx.lineWidth = 3.4;
                for (const s of [-1, 1]) {
                    ctx.beginPath();
                    ctx.moveTo(64 + s * 20, 34);
                    ctx.quadraticCurveTo(64 + s * 30, 46, 64 + s * 26, 62);
                    ctx.stroke();
                }
                break;
            }
            case 'cravat': {
                /* 领巾/领结：把头像和"礼服"联系起来 */
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.moveTo(52, 100);
                ctx.lineTo(76, 100);
                ctx.lineTo(70, 122);
                ctx.lineTo(58, 122);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'scarf': {
                ctx.fillStyle = '#e0705a';
                ctx.beginPath();
                ctx.moveTo(46, 98);
                ctx.quadraticCurveTo(64, 108, 82, 98);
                ctx.quadraticCurveTo(84, 114, 64, 118);
                ctx.quadraticCurveTo(44, 114, 46, 98);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            case 'lamp': {
                /* 灯塔看守的小提灯 */
                ctx.fillStyle = '#f0d878';
                ctx.beginPath();
                ctx.moveTo(96, 104); ctx.lineTo(116, 104); ctx.lineTo(114, 122); ctx.lineTo(98, 122);
                ctx.closePath(); ctx.fill(); ctx.stroke();
                dot(ctx, 106, 113, 4, '#fff4c0');
                break;
            }
            case 'halo':
            case 'crown': {
                /* 派蒙的环 + 小王冠 */
                ctx.fillStyle = '#f8e8a0';
                ctx.beginPath();
                ctx.ellipse(64, 8, 22, 6, 0, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(42, 30); ctx.lineTo(46, 14); ctx.lineTo(56, 24);
                ctx.lineTo(64, 10); ctx.lineTo(72, 24); ctx.lineTo(82, 14); ctx.lineTo(86, 30);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
                break;
            }
            default: break;
        }
    }
}

/* ==================================================================
 * 主绘制
 * ================================================================== */

function drawPortrait(ctx: CanvasRenderingContext2D, f: NpcFeature, rnd: () => number): void {
    /* 纸底 */
    ctx.fillStyle = f.bg;
    ctx.fillRect(0, 0, DESIGN, DESIGN);

    /* 一圈淡边，像贴纸的裁切痕 */
    ctx.strokeStyle = 'rgba(58,50,38,0.18)';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(3.5, 3.5, DESIGN - 7, DESIGN - 7);

    ctx.save();
    /* 整颗头按 tilt 旋转：正正立着会像证件照，歪一点才像随手画的速写 */
    ctx.translate(64, 70);
    ctx.rotate((f.tilt * Math.PI) / 180);
    ctx.translate(-64, -70);

    drawHairBack(ctx, f, rnd);

    /* 脖子 */
    ctx.fillStyle = f.skin;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(54, 90); ctx.lineTo(54, 108); ctx.lineTo(74, 108); ctx.lineTo(74, 90);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    /* 耳朵（兜帽/头盔遮住时不画） */
    if (f.style !== 'hood' && f.style !== 'helmet') {
        ctx.fillStyle = f.skin;
        for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.ellipse(64 + s * 27, 74, 5, 7.5, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
        }
    }

    /* 脸 —— 手绘感的不规则椭圆 */
    ctx.fillStyle = f.skin;
    blob(ctx, 64, 70, 26, 29, 12, 0.035, rnd);
    ctx.fill(); ctx.stroke();

    drawHairFront(ctx, f, rnd);
    drawEyes(ctx, f, rnd);
    drawMouth(ctx, f, rnd);

    /* 腮红：让脸不至于是一块死板的肤色 */
    ctx.fillStyle = 'rgba(224,140,130,0.28)';
    for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(64 + s * 17, 82, 6.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    drawAcc(ctx, f, rnd);
    ctx.restore();
}

/* ==================================================================
 * 对外接口
 * ================================================================== */

/**
 * 画一张 `size × size` 的 NPC 头像（简笔画/涂鸦风），返回 PNG dataURL。
 * 未知 id → 通用简笔小人头（**不抛错**）。
 */
export function portraitDataURL(npcId: string, size = 128): string {
    /* canvas 只存在于浏览器。这个项目没有 SSR，但调用方可能在模块顶层就摸到它，
       兜一下比在生产里炸掉强。 */
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    /* 按 128 设计、按 size 输出：一次缩放比在每个坐标里乘 scale 干净得多 */
    const k = size / DESIGN;
    if (k !== 1) ctx.scale(k, k);

    const f = FEATURES[npcId] ?? FALLBACK;
    drawPortrait(ctx, f, rngOf(npcId || 'anon'));
    return canvas.toDataURL('image/png');
}

/** 缓存 —— 同一 id 只画一次（dataURL 有几 KB，每次重渲染重画会白烧 CPU）。 */
const CACHE = new Map<string, string>();

/** 取头像（带缓存）。 */
export function getPortrait(npcId: string): string {
    const hit = CACHE.get(npcId);
    if (hit !== undefined) return hit;
    const url = portraitDataURL(npcId);
    CACHE.set(npcId, url);
    return url;
}
