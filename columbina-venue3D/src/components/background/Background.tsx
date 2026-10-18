import * as THREE from 'three'
import { useMemo, useEffect, memo } from 'react'
import { useThree } from '@react-three/fiber'
import { texture, equirectUV, uniform, mx_rotate3d, vec3, positionWorld, float, mix, smoothstep } from 'three/tsl'
import { useKTX2Texture } from '@core'
import { CameraMode, useGameStore } from '../../core/store/gameStore'
import { uTime, uStarIntensity, uSkyTop, uSkyHorizon } from '../../core/shaders/uniforms';

export const Background = memo(function Background({ intensity, axis, speed }: { intensity: number, axis: [number, number, number], speed: number }) {
  const { scene } = useThree()

  const uniforms = useMemo(() => ({
    uIntensity: uniform(0.1),
    uSpeed: uniform(0.05),
    uAxis: uniform(vec3(0, 1, 0)),
  }), [])

  const cameraMode = useGameStore((state) => state.cameraMode);
  const map = useKTX2Texture({ map: '/textures/starmap_2020_4k.ktx2' }).map
  map.mapping = THREE.EquirectangularReflectionMapping
  map.colorSpace = THREE.SRGBColorSpace
  map.wrapS = THREE.RepeatWrapping
  map.wrapT = THREE.RepeatWrapping

  useEffect(() => {
    uniforms.uIntensity.value = cameraMode === CameraMode.FPV ? 1 : intensity
    uniforms.uAxis.value.set(axis[0], axis[1], axis[2]).normalize()
    uniforms.uSpeed.value = speed
  }, [cameraMode, intensity, axis, speed])

  useEffect(() => {
    if (map) {
      const dir = positionWorld.normalize()
      const angle = uTime.mul(uniforms.uSpeed)
      const rotatedDir = mx_rotate3d(dir, angle, uniforms.uAxis)
      const finalUVs = equirectUV(rotatedDir)

      const bgNode = texture(map, finalUVs).mul(uniforms.uIntensity)

      // ★ 昼夜循环：`uStarIntensity` 由 `core/sky/sunCycle.ts` 每帧写（1=深夜，0=白天）。
      //   白天不能是「星空被调暗」——那是一片灰，得换成真正的天光渐变。
      //   `positionWorld` 在背景 pass 里就是视线方向（three 在背景渲染时按射线布置），
      //   所以它的 y 分量就是「抬头多高」，用来做天顶↔地平线的渐变。
      const viewDir = positionWorld.normalize()
      // 渐变区间要**比画面上能看到的角度范围宽**：原来 -0.10~0.55 太窄，
      // 天顶色在画面顶部 1/10 处就饱和了 ⇒ 天上出现一道硬缝。
      // 现在拉到 -0.14~0.95，整片天从地平线到天顶是连续过渡。
      const skyGrad = smoothstep(float(-0.14), float(0.95), viewDir.y)
      const skyNode = mix(uSkyHorizon, uSkyTop, skyGrad)

      scene.backgroundNode = mix(skyNode, bgNode, uStarIntensity)
    }
    return () => {
      scene.backgroundNode = null
    }
  }, [scene, map, uniforms])


  return null
})

