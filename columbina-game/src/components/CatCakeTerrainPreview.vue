<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  AO_LIGHT_LEVELS,
  sameAmbientOcclusion,
  topFaceAmbientOcclusion,
} from '../games/catCakeRace/terrainShading.js'

const props = defineProps({
  map: { type: Object, required: true },
  modelUrl: { type: String, required: true },
  spriteUrl: { type: String, required: true },
  springModelUrl: { type: String, required: true },
  pistonModelUrl: { type: String, required: true },
  spikeModelUrl: { type: String, required: true },
  bombModelUrl: { type: String, required: true },
  contestants: { type: Array, default: () => [] },
  focusPosition: { type: Object, default: null },
  mechanismEvents: { type: Array, default: () => [] },
  live: { type: Boolean, default: false },
})

const canvas = ref(null)
const previewShell = ref(null)
let renderer
let scene
let camera
let terrainMesh
let terrainSprite
let spriteTexture
const catSpriteGroups = new Map()
let processedMechanismEvents = 0
let cameraFocusZ = 0
let modelSize = { x: 1, y: 1.125, z: 1.125 }
const mechanismAssets = { spring: null, piston: null, spikes: null, bomb: null }
const mechanismInstances = []
let resizeObserver
let animationFrame = 0
let isUnmounted = false

const TOP = new THREE.Color('#b891bb')
const SIDE = new THREE.Color('#714d72')
const CLIFF = new THREE.Color('#4d3658')
const SPIKE_TOP = new THREE.Color('#d95f72')
const SPIKE_SIDE = new THREE.Color('#87384b')
const SPIKE_CLIFF = new THREE.Color('#5a2436')
const GLUE_TOP = new THREE.Color('#858b94')
const GLUE_SIDE = new THREE.Color('#5d646e')
const GLUE_CLIFF = new THREE.Color('#3f464f')
const CHECKPOINT = new THREE.Color('#c1a4d4')
const START = new THREE.Color('#9ecfe0')
const FINISH = new THREE.Color('#e8c68d')
const NORMAL_PALETTES = Object.freeze({
  'normal-lilac': Object.freeze({ top: new THREE.Color('#b891bb'), accent: new THREE.Color('#d4a9cf'), side: new THREE.Color('#714d72'), cliff: new THREE.Color('#4d3658') }),
  'normal-sky': Object.freeze({ top: new THREE.Color('#8fb9d2'), accent: new THREE.Color('#b6d8df'), side: new THREE.Color('#587d98'), cliff: new THREE.Color('#3b566e') }),
  'normal-mint': Object.freeze({ top: new THREE.Color('#8fc4b1'), accent: new THREE.Color('#b7ddc1'), side: new THREE.Color('#548875'), cliff: new THREE.Color('#385d53') }),
  'normal-sand': Object.freeze({ top: new THREE.Color('#d1b27e'), accent: new THREE.Color('#ebd29d'), side: new THREE.Color('#94764e'), cliff: new THREE.Color('#654f38') }),
  'normal-rose': Object.freeze({ top: new THREE.Color('#c995a8'), accent: new THREE.Color('#e2b8bd'), side: new THREE.Color('#895e70'), cliff: new THREE.Color('#603f50') }),
  'normal-height': Object.freeze({ top: new THREE.Color('#d3a76f'), accent: new THREE.Color('#f0c991'), side: new THREE.Color('#966d43'), cliff: new THREE.Color('#63472e') }),
  'normal-start': Object.freeze({ top: START, accent: new THREE.Color('#b7e2df'), side: new THREE.Color('#5d8fa5'), cliff: new THREE.Color('#3c6072') }),
  'normal-checkpoint': Object.freeze({ top: CHECKPOINT, accent: new THREE.Color('#e0c4e8'), side: new THREE.Color('#806696'), cliff: new THREE.Color('#544267') }),
  'normal-finish': Object.freeze({ top: FINISH, accent: new THREE.Color('#f4dfac'), side: new THREE.Color('#a47d4b'), cliff: new THREE.Color('#705331') }),
})

function mechanismKind(tile) {
  if (['b', 't'].includes(tile?.symbol)) return 'bomb'
  if (tile?.symbol === '^') return 'spikes'
  if (['u', 'w', 'x'].includes(tile?.symbol)) return 'spring'
  if (['R', 'L', 'P', 'D'].includes(tile?.symbol)) return 'piston'
  return null
}

