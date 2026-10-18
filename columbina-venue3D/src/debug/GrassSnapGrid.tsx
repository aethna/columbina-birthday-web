import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { DEFAULT_GRASS_AREA_SIZE, DEFAULT_BLADES_PER_AXIS, DEFAULT_BLADE_STEPS_PER_CELL } from '../components/grass/core/config'

const BLADE_SPACING = DEFAULT_GRASS_AREA_SIZE / DEFAULT_BLADES_PER_AXIS;
const GRID_CELL_SIZE = BLADE_SPACING * DEFAULT_BLADE_STEPS_PER_CELL;
const CELLS_VISIBLE = Math.ceil(DEFAULT_GRASS_AREA_SIZE / GRID_CELL_SIZE);

/**
 * Visualises the grass snap grid.
 * - Grey grid  : each cell = one snap step
 * - Yellow cell : the camera's current snap cell (triggers a snap when it changes)
 */
export function GrassSnapGrid() {
  const { camera } = useThree()

  const gridRef   = useRef<THREE.GridHelper>(null)
  const patchRef  = useRef<THREE.LineSegments>(null)
  const cellRef   = useRef<THREE.Mesh>(null)

  const prevCellX = useRef<number | null>(null)
  const prevCellZ = useRef<number | null>(null)
  const flashTimer = useRef(0)

  useFrame((_s, dt) => {
    const cellX = Math.floor(camera.position.x / GRID_CELL_SIZE)
    const cellZ = Math.floor(camera.position.z / GRID_CELL_SIZE)
    const snapX = cellX * GRID_CELL_SIZE
    const snapZ = cellZ * GRID_CELL_SIZE

    const snapped = cellX !== prevCellX.current || cellZ !== prevCellZ.current

    if (snapped) {
      prevCellX.current = cellX
      prevCellZ.current = cellZ
    }

    // Snap grid: follows camera cell
    if (gridRef.current) {
      gridRef.current.position.set(snapX, 0, snapZ)
    }

    // Grass patch box: snaps to same origin
    if (patchRef.current) {
      patchRef.current.position.set(snapX, 0, snapZ)
    }

    // Current camera cell highlight
    if (cellRef.current) {
      const camCellCenterX = cellX * GRID_CELL_SIZE + GRID_CELL_SIZE / 2
      const camCellCenterZ = cellZ * GRID_CELL_SIZE + GRID_CELL_SIZE / 2
      cellRef.current.position.set(camCellCenterX, 0, camCellCenterZ)
    }
  })

  return (
    <>
      {/* Background snap grid */}
      <gridHelper
        ref={gridRef}
        args={[
          GRID_CELL_SIZE * CELLS_VISIBLE,
          CELLS_VISIBLE,
          '#555555',
          '#333333',
        ]}
      />

      {/* Camera's current snap cell (yellow) */}
      <mesh ref={cellRef} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[GRID_CELL_SIZE, GRID_CELL_SIZE]} />
        <meshBasicMaterial color="#ffdd00" transparent opacity={0.25} depthWrite={false} />
      </mesh>
    </>
  )
}
