import { useMemo } from 'react';
import { useControls } from 'leva';
import { useGameStore, CameraMode } from '../../core/store/gameStore';
import { QSTR, QNUM } from '../../core/utils/query';
import { SKY_MODE } from '../../core/venuePalette';

/* URL 覆盖（无头截图专用）。判据「参数打印正确 ≠ 功能生效」：
 * 后处理是整幅画面的开关，必须在无头环境里能一档一档地关掉比对。
 *   ?dof=0|1 ?bokeh= ?focal= ?bloom=1|0 ?bloomthr= ?bloomstr= ?smaa=1 ?exposure=
 * 会场模式（`?sky` 缺省）里景深默认关 —— 老线路线A根本没有景深，
 * 开着它近处草叶会糊成一圈圈白色散景，跨路线比对无从谈起。 */
const OVR_DOF = (() => { const v = QSTR('dof'); return v === null ? null : v !== '0'; })();
const OVR_BLOOM = (() => { const v = QSTR('bloom'); return v === null ? null : v !== '0'; })();
const OVR_SMAA = (() => { const v = QSTR('smaa'); return v === null ? null : v !== '0'; })();
const OVR_BOKEH = QNUM('bokeh');
const OVR_FOCAL = QNUM('focal');
const OVR_BTHR = QNUM('bloomthr');
const OVR_BSTR = QNUM('bloomstr');
const OVR_EXPO = QNUM('exposure');

export function useEffectsControls() {
  const cameraMode = useGameStore((state) => state.cameraMode);
  const quality = useGameStore((state) => state.quality);
  const isHighQuality = quality === 'high';

  const smaaParams = useControls('Effects.SMAA', {
    enabled: { value: false, label: 'Enable SMAA' },
  }, { collapsed: true });

  const bloomParams = useControls('Effects.Bloom', {
    enabled: { value: true, label: 'Enable Bloom' },
    threshold: { value: 0.35, min: 0, max: 1, step: 0.01 },
    strength: { value: 0.3, min: 0, max: 3, step: 0.01 },
    radius: { value: 0.5, min: 0, max: 1, step: 0.01 },
  }, { collapsed: true });

  const toneMappingParams = useControls('Effects.Tone Mapping', {
    enabled: { value: true, label: 'Enable Tone Mapping' },
    exposure: { value: 1.1, min: 0.1, max: 2, step: 0.01 },
  }, { collapsed: true });

  const dofParamsTPS = useControls('Effects.DoF.TPS', {
    enabled: { value: true, label: 'Enable Depth of Field' },
    autofocus: { value: true, label: 'Auto Focus Character' },
    focusDistance: { value: 1.3, min: 0, max: 100, step: 0.1, render: (get) => !get('Effects.DoF.TPS.autofocus') },
    focalLength: { value: 25.0, min: 0.01, max: 100, step: 0.1 },
    bokehScale: { value: 5, min: 0.0, max: 10.0, step: 0.1 },
  }, { collapsed: true });

  const dofParamsFREE = useControls('Effects.DoF.FREE', {
    enabled: { value: true, label: 'Enable Depth of Field' },
    autofocus: { value: false, label: 'Auto Focus Character' },
    focusDistance: { value: 5, min: 0, max: 100, step: 0.1, render: (get) => !get('Effects.DoF.FREE.autofocus') },
    focalLength: { value: 10.0, min: 0.01, max: 100, step: 0.1 },
    bokehScale: { value: 5, min: 0.0, max: 10.0, step: 0.1 },
  }, { collapsed: true });

  const dofParamsFPV = useControls('Effects.DoF.FPV', {
    enabled: { value: false, label: 'Enable Depth of Field' },
    autofocus: { value: false, label: 'Auto Focus Character' },
    focusDistance: { value: 10, min: 0, max: 100, step: 0.1, render: (get) => !get('Effects.DoF.FPV.autofocus') },
    focalLength: { value: 50.0, min: 0.01, max: 100, step: 0.1 },
    bokehScale: { value: 3, min: 0.0, max: 10.0, step: 0.1 },
  }, { collapsed: true });

  const dof = useMemo(() => {
    let d;
    switch (cameraMode) {
      case CameraMode.FPV:
        d = {
          enabled: dofParamsFPV.enabled,
          autofocus: dofParamsFPV.autofocus,
          focusDistance: dofParamsFPV.focusDistance,
          focalLength: dofParamsFPV.focalLength,
          bokehScale: dofParamsFPV.bokehScale,
        };
        break;
      case CameraMode.Detached:
        d = {
          enabled: dofParamsFREE.enabled,
          autofocus: dofParamsFREE.autofocus,
          focusDistance: dofParamsFREE.focusDistance,
          focalLength: dofParamsFREE.focalLength,
          bokehScale: dofParamsFREE.bokehScale,
        };
        break;
      case CameraMode.Follow:
      default:
        d = {
          enabled: dofParamsTPS.enabled,
          autofocus: dofParamsTPS.autofocus,
          focusDistance: dofParamsTPS.focusDistance,
          focalLength: dofParamsTPS.focalLength,
          bokehScale: dofParamsTPS.bokehScale,
        };
        break;
    }
    if (OVR_DOF !== null) d.enabled = OVR_DOF;
    else if (SKY_MODE !== 'fe') d.enabled = false;
    if (OVR_BOKEH !== null) d.bokehScale = OVR_BOKEH;
    if (OVR_FOCAL !== null) d.focalLength = OVR_FOCAL;
    return d;
  }, [cameraMode, dofParamsTPS, dofParamsFREE, dofParamsFPV]);

  return {
    isHighQuality,
    cameraMode,
    smaa: OVR_SMAA ?? smaaParams.enabled,
    bloom: {
      enabled: OVR_BLOOM ?? bloomParams.enabled,
      threshold: OVR_BTHR ?? bloomParams.threshold,
      strength: OVR_BSTR ?? bloomParams.strength,
      radius: bloomParams.radius,
    },
    toneMapping: {
      enabled: toneMappingParams.enabled,
      exposure: OVR_EXPO ?? toneMappingParams.exposure,
    },
    dof,
  };
}