function usesMechanismAsset(tile) {
  const kind = mechanismKind(tile)
  // Bombs float and pistons stand on top of a complete ground block. Springs
  // and spikes still replace the uppermost terrain cube.
  return Boolean(kind && !['bomb', 'piston'].includes(kind) && mechanismAssets[kind])
}

function terrainStyle(tile) {
  if (tile?.mechanism?.type === 'glue') return 'glue'
  return tile?.symbol === '^' ? 'spikes-disabled' : 'normal'
}

function normalTerrainStyle(tile) {
  if (tile?.isStart) return 'normal-start'
  if (tile?.isFinish) return 'normal-finish'
  if (tile?.isCheckpoint) return 'normal-checkpoint'
  if (tile?.baseHeight >= 2) return 'normal-height'
  if (tile?.baseHeight === 0) return 'normal-mint'
  const band = Math.floor((tile?.position?.x ?? 0) / 3) + Math.floor((tile?.position?.y ?? 0) / 5)
  return ['normal-lilac', 'normal-sky', 'normal-sand', 'normal-rose'][band % 4]
}

function resolvedTerrainStyle(tile) {
  const style = terrainStyle(tile)
  return style === 'normal' ? normalTerrainStyle(tile) : style
}

function paletteForStyle(style) {
  return NORMAL_PALETTES[style] ?? null
}

function topColorForTile(tile) {
  const style = resolvedTerrainStyle(tile)
  if (style === 'glue') return GLUE_TOP
  if (style === 'spikes-disabled') return SPIKE_TOP
  return paletteForStyle(style)?.top ?? TOP
}

function topColorsForTile(tile, heightColor, ambientOcclusion) {
  const style = resolvedTerrainStyle(tile)
  const palette = paletteForStyle(style)
  if (!palette?.accent) return ambientOcclusion.map((level) => shadeColor(heightColor, AO_LIGHT_LEVELS[level]))

  // A soft four-corner blend gives one ordinary tile a small secondary color
  // without introducing outlines or changing its gameplay/material category.
  const accentStrengths = [0.24, 0.08, 0.18, 0.03]
  return ambientOcclusion.map((level, index) => {
    const mixed = heightColor.clone().lerp(palette.accent, accentStrengths[index])
    return shadeColor(mixed, AO_LIGHT_LEVELS[level])
  })
}

function heightAt(map, x, z) {
  if (x < 0 || x >= map.width || z < 0 || z >= map.height) return 0
  const tile = map.tiles[z][x]
  // H0 is still a playable ground block; only pits and walls leave a gap.
  if (!tile || tile.terrainType === 'pit' || tile.terrainType === 'wall') return 0
  return Math.max(1, tile.baseHeight + 1)
}

function colorBrightness(color) {
  return color.r + color.g + color.b
}

function pushQuad(positions, normals, colors, a, b, c, d, normal, color) {
  const quadColors = Array.isArray(color) ? color : [color, color, color, color]
  // AO-aware diagonal selection avoids a bright/dark seam across non-uniform quads.
  const flipDiagonal = colorBrightness(quadColors[0]) + colorBrightness(quadColors[2])
    < colorBrightness(quadColors[1]) + colorBrightness(quadColors[3])
  const indices = flipDiagonal ? [0, 1, 3, 1, 2, 3] : [0, 1, 2, 0, 2, 3]
  const points = [a, b, c, d]
  for (const index of indices) positions.push(...points[index])
  for (let i = 0; i < 6; i += 1) normals.push(...normal)
  for (const index of indices) {
    const vertexColor = quadColors[index]
    colors.push(vertexColor.r, vertexColor.g, vertexColor.b)
  }
}

function shadeColor(baseColor, lightLevel) {
  return baseColor.clone().multiplyScalar(lightLevel)
}

function sideDirectionalLight(normal) {
  // Matches the horizontal direction of the main light at (-18, 24, 22).
  const facingLight = Math.max(0, normal[0] * -0.633 + normal[2] * 0.774)
  return 0.7 + facingLight * 0.28
}

function topAo(map, x, z, height) {
  return topFaceAmbientOcclusion(map, x, z, height, heightAt)
}

