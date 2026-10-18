import { useFrame, useThree } from '@react-three/fiber'
import { useControls, folder } from 'leva'
import { useEffect, useRef } from 'react'
import type { Node } from 'three/webgpu'
import { pass, renderOutput } from 'three/tsl'
import {
  ACESFilmicToneMapping,
  NoToneMapping,
  PostProcessing,
} from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'

type PostFXControls = {
  enabled: boolean
  bloomEnabled: boolean
  intensity: number
  luminanceThreshold: number
  luminanceSmoothing: number
  bloomRadius: number
  smaaEnabled: boolean
  toneMappingEnabled: boolean
  exposure: number
}

function WebGPUPostFX({ ctrl }: { ctrl: PostFXControls }) {
  const { gl, scene, camera } = useThree()
  const postProcessingRef = useRef<PostProcessing | null>(null)
  const bloomPassRef = useRef<ReturnType<typeof bloom> | null>(null)

  useEffect(() => {
    const scenePass = pass(scene, camera)
    const sceneColor = scenePass.getTextureNode('output')

    let outputNode: Node = sceneColor

    if (ctrl.bloomEnabled) {
      const bloomPass = bloom(
        sceneColor,
        ctrl.intensity,
        ctrl.bloomRadius,
        ctrl.luminanceThreshold,
      )
      bloomPass.smoothWidth.value = ctrl.luminanceSmoothing
      bloomPassRef.current = bloomPass
      outputNode = sceneColor.add(bloomPass)
    } else {
      bloomPassRef.current = null
    }

    if (ctrl.smaaEnabled) {
      outputNode = smaa(outputNode)
    }

    const needsManualOutput = ctrl.smaaEnabled || ctrl.toneMappingEnabled
    if (needsManualOutput) {
      outputNode = renderOutput(outputNode)
    }

    const postProcessing = new PostProcessing(gl as never, outputNode)
    postProcessing.outputColorTransform = !needsManualOutput
    postProcessingRef.current = postProcessing

    return () => {
      postProcessing.dispose()
      postProcessingRef.current = null
      bloomPassRef.current = null
    }
  }, [
    gl,
    scene,
    camera,
    ctrl.bloomEnabled,
    ctrl.smaaEnabled,
    ctrl.toneMappingEnabled,
  ])

  useFrame(() => {
    gl.toneMapping = ctrl.toneMappingEnabled
      ? ACESFilmicToneMapping
      : NoToneMapping
    gl.toneMappingExposure = ctrl.exposure

    const bloomPass = bloomPassRef.current
    if (bloomPass) {
      bloomPass.strength.value = ctrl.intensity
      bloomPass.threshold.value = ctrl.luminanceThreshold
      bloomPass.radius.value = ctrl.bloomRadius
      bloomPass.smoothWidth.value = ctrl.luminanceSmoothing
    }

    postProcessingRef.current?.render()
  }, 1)

  return null
}

export function PostFX() {
  const ctrl = useControls('PostFX', {
    enabled: { value: true },
    bloom: folder({
      bloomEnabled: { value: true },
      intensity: { value: 1, min: 0, max: 3, step: 0.01 },
      luminanceThreshold: { value: 1, min: 0, max: 2, step: 0.01 },
      luminanceSmoothing: { value: 0.2, min: 0, max: 1, step: 0.01 },
      bloomRadius: { value: 0.6, min: 0, max: 1, step: 0.01, label: 'Radius' },
    }, { collapsed: true }),
    antialias: folder({
      smaaEnabled: { value: true, label: 'SMAA' },
    }, { collapsed: true }),
    toneMapping: folder({
      toneMappingEnabled: { value: true },
      exposure: { value: 0.5, min: 0, max: 4, step: 0.01 },
    }, { collapsed: true }),
  })

  if (!ctrl.enabled) return null

  return <WebGPUPostFX ctrl={ctrl} />
}
