import { useRef, useMemo, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { uniform, instancedBufferAttribute, Fn, uv, vec3, float, length, smoothstep, mx_hsvtorgb, mx_rgbtohsv, fract, sin, PI2, vec4 } from 'three/tsl';
import { useControls } from 'leva';
import { CameraMode, useGameStore } from '../../core/store/gameStore';
import { uTime, uStarIntensity } from '../../core/shaders/uniforms';

interface StarsProps {
  count?: number;
  radius?: number;
  speed?: number;
  axis?: [number, number, number];
}

export function Stars({
  count = 500,
  radius = 190,
  speed = 2,
  axis = [0.2, 1, 0],
}: StarsProps) {
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const cameraMode = useGameStore((state) => state.cameraMode);

  const uniforms = useMemo(() => ({
    uScale: uniform(0.25),
    uColor: uniform(new THREE.Color('#bbd0f5')),
    uHueVar: uniform(0.1),
    uRim: uniform(0.95),
    uSpeed: uniform(2),
    uIntensity: uniform(1),
  }), []);

  const { rim } = useControls('Stars', {
    scale: {
      value: 0.5, min: 0, max: 1, step: 0.01,
      onChange: (v) => (uniforms.uScale.value = v)
    },
    baseColor: {
      value: '#bbd0f5',
      onChange: (v) => uniforms.uColor.value.set(v)
    },
    hueVariation: {
      value: 0.1, min: 0, max: 1, step: 0.01,
      onChange: (v) => (uniforms.uHueVar.value = v)
    },
    rim: {
      value: 0.95, min: 0, max: 1, step: 0.01,
    },
    speed: {
      value: 4, min: 0, max: 10, step: 0.01,
      onChange: (v) => (uniforms.uSpeed.value = v)
    },
  }, { collapsed: true });

  const { positionAttribute, seedAttribute } = useMemo(() => {
    const pos = [];
    const seedArray = [];

    const rimMin = radius * rim;
    const rimMax = radius;
    const rimThickness = rimMax - rimMin;

    for (let i = 0; i < count; i++) {
      const seed = Math.random();
      seedArray.push(seed);

      let x, y, z, len;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        len = Math.sqrt(x * x + y * y + z * z);
      } while (len > 1 || len === 0);

      const r = rimMin + Math.random() * rimThickness;
      pos.push((x / len) * r, (Math.abs(y / len)) * r, (z / len) * r);
    }

    return {
      positionAttribute: new THREE.InstancedBufferAttribute(new Float32Array(pos), 3),
      seedAttribute: new THREE.InstancedBufferAttribute(new Float32Array(seedArray), 1),
    };
  }, [count, radius, rim]);

  const material = useMemo(() => {
    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const seed = instancedBufferAttribute(seedAttribute);
    mat.positionNode = instancedBufferAttribute(positionAttribute);
        // 2026-10-19：星星是天体，不吃雾（半径 190 m，被雾色涂掉就成了一片雾斑）
        mat.fog = false;


    const sizeVar = seed.mul(0.5).add(1);
    mat.scaleNode = uniforms.uScale.mul(sizeVar);


    const baseRGB = uniforms.uColor
    const baseHSV = mx_rgbtohsv(baseRGB);
    const hueShifted = fract(baseHSV.x.add(seed.mul(float(uniforms.uHueVar))));

    // Blink
    const timePhase = uTime.add(seed.mul(PI2)).mul(uniforms.uSpeed);
    const brightAnim = sin(timePhase).mul(float(0.3)).add(float(0.7));

    const finalHsv = vec3(hueShifted, baseHSV.y, baseHSV.z.mul(brightAnim));
    // ★ 乘上昼夜的星空浓度：白天星星要灭掉（`uStarIntensity` 由 sunCycle 每帧写）
    const finalColor = mx_hsvtorgb(finalHsv).mul(uniforms.uIntensity).mul(uStarIntensity);

    const shape = Fn(() => {
      const d = length(uv().sub(0.5));
      return smoothstep(float(0.5), float(0.3), d);
    })();

    mat.colorNode = vec4(finalColor, shape);

    return mat;
  }, []);

  const sprite = useMemo(() => {
    const s = new THREE.Sprite(material);
    s.count = count;
    s.frustumCulled = false;

    // Set seed attribute on the sprite's geometry
    if (s.geometry) {
      s.geometry.setAttribute('seed', seedAttribute);
    }

    return s;
  }, [material, count, seedAttribute, positionAttribute]);

  // Reuse rotation axis vector to avoid GC
  const rotationAxis = useMemo(() => new THREE.Vector3(axis[0], axis[1], axis[2]), [axis]);

  useEffect(() => {
    uniforms.uIntensity.value =  cameraMode === CameraMode.FPV ? 10 : 1
  }, [cameraMode])

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.position.copy(camera.position);
      // ★ 用 `uTime` 而不是 `clock.elapsedTime`：`uTime` 在 `?tfreeze=` 下被
      //   `WorldController.tsx:158` 钉死成常数（`uTime.value = T_FREEZE`），
      //   而墙钟时间每次截图都不一样 —— 星空整体转一个角度就能让
      //   「同参数两张图」差出 5% 像素，把真正的差异淹掉。
      //   （`clock` 参数保留只是为了不改 useFrame 的调用签名。）
      void clock;
      const angle = uTime.value * -speed;
      groupRef.current.setRotationFromAxisAngle(rotationAxis, THREE.MathUtils.DEG2RAD * angle);
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={sprite} />
    </group>
  );
}