function buildTerrainGeometry(map) {
  const positions = []
  const normals = []
  const colors = []
  const unitHeight = modelSize.y / modelSize.x
  const width = map.width
  const depth = map.height

  // Merge coplanar, same-height top faces into rectangles so the interior never gets a seam.
  const visited = Array.from({ length: depth }, () => Array(width).fill(false))
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const height = heightAt(map, x, z)
      if (!height || visited[z][x] || usesMechanismAsset(map.tiles[z][x])) {
        visited[z][x] = true
        continue
      }
      const ambientOcclusion = topAo(map, x, z, height)
       const style = resolvedTerrainStyle(map.tiles[z][x])
      let rectangleWidth = 1
      while (
        x + rectangleWidth < width
        && !visited[z][x + rectangleWidth]
        && !usesMechanismAsset(map.tiles[z][x + rectangleWidth])
        && heightAt(map, x + rectangleWidth, z) === height
        && resolvedTerrainStyle(map.tiles[z][x + rectangleWidth]) === style
        && sameAmbientOcclusion(topAo(map, x + rectangleWidth, z, height), ambientOcclusion)
      ) rectangleWidth += 1
      let rectangleDepth = 1
      let canGrow = true
      while (z + rectangleDepth < depth && canGrow) {
        for (let column = 0; column < rectangleWidth; column += 1) {
          if (
            visited[z + rectangleDepth][x + column]
            || usesMechanismAsset(map.tiles[z + rectangleDepth][x + column])
            || heightAt(map, x + column, z + rectangleDepth) !== height
            || resolvedTerrainStyle(map.tiles[z + rectangleDepth][x + column]) !== style
            || !sameAmbientOcclusion(topAo(map, x + column, z + rectangleDepth, height), ambientOcclusion)
          ) {
            canGrow = false
            break
          }
        }
        if (canGrow) rectangleDepth += 1
      }
      for (let row = 0; row < rectangleDepth; row += 1) {
        for (let column = 0; column < rectangleWidth; column += 1) visited[z + row][x + column] = true
      }
      const top = height * unitHeight
      const heightLight = 1 + Math.max(0, height - 1) * 0.07
      const heightColor = shadeColor(topColorForTile(map.tiles[z][x]), heightLight)
       const bakedTopColors = topColorsForTile(map.tiles[z][x], heightColor, ambientOcclusion)
      pushQuad(
        positions,
        normals,
        colors,
        [x, top, z],
        [x + rectangleWidth, top, z],
        [x + rectangleWidth, top, z + rectangleDepth],
        [x, top, z + rectangleDepth],
        [0, 1, 0],
        bakedTopColors,
      )
    }
  }

  // Only add exposed side faces. A height change produces a natural step/cliff.
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const height = heightAt(map, x, z)
      if (!height) continue
      const top = (height - (usesMechanismAsset(map.tiles[z][x]) ? 1 : 0)) * unitHeight
      const sideEdges = [
        { neighbor: heightAt(map, x - 1, z), a: [x, 0, z], b: [x, 0, z + 1], c: [x, top, z + 1], d: [x, top, z], normal: [-1, 0, 0] },
        { neighbor: heightAt(map, x + 1, z), a: [x + 1, 0, z + 1], b: [x + 1, 0, z], c: [x + 1, top, z], d: [x + 1, top, z + 1], normal: [1, 0, 0] },
        { neighbor: heightAt(map, x, z - 1), a: [x + 1, 0, z], b: [x, 0, z], c: [x, top, z], d: [x + 1, top, z], normal: [0, 0, -1] },
        { neighbor: heightAt(map, x, z + 1), a: [x, 0, z + 1], b: [x + 1, 0, z + 1], c: [x + 1, top, z + 1], d: [x, top, z + 1], normal: [0, 0, 1] },
      ]
      for (const edge of sideEdges) {
        if (edge.neighbor >= height) continue
        const bottom = edge.neighbor * unitHeight
        if (top <= bottom) continue
        edge.a[1] = bottom
        edge.b[1] = bottom
        const style = resolvedTerrainStyle(map.tiles[z][x])
        const isSpikes = style === 'spikes-disabled'
        const isGlue = style === 'glue'
        const normalPalette = paletteForStyle(style)
        const sideColor = normalPalette
          ? (edge.neighbor ? normalPalette.side : normalPalette.cliff)
          : isGlue
          ? (edge.neighbor ? GLUE_SIDE : GLUE_CLIFF)
          : isSpikes
            ? (edge.neighbor ? SPIKE_SIDE : SPIKE_CLIFF)
            : (edge.neighbor ? SIDE : CLIFF)
        const baseColor = shadeColor(sideColor, sideDirectionalLight(edge.normal))
        const heightDifference = Math.max(1, height - edge.neighbor)
        const bottomLight = Math.max(0.48, 0.78 - heightDifference * 0.1)
        // Static vertical gradient adapted from the MIT-licensed voxel-fakeao approach.
        pushQuad(
          positions,
          normals,
          colors,
          edge.a,
          edge.b,
          edge.c,
          edge.d,
          edge.normal,
          [shadeColor(baseColor, bottomLight), shadeColor(baseColor, bottomLight), baseColor, baseColor],
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}

function centerStandableTile(map) {
  const centerX = (map.width - 1) / 2
  const centerZ = (map.height - 1) / 2
  return map.flatTiles
    .filter((tile) => heightAt(map, tile.position.x, tile.position.y) > 0 && !mechanismKind(tile))
    .sort((a, b) => {
      const distanceA = (a.position.x - centerX) ** 2 + (a.position.y - centerZ) ** 2
      const distanceB = (b.position.x - centerX) ** 2 + (b.position.y - centerZ) ** 2
      return distanceA - distanceB
    })[0]
}

function addCenterSprite(map) {
  if (!spriteTexture || props.contestants.length > 0) return
  const tile = centerStandableTile(map)
  if (!tile) return
  const spriteSize = 1.55
  const top = heightAt(map, tile.position.x, tile.position.y) * (modelSize.y / modelSize.x)
  terrainSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: spriteTexture,
    transparent: true,
    depthWrite: false,
  }))
  terrainSprite.scale.set(spriteSize, spriteSize, 1)
  terrainSprite.position.set(
    tile.position.x + 0.5 - map.width / 2,
    top + spriteSize / 2,
    tile.position.y + 0.5 - map.height / 2,
  )
  scene.add(terrainSprite)
}

