import { useMemo, useState } from 'react';
import type { Goal, ScheduleBlock, EnergyBatteries } from '../core/types';
import { eventBus, EVENT_TYPES } from '../core/eventbus/eventbus';
import { SectionCard, YerkesGauge } from '../ui/widgets';

interface NowViewProps {
  goals: Goal[];
  schedule: ScheduleBlock[];
  batteries: EnergyBatteries;
  workoutReady: boolean;
  onStartWorkout: () => void;
}

function minutesNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function NowView({ goals, schedule, batteries, workoutReady, onStartWorkout }: NowViewProps) {
  const [sealedId, setSealedId] = useState<string | null>(null);
  const today = new Date().getDay();
  const now = minutesNow();

  const current = useMemo(() => {
    return schedule.find((b) => b.daysOfWeek.includes(today) && toMinutes(b.startTime) <= now && now < toMinutes(b.endTime));
  }, [schedule, today, now]);

  const span = current ? toMinutes(current.endTime) - toMinutes(current.startTime) : 0;
  const left = current ? toMinutes(current.endTime) - now : 0;
  const pct = current && span > 0 ? Math.round(((span - left) / span) * 100) : 0;

  const activeGoals = goals.slice(0, 3);

  const sealOrder = (goalId: string) => {
    eventBus.emit(EVENT_TYPES.ordersSealed, { orderId: goalId, entityId: goalId, sealedAt: new Date().toISOString() });
    setSealedId(goalId);
    window.setTimeout(() => setSealedId((cur) => (cur === goalId ? null : cur)), 2400);
  };

  return (
    <div className="screen">
      <SectionCard title="Текущий отрезок">
        {current ? (
          <>
            <div className="period-line">{current.startTime}–{current.endTime} · {current.title}{current.room ? ` · ${current.room}` : ''}</div>
            <div className="xp-bar-track" style={{ marginTop: 8 }}><div className="xp-bar-fill" style={{ width: `${pct}%` }} /></div>
            <div className="dim-note">осталось ~{left} мин</div>
          </>
        ) : (
          <div className="dim-note">Между блоками — время свободного рывка.</div>
        )}
      </SectionCard>

      <SectionCard title="Активный квест">
        {activeGoals.length === 0 ? (
          <div className="dim-note">Квестов нет — запусти первый ран, чтобы залить цели.</div>
        ) : (
          activeGoals.map((g) => (
            <div key={g.id} className="quest-card">
              <div className="quest-title">{g.title}</div>
              {g.tags.length > 0 && (
                <div className="tag-row">{g.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}</div>
              )}
              {g.description && <div className="dim-note">{g.description}</div>}
              <button type="button" className="btn-arcane" onClick={() => sealOrder(g.id)}>
                {sealedId === g.id ? '✦ Заказ запечатан' : 'Запечатать заказ'}
              </button>
            </div>
          ))
        )}
      </SectionCard>

      <SectionCard title="WARRIOR-190">
        <button type="button" className="btn-arcane" disabled={!workoutReady} onClick={onStartWorkout}>
          ⚔ Начать тренировку
        </button>
        {!workoutReady && <div className="dim-note">Программа не готова — ждёт заливки starter-данных.</div>}
      </SectionCard>

      <SectionCard title="Аrousal (Йеркс–Додсон)">
        <YerkesGauge energy={batteries.averageEnergy} />
      </SectionCard>
    </div>
  );
}
