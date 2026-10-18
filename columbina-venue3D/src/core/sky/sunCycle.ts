/* ===== 昼夜循环 · 太阳/月亮状态机（纯函数 + 一个全局时钟） =====
 *
 * 为什么单独一个文件：太阳方向、光色、光强、环境光、星空浓度、天空色、雾色
 * 这七个数必须是**同一个 hour 的函数**，散落在各个组件里迟早会不同步
 * （月亮挂在天上、地面却是正午光，这类 bug 肉眼很难描述、但一眼能看出来）。
 *
 * URL 开关（全部可在无头截图里覆盖）：
 *   ?hour=23        起始时刻（0~24 小时制），缺省 23（会场原本就是夜景）
 *   ?daylen=600     一整天多少秒。**缺省 600（10 分钟一天）**；`?daylen=0` 冻结
 *   ?tfreeze=<秒>   与全局时间冻结同义 —— 冻结时昼夜也一起冻结（截图可复现）
 *   ?dcyc=0         等价于 `?daylen=0`
 *
 * ⚠️ 判据：夜里那盏灯的**方向**必须与改造前 `DirectionalLight.tsx` 的
 *    `basePosition = (0, 2, 5)` 一致，否则会场裸 URL 的草地明暗会变（回归）。
 *    所以 MOON_DIR 直接取 (0,2,5) 归一化，夜里的强度和改造前的 2.0 对齐。
 */
import * as THREE from 'three'
import { QNUM, QSTR } from '../utils/query'

/* ---------- URL 解析 ---------- */
const _tfreeze = QNUM('tfreeze')
const _dcyc = QSTR('dcyc')
const START_HOUR = (() => {
    const v = QNUM('hour')
    if (v === null) return 23
    return ((v % 24) + 24) % 24
})()
/** 一整天多少秒。0 = 冻结。 */
const DAY_LEN = (() => {
    if (_tfreeze !== null) return 0
    if (_dcyc !== null && _dcyc !== '1') return 0
    return QNUM('daylen', 600)!
})()

/* ---------- 模型常数 ---------- */
const DEG = Math.PI / 180
/** 太阳最高能到多少度（正午仰角）。68° 是「明显偏高但还留得出影子」的值。 */
const MAX_ELEV = 68
/** 夜里的灯 = 月亮。方向刻意与改造前的太阳一致，保住会场观感。 */
const MOON_DIR = new THREE.Vector3(0, 2, 5).normalize()
const MOON_COLOR = new THREE.Color('#c6d8ff')
const MOON_INTENSITY = 1.9
/** 白天正午的太阳。`?sunint=` / `?suncol=` 覆盖这两个值。 */
const SUN_PEAK = QNUM('sunint', 2.2)!
/** `?suncol=ff8800` 与 `?suncol=#ff8800` 都要认（`THREE.Color` 只认带 # 的）。 */
const SUN_HIGH = (() => {
    const raw = QSTR('suncol')
    if (raw === null) return new THREE.Color('#fff6e8')
    try { return new THREE.Color(raw.startsWith('#') ? raw : '#' + raw) }
    catch { return new THREE.Color('#fff6e8') }
})()
const SUN_LOW = new THREE.Color('#ff7a35')
/** 白天补的环境光；夜里为 0（⇒ 会场零回归）。 */
const AMB_PEAK = QNUM('ambpeak', 0.85)!
const AMB_DAY = new THREE.Color('#a9c8e8')

const C_SKY_TOP_NIGHT = new THREE.Color('#04060d')
const C_SKY_TOP_DAY = new THREE.Color('#2f6fc4')
const C_SKY_HOR_NIGHT = new THREE.Color('#0d1522')
const C_SKY_HOR_DAWN = new THREE.Color('#ffab5e')
const C_SKY_HOR_DAY = new THREE.Color('#a8cbe8')

function clamp01(x: number) { return x < 0 ? 0 : x > 1 ? 1 : x }
/** 与 TSL 的 `smoothstep(e0, e1, x)` 同式（保证 CPU 判据与 shader 一致）。 */
function smoothstep(e0: number, e1: number, x: number) {
    const t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)
}

export interface SkyState {
    /** 0~24 */
    hour: number
    /** 从原点指向太阳的单位向量（夜里是「月亮应该在的方向」，由 lightDir 顶上） */
    sunDir: THREE.Vector3
    /** 真正喂给 THREE.DirectionalLight 的方向（夜里 = 月亮） */
    lightDir: THREE.Vector3
    lightColor: THREE.Color
    lightIntensity: number
    /** 白天补的那盏环境光（夜里 0） */
    ambientColor: THREE.Color
    ambientIntensity: number
    /** 1 = 星空满 / 0 = 白天 */
    starIntensity: number
    /** 0 = 夜 / 1 = 昼，天空与雾都按它混 */
    dayness: number
    skyTop: THREE.Color
    skyHorizon: THREE.Color
    /** 全局指数雾（月球会被 WorldController 再乘上 (1-月球权重) 变成真空） */
    fogColor: THREE.Color
    fogDensity: number
    /** 供 DevStamp 显示的「几点」 */
    label: string
}