function clearCatSprites() {
  catSpriteGroups.forEach((group) => {
    scene.remove(group)
    group.traverse((object) => {
      object.geometry?.dispose()
      object.material?.dispose()
    })
  })
  catSpriteGroups.clear()
}

function addCatSprite(cat) {
  if (!spriteTexture || catSpriteGroups.has(cat.id)) return
  const group = new THREE.Group()
  const spriteSize = cat.controllerType === 'player' ? 1.5 : 1.34
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: spriteTexture,
    color: cat.controllerType === 'player' ? '#ffffff' : cat.color,
    transparent: true,
    depthWrite: false,
  }))
  sprite.scale.set(spriteSize, spriteSize, 1)
  sprite.renderOrder = cat.controllerType === 'player' ? 5 : 4
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.38, 24),
    new THREE.MeshBasicMaterial({
      color: cat.color,
      transparent: true,
      opacity: cat.controllerType === 'player' ? 0.95 : 0.62,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  marker.rotation.x = -Math.PI / 2
  marker.position.y = -spriteSize / 2 + 0.03
  group.add(marker, sprite)
  group.userData = { catId: cat.id, lastPositionKey: null, movedAt: 0, spriteSize }
  scene.add(group)
  catSpriteGroups.set(cat.id, group)
}

function syncCatSprites(timeMs) {
  if (!props.contestants.length || !spriteTexture) return
  const liveIds = new Set(props.contestants.map((cat) => cat.id))
  catSpriteGroups.forEach((group, id) => {
    if (liveIds.has(id)) return
    scene.remove(group)
    catSpriteGroups.delete(id)
  })
  const unitHeight = modelSize.y / modelSize.x
  props.contestants.forEach((cat) => {
    addCatSprite(cat)
    const group = catSpriteGroups.get(cat.id)
    group.visible = cat.actionState !== 'respawning'
    if (!group.visible) return
    const key = `${cat.position.x},${cat.position.y},${cat.stack.role}`
    if (group.userData.lastPositionKey !== key) {
      group.userData.lastPositionKey = key
      group.userData.movedAt = timeMs
    }
    const top = heightAt(props.map, cat.position.x, cat.position.y) * unitHeight
    const elapsed = Math.min(1, (timeMs - group.userData.movedAt) / 300)
    const jump = Math.sin(elapsed * Math.PI) * 0.42
    const stackOffset = cat.stack.role === 'top' ? 0.72 : 0
    const target = new THREE.Vector3(
      cat.position.x + 0.5 - props.map.width / 2,
      top + group.userData.spriteSize / 2 + stackOffset + jump,
      cat.position.y + 0.5 - props.map.height / 2,
    )
    if (group.position.lengthSq() === 0) group.position.copy(target)
    else group.position.lerp(target, 0.28)
  })
}

function disposeScene(root) {
  const materials = new Set()
  root.traverse((object) => {
    if (!object.isMesh) return
    object.geometry?.dispose()
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
    meshMaterials.filter(Boolean).forEach((material) => materials.add(material))
  })
  materials.forEach((material) => material.dispose())
}

function bakeCurrentFrame(root, sourceMaterials, normalizer) {
  root.updateMatrixWorld(true)
  const geometriesByMaterial = sourceMaterials.map(() => [])
  root.traverse((object) => {
    if (!object.isMesh || Array.isArray(object.material)) return
    const materialIndex = sourceMaterials.indexOf(object.material)
    if (materialIndex < 0) return
    const geometry = object.geometry.clone()
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(normalizer, object.matrixWorld))
    geometriesByMaterial[materialIndex].push(geometry)
  })
  return geometriesByMaterial.map((geometries) => {
    if (!geometries.length) return null
    const merged = mergeGeometries(geometries, false)
    geometries.forEach((geometry) => geometry.dispose())
    return merged
  })
}

