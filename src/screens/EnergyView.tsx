import { useEffect, useState } from 'react';
import type { EnergyBatteries, Goal, ScheduleBlock } from '../core/types';
import { BatteryChips, SectionCard } from '../ui/widgets';

interface EnergyViewProps {
  schedule: ScheduleBlock[];
  batteries: EnergyBatteries;
  goals: Goal[];
}

const DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const TYPE_COLORS: Record<ScheduleBlock['type'], string> = {
  lesson: '#FF4D4D',
  timeblock: '#FFC107',
  break: '#4CAF50',
};
const TYPE_LABELS: Record<ScheduleBlock['type'], string> = {
  lesson: 'Истощает',
  timeblock: 'Нейтрально',
  break: 'Восстанавливает',
};
const MEALS = ['тунец', 'овсянка', 'протеин', 'орехи', 'творог lactose-free'];

const GRID_START = 8 * 60;
const GRID_END = 22 * 60;
const SLOT_H = 34;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

interface MealState { [dateKey: string]: number[] }

function loadMeals(): MealState {
  try {
    const raw = localStorage.getItem('nexus_meals');
    return raw ? (JSON.parse(raw) as MealState) : {};
  } catch {
    return {};
  }
}

export function EnergyView({ schedule, batteries }: EnergyViewProps) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const [meals, setMeals] = useState<MealState>(loadMeals);

  useEffect(() => {
    localStorage.setItem('nexus_meals', JSON.stringify(meals));
  }, [meals]);

  const checked = meals[todayKey] ?? [];
  const toggleMeal = (i: number) => {
    setMeals((cur) => {
      const next = cur[todayKey] ? [...cur[todayKey]] : [];
      const idx = next.indexOf(i);
      if (idx === -1) next.push(i); else next.splice(idx, 1);
      return { ...cur, [todayKey]: next };
    });
  };

  // js day: 0=Вс..6=Сб → колонки Пн(0)..Вс(6)
  const byDay: ScheduleBlock[][] = [[], [], [], [], [], [], []];
  for (const b of schedule) {
    for (const d of b.daysOfWeek) {
      const col = (d + 6) % 7;
      byDay[col].push(b);
    }
  }

  return (
    <div className="screen">
      <SectionCard title="Расписание недели">
        <div className="week-grid">
          <div className="week-hour-col">
            {Array.from({ length: 15 }, (_, i) => (
              <div key={i} className="week-hour-label">{String(8 + i).padStart(2, '0')}:00</div>
            ))}
          </div>
          {byDay.map((blocks, day) => (
            <div key={day} className={`week-day-col ${day === (new Date().getDay() + 6) % 7 ? 'today' : ''}`}>
              <div className="week-day-name">{DAYS_RU[day]}</div>
              <div className="week-day-track">
                {Array.from({ length: 15 }, (_, i) => <div key={i} className="week-slot" />)}
                {blocks.map((b) => {
                  const start = Math.max(GRID_START, toMinutes(b.startTime));
                  const end = Math.min(GRID_END, toMinutes(b.endTime));
                  if (end <= GRID_START || start >= GRID_END) return null;
                  return (
                    <div
                      key={b.id}
                      className="week-block"
                      style={{
                        top: ((start - GRID_START) / 60) * SLOT_H,
                        height: Math.max(14, ((end - start) / 60) * SLOT_H - 2),
                        background: TYPE_COLORS[b.type],
                      }}
                      title={`${b.startTime}–${b.endTime} ${b.title}`}
                    >
                      {b.startTime} {b.title}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="legend-row">
          {(['lesson', 'timeblock', 'break'] as const).map((t) => (
            <span key={t} className="legend-item"><span className="legend-swatch" style={{ background: TYPE_COLORS[t] }} />{TYPE_LABELS[t]}</span>
          ))}
          <span className="legend-item dim">🕯 Тихие часы 22:00–06:30</span>
        </div>
      </SectionCard>

      <SectionCard title="Питание общежития (белок 160 г/день)">
        <div className="meal-list">
          {MEALS.map((m, i) => (
            <label key={m} className="meal-check">
              <input type="checkbox" checked={checked.includes(i)} onChange={() => toggleMeal(i)} />
              <span>{m}</span>
            </label>
          ))}
        </div>
        <div className="dim-note">Отметок сегодня: {checked.length}/{MEALS.length}</div>
      </SectionCard>

      <SectionCard title="Батареи">
        <BatteryChips batteries={batteries} />
      </SectionCard>
    </div>
  );
}