const _out: SkyState = {
    hour: START_HOUR,
    sunDir: new THREE.Vector3(),
    lightDir: new THREE.Vector3(),
    lightColor: new THREE.Color(),
    lightIntensity: MOON_INTENSITY,
    ambientColor: new THREE.Color(),
    ambientIntensity: 0,
    starIntensity: 1,
    dayness: 0,
    skyTop: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    fogColor: new THREE.Color(),
    fogDensity: 0.0016,
    label: '',
}

/** 模块级临时色 —— `sunStateFor` 每帧被调用 2 次（`WorldController.tsx:302` 取
 *  雾/环境色、`DirectionalLight.tsx:131` 取光向），任何在里面 `new THREE.Color()`
 *  都会变成每秒 360 个以上的垃圾对象。这三个只是中间量，**不**会泄漏出去。 */
const _sunTint = new THREE.Color()
const _horizon = new THREE.Color()
/* 雾色相对地平线的「抬升色」。`fogColor = horizon.lerp(_fogTint, 0.25)`。
 *
 * ★ 2026-10-19 用户反馈「雾白得过头，更像白雾而不是雾」：
 *   原值 `#8894a6`（浅蓝灰，亮度 ~94）在夜里把 `#0d1522` 的暗地平线一路提亮成
 *   `#2b3543` 的灰白 —— 这是远景发白的源头之一（另一处是 `WorldController` 把
 *   贴地雾染成纯白，见那边的注释）。深夜的雾应当是**比夜空略亮一点的深蓝**，
 *   能透出树影，而不是一层白纱。
 *   ⇒ 换成 `#2a3644`（深蓝灰，亮度 ~33）。效果：
 *     夜 22:00  fogColor ≈ #141d2b（暗地平线只被抬起一点点，仍是深蓝）
 *     白天      fogColor ≈ #88a6bf（比原来的 #b4cddc 更蓝一档，白天不至于发灰白） */
const _fogTint = new THREE.Color('#2a3644')

/** 就地写入 `_out` 并返回它（每帧调用，别分配对象）。
 *  ⚠️ 返回的是**模块级共享单例**：调用方必须立刻把要用的值拷走
 *     （`WorldController` 是 `copy()` 的），**不要**把返回值存下来跨帧用。 */
export function sunStateFor(hour: number): SkyState {
    const t = (hour - 6) / 12
    const elevDeg = Math.sin(t * Math.PI) * MAX_ELEV
    const elev = elevDeg * DEG
    const az = (t - 0.5) * Math.PI

    const ce = Math.cos(elev)
    _out.sunDir.set(ce * Math.sin(az), Math.sin(elev), ce * Math.cos(az)).normalize()

    // 夜 → 昼：-2° 开始抬头，+10° 完全算白天
    const dayness = smoothstep(-2, 10, elevDeg)
    _out.dayness = dayness

    // 灯：夜里是月亮（固定方向），白天是太阳
    _out.lightDir.copy(MOON_DIR).lerp(_out.sunDir, dayness).normalize()
    _out.lightColor.copy(MOON_COLOR).lerp(
        _sunTint.copy(SUN_LOW).lerp(SUN_HIGH, smoothstep(1, 34, elevDeg)),
        dayness,
    )
    const sunI = SUN_PEAK * smoothstep(-3, 14, elevDeg)
    _out.lightIntensity = MOON_INTENSITY + (sunI - MOON_INTENSITY) * dayness

    _out.ambientColor.copy(AMB_DAY)
    _out.ambientIntensity = AMB_PEAK * dayness

    // 星空：太阳落到 -10° 以下全亮，升到 0° 全灭
    _out.starIntensity = 1 - smoothstep(-10, 0, elevDeg)

    _out.skyTop.copy(C_SKY_TOP_NIGHT).lerp(C_SKY_TOP_DAY, dayness)
    _horizon
        .copy(C_SKY_HOR_NIGHT)
        .lerp(C_SKY_HOR_DAWN, smoothstep(-7, 4, elevDeg))
        .lerp(C_SKY_HOR_DAY, smoothstep(10, 34, elevDeg))
    _out.skyHorizon.copy(_horizon)

    _out.fogColor.copy(_horizon).lerp(_fogTint, 0.25)
    _out.fogDensity = 0.0018 + 0.0014 * dayness

    const hh = Math.floor(hour)
    const mm = Math.floor((hour - hh) * 60)
    _out.label = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    return _out
}

/** 全局时钟。每个用它的组件都调 `advance(dt)` 也没关系 —— 用 `lastStamp` 去重。 */
export const SkyClock = {
    hour: START_HOUR,
    dayLen: DAY_LEN,
    running: DAY_LEN > 0,
    _lastStamp: -1,
    _lastHour: START_HOUR,
    /** @param now 单调递增的秒（传 `state.clock.elapsedTime`） */
    advance(now: number) {
        if (!this.running) { this._lastHour = this.hour; return this.hour }
        if (this._lastStamp < 0) this._lastStamp = now
        const dt = Math.max(0, now - this._lastStamp)
        this._lastStamp = now
        this.hour = (this.hour + (dt * 24) / this.dayLen) % 24
        this._lastHour = this.hour
        return this.hour
    },
    set(h: number) {
        this.hour = ((h % 24) + 24) % 24
        this._lastHour = this.hour
    },
    /** 供 UI / DevStamp 读（不推进） */
    get current() { return this._lastHour },
}

export const SKY_CLOCK_DEFAULT_HOUR = START_HOUR
export const SKY_CLOCK_DAY_LEN = DAY_LEN