function loadBakedAsset(url, palette) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => {
      const root = gltf.scene
      root.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(root)
      const center = bounds.getCenter(new THREE.Vector3())
      const size = bounds.getSize(new THREE.Vector3())
      const normalizer = new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z)
      const sourceMaterials = []
      root.traverse((object) => {
        if (!object.isMesh || Array.isArray(object.material)) return
        if (!sourceMaterials.includes(object.material)) sourceMaterials.push(object.material)
      })
      const materials = sourceMaterials.map((source, index) => {
        const material = source.clone()
        material.color.set(palette[index] ?? palette.at(-1))
        material.roughness = 0.88
        material.metalness = 0
        material.flatShading = true
        material.needsUpdate = true
        return material
      })
      const clip = gltf.animations[0]
      const frameCount = clip ? 12 : 1
      const mixer = clip ? new THREE.AnimationMixer(root) : null
      if (clip) {
        const action = mixer.clipAction(clip)
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
        action.play()
      }
      const frames = Array.from({ length: frameCount }, (_, index) => {
        if (mixer) mixer.setTime((index / (frameCount - 1)) * clip.duration)
        return bakeCurrentFrame(root, sourceMaterials, normalizer)
      })
      mixer?.stopAllAction()
      disposeScene(root)
      resolve({ duration: clip?.duration ?? 1, frames, materials, size })
    }, undefined, reject)
  })
}

function emphasizeSpikeTips(asset) {
  const firstFrame = asset.frames[0]
  let tipMaterialIndex = -1
  let highestMinimumY = -Infinity
  firstFrame.forEach((geometry, index) => {
    if (!geometry) return
    geometry.computeBoundingBox()
    if (geometry.boundingBox.min.y > highestMinimumY) {
      highestMinimumY = geometry.boundingBox.min.y
      tipMaterialIndex = index
    }
  })
  if (tipMaterialIndex < 0) return asset
  asset.frames.forEach((frame) => {
    const geometry = frame[tipMaterialIndex]
    if (!geometry) return
    geometry.computeBoundingBox()
    const spikeBaseY = geometry.boundingBox.min.y
    const positions = geometry.getAttribute('position')
    for (let index = 0; index < positions.count; index += 1) {
      positions.setY(index, spikeBaseY + (positions.getY(index) - spikeBaseY) * 1.75)
    }
    positions.needsUpdate = true
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
  })
  const tipMaterial = asset.materials[tipMaterialIndex]
  tipMaterial.color.set('#ff3658')
  tipMaterial.emissive?.set('#3d050c')
  tipMaterial.emissiveIntensity = 0.24
  tipMaterial.needsUpdate = true
  return asset
}

function disposeBakedAsset(asset) {
  if (!asset) return
  const geometries = new Set(asset.frames.flat().filter(Boolean))
  geometries.forEach((geometry) => geometry.dispose())
  asset.materials.forEach((material) => material.dispose())
}

function clearMechanisms() {
  while (mechanismInstances.length) {
    const instance = mechanismInstances.pop()
    scene.remove(instance.group)
    if (instance.effect) {
      scene.remove(instance.effect)
      instance.effect.traverse((object) => {
        if (!object.isMesh) return
        object.geometry.dispose()
        object.material.dispose()
      })
    }
  }
}

function pistonRotation(symbol) {
  return ({ P: Math.PI, D: 0, R: Math.PI / 2, L: -Math.PI / 2 })[symbol] ?? 0
}

function createBombExplosionEffect() {
  const effect = new THREE.Group()
  effect.visible = false
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.24, 28),
    new THREE.MeshBasicMaterial({ color: '#bd7bff', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  )
  ring.rotation.x = -Math.PI / 2
  const pulse = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.34, 1),
    new THREE.MeshBasicMaterial({ color: '#f0c8ff', transparent: true, opacity: 0, depthWrite: false, wireframe: true, blending: THREE.AdditiveBlending }),
  )
  effect.add(ring, pulse)
  effect.userData = { ring, pulse }
  return effect
}

