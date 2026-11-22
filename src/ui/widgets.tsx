import type { EnergyBatteries } from '../core/types';
import { computeYerkesDodsonMultiplier } from '../core/math/xp';
import './widgets.css';

const STAT_LABELS_RU: Record<string, string> = {
  Intellect: 'Интеллект', Discipline: 'Дисциплина', Endurance: 'Выносливость', Wealth: 'Богатство', Creativity: 'Творчество',
};
const BATTERY_LABELS_RU: Record<keyof EnergyBatteries & ('Physical' | 'Emotional' | 'Mental' | 'Spiritual'), string> = {
  Physical: 'Физика', Emotional: 'Эмоции', Mental: 'Разум', Spiritual: 'Дух',
};

export function XpBar({ level, xp, xpToNext }: { level: number; xp: number; xpToNext: number }) {
  const pct = Math.max(0, Math.min(100, (xp / Math.max(1, xpToNext)) * 100));
  return (
    <div className="xp-bar" title={`${xp} / ${xpToNext} XP`}>
      <div className="xp-bar-label">Ур. {level}</div>
      <div className="xp-bar-track"><div className="xp-bar-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function chipClass(v: number): string {
  return v < 50 ? 'red' : v < 70 ? 'amber' : 'green';
}

export function BatteryChips({ batteries }: { batteries: EnergyBatteries }) {
  const keys = ['Physical', 'Emotional', 'Mental', 'Spiritual'] as const;
  return (
    <div className="battery-chips">
      {keys.map((k) => (
        <div key={k} className={`battery-chip ${chipClass(batteries[k])}`}>
          <span className="chip-name">{BATTERY_LABELS_RU[k]}</span>
          <span className="chip-value">{Math.round(batteries[k])}%</span>
        </div>
      ))}
    </div>
  );
}

export function YerkesGauge({ energy }: { energy: number }) {
  const mult = computeYerkesDodsonMultiplier(energy);
  const zone = energy >= 60 && energy <= 85
    ? { label: 'Оптимум', color: 'var(--green)' }
    : energy > 85
      ? { label: 'Перегрузка', color: 'var(--crimson)' }
      : { label: 'Вялость', color: '#4da6ff' };
  const clamped = Math.max(0, Math.min(100, energy));
  // arc from 180deg (0) to 0deg (100), r=70, cx=90, cy=90
  const angle = Math.PI * (1 - clamped / 100);
  const nx = 90 + 78 * Math.cos(angle);
  const ny = 90 - 78 * Math.sin(angle);
  return (
    <div className="yerkes-gauge">
      <svg width="180" height="110" viewBox="0 0 180 110" role="img" aria-label="Yerkes-Dodson gauge">
        <defs>
          <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#4da6ff" />
            <stop offset="60%" stopColor="#4caf50" />
            <stop offset="100%" stopColor="#ff4d4d" />
          </linearGradient>
        </defs>
        <path d="M 12 90 A 78 78 0 0 1 168 90" fill="none" stroke="url(#gaugeGrad)" strokeWidth="10" strokeLinecap="round" />
        <line x1="90" y1="90" x2={nx} y2={ny} stroke={zone.color} strokeWidth="3" strokeLinecap="round" />
        <circle cx="90" cy="90" r="5" fill={zone.color} />
        <text x="90" y="106" textAnchor="middle" fill={zone.color} fontSize="13" fontWeight="700">{zone.label}</text>
      </svg>
      <div className="gauge-caption">Аrousal-множитель: <strong>×{mult.toFixed(2)}</strong></div>
    </div>
  );
}

export function RadarChart({ stats }: { stats: Record<string, { level: number; xp: number; xpToNext: number }> }) {
  const labels = ['Intellect', 'Discipline', 'Endurance', 'Wealth', 'Creativity'];
  const cx = 110, cy = 105, r = 72;
  const point = (i: number, frac: number): [number, number] => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / 5;
    return [cx + r * frac * Math.cos(a), cy + r * frac * Math.sin(a)];
  };
  const frame = labels.map((_, i) => point(i, 1).join(',')).join(' ');
  const mid = labels.map((_, i) => point(i, 0.5).join(',')).join(' ');
  const area = labels.map((l, i) => {
    const st = stats[l];
    const frac = st ? Math.max(0.08, Math.min(1, st.level / 10)) : 0.08;
    return point(i, frac).join(',');
  }).join(' ');
  return (
    <svg className="radar-chart" width="220" height="210" viewBox="0 0 220 210" role="img" aria-label="Stats radar">
      <polygon className="stat-frame" points={frame} />
      <polygon className="stat-frame" points={mid} />
      <polygon className="stat-area" points={area} />
      {labels.map((l, i) => {
        const [x, y] = point(i, 1.22);
        return <text key={l} x={x} y={y} textAnchor="middle" dominantBaseline="middle">{STAT_LABELS_RU[l] ?? l}</text>;
      })}
    </svg>
  );
}

export function SectionCard({ title, children, accent }: { title: string; children: React.ReactNode; accent?: string }) {
  return (
    <section className="section-card" style={accent ? { borderColor: accent } : undefined}>
      <h2 className="card-title">{title}</h2>
      {children}
    </section>
  );
}

export function QuietBadge({ on }: { on: boolean }) {
  return <span className={`quiet-badge ${on ? 'on' : ''}`}>{on ? '🕯 Тихий режим' : '🔊 Активен'}</span>;
}
