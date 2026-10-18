import { useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import * as THREE from 'three/webgpu'
import GrassWebGPU from '../components/grass/GrassWebGPU'

/**
 * Debug component for testing grass culling
 * 
 * Features:
 * - God Camera: Free camera controlled by OrbitControls (what you see)
 * - Player Camera: Simulated player camera that controls culling (yellow frustum)
 * - CameraHelper: Visualizes the player camera's frustum
 * 
 * Usage:
 * Replace <GrassWebGPU /> in your scene with <GrassCullingDebug />
 */
export function GrassCullingDebug() {
  // Player camera (used for culling calculation)
  const [playerCamera, setPlayerCamera] = useState<THREE.PerspectiveCamera | null>(null)
  const [helper, setHelper] = useState<THREE.CameraHelper | null>(null)

  // Initialize player camera
  useEffect(() => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50)
    camera.position.set(0, 5, 20)
    camera.lookAt(0, 0, 0)
    setPlayerCamera(camera)

    // Create camera helper
    const cameraHelper = new THREE.CameraHelper(camera)
    setHelper(cameraHelper)

    return () => {
      cameraHelper.dispose()
    }
  }, [])

  // Animate player camera to simulate player movement
  useFrame(({ clock, viewport }) => {
    if (playerCamera) {
      const t = clock.getElapsedTime() * 0.5
      // Make player camera orbit around the scene
      const radius = 20
      const height = 5
      playerCamera.position.set(
        Math.sin(t) * radius,
        height,
        Math.cos(t) * radius
      )
      playerCamera.lookAt(0, 0, 0)
      // Update aspect ratio based on viewport
      playerCamera.aspect = viewport.width / viewport.height
      playerCamera.updateProjectionMatrix()
      playerCamera.updateMatrixWorld()

      // Update helper
      if (helper) {
        helper.update()
      }
    }
  })

  return (
    <>
      {/* God Camera: Free camera controlled by OrbitControls (what you see) */}
      <CameraControls makeDefault dollySpeed={0.5} />

      {/* Visualize player camera frustum (yellow wireframe) */}
      {helper && <primitive object={helper} />}


      {/* Grass system uses player camera for culling */}
      <GrassWebGPU 
        cullCamera={playerCamera ?? undefined}
      />

      {/* Grid helper for reference */}
      {/* <gridHelper args={[100, 100]} /> */}
    </>
  )
}