function addMechanisms(map) {
  const unitHeight = modelSize.y / modelSize.x
  for (const tile of map.flatTiles) {
    const kind = mechanismKind(tile)
    const asset = mechanismAssets[kind]
    if (!asset) continue
    const group = new THREE.Group()
    const meshes = asset.materials.map((material, index) => {
      const geometry = asset.frames[0][index]
      if (!geometry) return null
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = true
      mesh.castShadow = !material.transparent
      mesh.receiveShadow = true
      group.add(mesh)
      return mesh
    })
    if (kind === 'bomb') {
      const scale = 0.72 / asset.size.x
      group.scale.setScalar(scale)
    } else {
      const scaleY = kind === 'spikes' ? unitHeight / modelSize.y : unitHeight / asset.size.y
      group.scale.set(1 / asset.size.x, scaleY, 1 / asset.size.z)
    }
    if (kind === 'piston') group.rotation.y = pistonRotation(tile.symbol)
    const top = heightAt(map, tile.position.x, tile.position.y) * unitHeight
    const baseY = kind === 'bomb'
      ? top + 0.28
      : kind === 'piston'
        ? top + 0.002
        : top - unitHeight + 0.002
    group.position.set(
      tile.position.x + 0.5 - map.width / 2,
      baseY,
      tile.position.y + 0.5 - map.height / 2,
    )
    scene.add(group)
    const effect = kind === 'bomb' ? createBombExplosionEffect() : null
    if (effect) {
      effect.position.set(group.position.x, top + 0.64, group.position.z)
      scene.add(effect)
    }
    mechanismInstances.push({
      asset,
      baseY,
      currentFrame: 0,
      effect,
      effectStartedAt: null,
      group,
      kind,
      meshes,
      nextExplosionAt: kind === 'bomb' ? performance.now() + 10_000 : null,
      animationStartedAt: null,
      phase: ((tile.position.x * 3 + tile.position.y) % 7) * 0.08,
      tilePosition: tile.position.clone(),
    })
  }
}

function syncMechanismEvents(timeMs) {
  if (props.mechanismEvents.length < processedMechanismEvents) processedMechanismEvents = 0
  const events = props.mechanismEvents.slice(processedMechanismEvents)
  processedMechanismEvents = props.mechanismEvents.length
  events.forEach((event) => {
    const mechanismKindByEvent = {
      'piston-activation': 'piston',
      'spring-activation': 'spring',
    }
    const eventKind = mechanismKindByEvent[event.type]
    if (eventKind) {
      const instance = mechanismInstances.find((candidate) => (
        candidate.kind === eventKind
        && candidate.tilePosition.x === event.position.x
        && candidate.tilePosition.y === event.position.y
      ))
      if (instance) instance.animationStartedAt = timeMs
      return
    }
    if (event.type !== 'tractor-bomb-explosion') return
    const instance = mechanismInstances.find((candidate) => (
      candidate.kind === 'bomb'
      && candidate.tilePosition.x === event.position.x
      && candidate.tilePosition.y === event.position.y
    ))
    if (instance) instance.effectStartedAt = timeMs
  })
}

function updateMechanismFrames(timeMs) {
  for (const instance of mechanismInstances) {
    const { asset } = instance
    let frame = instance.currentFrame
    if (instance.kind === 'piston' || instance.kind === 'spring') {
      if (instance.animationStartedAt === null) {
        frame = 0
      } else {
        const progress = Math.min(1, (timeMs - instance.animationStartedAt) / (asset.duration * 1000))
        frame = Math.round(progress * (asset.frames.length - 1))
        if (progress >= 1) {
          instance.animationStartedAt = null
          frame = 0
        }
      }
    } else if (instance.kind !== 'bomb') {
      const cycle = asset.duration * 2
      const elapsed = (timeMs / 1000 + instance.phase) % cycle
      const localTime = elapsed <= asset.duration ? elapsed : cycle - elapsed
      frame = Math.round((localTime / asset.duration) * (asset.frames.length - 1))
    }
    if (frame === instance.currentFrame) continue
    instance.meshes.forEach((mesh, index) => {
      if (mesh) mesh.geometry = asset.frames[frame][index]
    })
    instance.currentFrame = frame
  }
  for (const instance of mechanismInstances) {
    if (instance.kind !== 'bomb') continue
    instance.group.position.y = instance.baseY + Math.sin(timeMs * 0.002 + instance.phase * 8) * 0.1
    instance.group.rotation.y = timeMs * 0.00035 + instance.phase
    if (!props.live && timeMs >= instance.nextExplosionAt) {
      instance.effectStartedAt = timeMs
      instance.nextExplosionAt = timeMs + 10_000
    }
    if (instance.effectStartedAt === null) continue
    const progress = (timeMs - instance.effectStartedAt) / 850
    if (progress >= 1) {
      instance.effect.visible = false
      instance.effectStartedAt = null
      continue
    }
    const { ring, pulse } = instance.effect.userData
    instance.effect.visible = true
    const easeOut = 1 - (1 - progress) ** 3
    ring.scale.setScalar(1 + easeOut * 6)
    ring.material.opacity = (1 - progress) * 0.9
    pulse.scale.setScalar(0.55 + easeOut * 4)
    pulse.material.opacity = (1 - progress) * 0.72
  }
}

