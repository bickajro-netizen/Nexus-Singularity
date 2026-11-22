import { useEffect, useRef } from 'react';
import type { CharacterProfile, EnergyBatteries, RecoveryShieldState } from '../core/types';
import { SanctuaryEngine } from '../modules/sanctuary/SanctuaryEngine';
import type { SanctuaryVisualState } from '../modules/sanctuary/SanctuaryEngine';
import { mediaBlobRepository } from '../repositories/MediaBlobRepository';
import { RadarChart, SectionCard } from '../ui/widgets';

interface HeroViewProps {
  profile: CharacterProfile;
  batteries: EnergyBatteries;
  shield: RecoveryShieldState | undefined;
  quietMode: boolean;
}

const AURA_BY_BATTERY: Record<'Physical' | 'Emotional' | 'Mental' | 'Spiritual', string> = {
  Physical: '#ff6b4d',
  Emotional: '#ffd24d',
  Mental: '#4da6ff',
  Spiritual: '#b04dff',
};

function buildVisualState(batteries: EnergyBatteries, shield: RecoveryShieldState | undefined, quietMode: boolean): SanctuaryVisualState {
  const keys = ['Physical', 'Emotional', 'Mental', 'Spiritual'] as const;
  const dominant = keys.reduce((a, b) => (batteries[b] > batteries[a] ? b : a), 'Physical' as (typeof keys)[number]);
  return {
    morphTargetWeights: {
      muscle_upper: batteries.Physical / 200,
      muscle_core: batteries.Emotional / 200,
      muscle_legs: batteries.Mental / 200,
      body_lean: batteries.Spiritual / 200,
      posture_upright: 0.8,
    },
    boneScaleMultipliers: { upperArm: 1.0, forearm: 1.0, chest: 1.0, spine: 1.0, thigh: 1.0, calf: 1.0 },
    auraUniforms: {
      intensity: 0.4 + batteries.averageEnergy / 250,
      primaryColorHex: AURA_BY_BATTERY[dominant],
      secondaryColorHex: '#7a5cff',
      rimPower: 3.0,
      recoveryMix: shield?.active ? 1 : 0,
    },
    roomPropTiers: { studyDesk: 2, trainingCorner: 1 },
    stanceId: quietMode ? 'meditation_sit' : 'idle_calm',
    quietMode,
    recoveryShieldActive: !!shield?.active,
    lowPowerMode: false,
  };
}

export function HeroView({ profile, batteries, shield, quietMode }: HeroViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SanctuaryEngine | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const engine = new SanctuaryEngine(container, {
      get: (id: string) => mediaBlobRepository.get(id).then((rec) => rec?.blob),
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.updateState(buildVisualState(batteries, shield, quietMode));
  }, [batteries, shield, quietMode]);

  return (
    <div className="screen">
      <SectionCard title="Аркановое святилище">
        <div ref={containerRef} className="sanctuary-canvas" aria-label="3D-святилище" />
      </SectionCard>

      <SectionCard title="Пять добродетелей">
        <RadarChart stats={profile.stats} />
      </SectionCard>

      <SectionCard title="Щит восстановления">
        {shield?.active ? (
          <div className="shield-banner crimson">
            ⚠ Активен: {shield.reasons.join(', ')}
            {shield.quietModeSuggested && ' · тихий режим предложен'}
          </div>
        ) : (
          <div className="shield-banner green">✓ Щит не активен — идёт накопление силы.</div>
        )}
      </SectionCard>
    </div>
  );
}
