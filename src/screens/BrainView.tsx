import { useMemo } from 'react';
import type { Goal, Note } from '../core/types';
import { SectionCard } from '../ui/widgets';

interface BrainViewProps {
  goals: Goal[];
  notes: Note[];
  pendingSync: number;
}

export function BrainView({ goals, notes, pendingSync }: BrainViewProps) {
  const grouped = useMemo(() => {
    const map = new Map<string, Goal[]>();
    for (const g of goals) {
      const key = g.lifeAreaId || 'none';
      const arr = map.get(key) ?? [];
      arr.push(g);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [goals]);

  return (
    <div className="screen brain-grid">
      <SectionCard title="Древо целей">
        {grouped.length === 0 ? (
          <div className="dim-note">Древо пусто.</div>
        ) : (
          grouped.map(([areaId, list]) => (
            <div key={areaId} className="tree-area">
              <div className="tree-area-name">{areaId === 'none' ? 'Без области' : areaId}</div>
              {list.map((g) => (
                <div key={g.id} className="tree-goal">
                  <span className="tree-goal-title">{g.title}</span>
                  {g.tags.length > 0 && <span className="tag-row">{g.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}</span>}
                </div>
              ))}
            </div>
          ))
        )}
      </SectionCard>

      <SectionCard title="Заметки">
        {notes.length === 0 ? (
          <div className="dim-note">Гримуар пуст.</div>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="note-row">
              <div className="note-title">{n.title}</div>
              <div className="dim-note">{new Date(n.modified).toLocaleString('ru-RU')}</div>
            </div>
          ))
        )}
      </SectionCard>

      <SectionCard title="Синк Обсидиан">
        <div className={`sync-badge ${pendingSync === 0 ? 'ok' : 'warn'}`}>
          {pendingSync === 0 ? 'Синхронизировано' : `В очереди: ${pendingSync}`}
        </div>
        <ul className="dim-list">
          <li>NEXUS/Daily</li>
          <li>NEXUS/Quests</li>
          <li>NEXUS/Rituals</li>
        </ul>
      </SectionCard>
    </div>
  );
}