async function loadMechanismAssets() {
  const results = await Promise.allSettled([
    loadBakedAsset(props.springModelUrl, ['#d3a5dc']),
    loadBakedAsset(props.pistonModelUrl, ['#4099b3', '#f0b44f']),
    loadBakedAsset(props.spikeModelUrl, ['#a9364a', '#f04b62']),
    loadBakedAsset(props.bombModelUrl, ['#050508', '#8d5cff']),
  ])
  const keys = ['spring', 'piston', 'spikes', 'bomb']
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const asset = keys[index] === 'spikes' ? emphasizeSpikeTips(result.value) : result.value
      if (isUnmounted) disposeBakedAsset(asset)
      else mechanismAssets[keys[index]] = asset
    } else {
      console.warn(`无法加载${keys[index]}模型`, result.reason)
    }
  })
  if (!isUnmounted) renderTerrain()
}

function fitCamera(map) {
  const width = canvas.value.clientWidth
  const height = canvas.value.clientHeight
  const aspect = Math.max(0.5, width / Math.max(1, height))
  const tilt = 0.5
  const heightProjection = Math.sqrt(3) / 2
  const projectedWidth = map.width + 2
  const visibleDepth = props.live ? Math.min(16, map.height) : map.height
  const projectedHeight = visibleDepth * tilt + 2.5 * (modelSize.y / modelSize.x) * heightProjection + 2
  camera.left = -aspect
  camera.right = aspect
  camera.top = 1
  camera.bottom = -1
  camera.zoom = Math.min((2 * aspect) / projectedWidth, 2 / projectedHeight) * 0.9
  cameraFocusZ = props.live && props.focusPosition
    ? THREE.MathUtils.clamp(
      props.focusPosition.y + 0.5 - map.height / 2,
      -map.height / 2 + visibleDepth / 2,
      map.height / 2 - visibleDepth / 2,
    )
    : 0
  updateCameraPose(map, true)
  camera.updateProjectionMatrix()
}

function updateCameraPose(map, immediate = false) {
  const visibleDepth = props.live ? Math.min(16, map.height) : map.height
  const desiredZ = props.live && props.focusPosition
    ? THREE.MathUtils.clamp(
      props.focusPosition.y + 0.5 - map.height / 2,
      -map.height / 2 + visibleDepth / 2,
      map.height / 2 - visibleDepth / 2,
    )
    : 0
  cameraFocusZ = immediate ? desiredZ : THREE.MathUtils.lerp(cameraFocusZ, desiredZ, 0.08)
  const center = new THREE.Vector3(0, 0.6, cameraFocusZ)
  // 正面斜俯视：由 Top-down 仅沿 X 轴朝正 Z 方向倾斜30°，让较大的地图Y（底部起点）落在画面下方，Yaw和Roll保持为0。
  camera.position.set(center.x, center.y + 20, center.z + 20 * Math.tan(THREE.MathUtils.degToRad(30)))
  camera.lookAt(center)
}

function renderTerrain() {
  if (!canvas.value || !renderer || !scene || !camera) return
  if (terrainMesh) {
    terrainMesh.geometry.dispose()
    terrainMesh.material.dispose()
    scene.remove(terrainMesh)
  }
  if (terrainSprite) {
    terrainSprite.material.dispose()
    scene.remove(terrainSprite)
    terrainSprite = null
  }
  clearCatSprites()
  clearMechanisms()
  terrainMesh = new THREE.Mesh(
    buildTerrainGeometry(props.map),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0, flatShading: true, side: THREE.DoubleSide }),
  )
  terrainMesh.castShadow = true
  terrainMesh.receiveShadow = true
  terrainMesh.position.set(-props.map.width / 2, 0, -props.map.height / 2)
  scene.add(terrainMesh)
  addMechanisms(props.map)
  addCenterSprite(props.map)
  props.contestants.forEach((cat) => addCatSprite(cat))
  processedMechanismEvents = props.mechanismEvents.length
  fitCamera(props.map)
  renderer.render(scene, camera)
}

function resize() {
  if (!canvas.value || !renderer) return
  const width = Math.max(1, canvas.value.clientWidth)
  const height = Math.max(1, canvas.value.clientHeight)
  renderer.setSize(width, height, false)
  fitCamera(props.map)
  renderer.render(scene, camera)
  if (previewShell.value && previewShell.value.scrollWidth > previewShell.value.clientWidth) {
    previewShell.value.scrollLeft = (previewShell.value.scrollWidth - previewShell.value.clientWidth) / 2
  }
}

function loadModelDimensions() {
  new GLTFLoader().load(props.modelUrl, (gltf) => {
    const box = new THREE.Box3().setFromObject(gltf.scene)
    const size = box.getSize(new THREE.Vector3())
    if (size.x > 0 && size.y > 0 && size.z > 0) modelSize = { x: size.x, y: size.y, z: size.z }
    gltf.scene.traverse((object) => {
      if (!object.isMesh) return
      object.geometry?.dispose()
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose())
      else object.material?.dispose()
    })
    renderTerrain()
  })
}

onMounted(async () => {
  await nextTick()
  scene = new THREE.Scene()
  // A lower rear-left key light makes the visible front cliffs read much darker
  // than the tops and casts the high blocks' shadows toward the camera.
  scene.add(new THREE.HemisphereLight('#eadcff', '#100a24', 1.15))
  const keyLight = new THREE.DirectionalLight('#ffe8f8', 3.1)
  keyLight.position.set(-18, 24, 22)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.camera.left = -38
  keyLight.shadow.camera.right = 38
  keyLight.shadow.camera.top = 38
  keyLight.shadow.camera.bottom = -38
  keyLight.shadow.camera.near = 0.5
  keyLight.shadow.camera.far = 100
  keyLight.shadow.bias = -0.00025
  keyLight.shadow.normalBias = 0.035
  keyLight.shadow.radius = 2.5
  scene.add(keyLight)
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000)
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value)
  resize()
  renderTerrain()
  loadModelDimensions()
  loadMechanismAssets()
  new THREE.TextureLoader().load(props.spriteUrl, (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace
    spriteTexture = texture
    renderTerrain()
  })
  const animate = (timeMs) => {
    syncMechanismEvents(timeMs)
    updateMechanismFrames(timeMs)
    syncCatSprites(timeMs)
    updateCameraPose(props.map)
    renderer.render(scene, camera)
    animationFrame = requestAnimationFrame(animate)
  }
  animationFrame = requestAnimationFrame(animate)
})

watch(() => props.map, () => renderTerrain())
watch(() => props.contestants, () => syncCatSprites(performance.now()), { deep: true })

onBeforeUnmount(() => {
  isUnmounted = true
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  terrainMesh?.geometry.dispose()
  terrainMesh?.material.dispose()
  terrainSprite?.material.dispose()
  spriteTexture?.dispose()
  clearCatSprites()
  clearMechanisms()
  disposeBakedAsset(mechanismAssets.spring)
  disposeBakedAsset(mechanismAssets.piston)
  disposeBakedAsset(mechanismAssets.spikes)
  disposeBakedAsset(mechanismAssets.bomb)
  renderer?.dispose()
})
</script>

<template>
  <div ref="previewShell" class="terrain-preview-shell" aria-label="正面斜俯视合并地形预览">
    <canvas ref="canvas" class="terrain-preview-canvas" role="img" aria-label="当前地图的合并地形"></canvas>
  </div>
</template>

<style scoped>
.terrain-preview-shell{width:100%;min-width:0;height:560px;overflow:auto;border:1px solid rgba(223,238,255,.2);background:radial-gradient(circle at 50% 42%,rgba(153,111,176,.22),transparent 58%),linear-gradient(145deg,#17182c,#0c1026 72%);scrollbar-color:rgba(185,217,255,.45) rgba(7,12,31,.4)}
.terrain-preview-canvas{display:block;width:920px;min-width:920px;height:560px}
@container app (max-width:800px){.terrain-preview-shell{height:520px}.terrain-preview-canvas{width:820px;min-width:820px;height:520px}}
</style>
