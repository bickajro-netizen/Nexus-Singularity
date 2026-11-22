import { useState } from 'react';

export type ComposerNoteType = 'daily_journal' | 'standard';

export interface ComposerNote {
  title: string;
  bodyMd: string;
  noteType: ComposerNoteType;
  dateKey: string | null;
}

interface NoteComposerProps {
  onSave: (note: ComposerNote) => Promise<void>;
}

const RITUAL_TEMPLATE = [
  '## Энергия',
  '- Физика: ',
  '- Эмоции: ',
  '- Разум: ',
  '- Дух: ',
  '## Фокус дня',
  '- ',
  '## Победа',
  '- ',
  '## [[Orders for Tomorrow]]',
  '- ',
].join('\n');

// Гримуар: создание заметки (запись дня / заметка) с шаблоном утреннего ритуала.
// Хранится в 'notes', сразу уходит в Obsidian через NexusBridge (оффлайн → очередь).
export function NoteComposer({ onSave }: NoteComposerProps) {
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [noteType, setNoteType] = useState<ComposerNoteType>('daily_journal');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const valid = title.trim().length > 0 && bodyMd.trim().length > 0 && !busy;

  const todayKey = () => new Date().toISOString().slice(0, 10);

  const applyTemplate = () => {
    if (!bodyMd.trim()) setBodyMd(RITUAL_TEMPLATE);
  };

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onSave({
        title: title.trim(),
        bodyMd,
        noteType,
        dateKey: noteType === 'daily_journal' ? todayKey() : null,
      });
      setTitle('');
      setBodyMd('');
      setDone(true);
      window.setTimeout(() => setDone(false), 2400);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="note-composer">
      <div className="note-composer-row">
        <input
          className="note-input"
          placeholder="Заголовок записи…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <select
          className="note-input note-type"
          value={noteType}
          onChange={(e) => setNoteType(e.target.value as ComposerNoteType)}
        >
          <option value="daily_journal">Запись дня</option>
          <option value="standard">Заметка</option>
        </select>
      </div>
      {noteType === 'daily_journal' && (
        <button type="button" className="btn-arcane small" onClick={applyTemplate}>
          ✦ Шаблон ритуала
        </button>
      )}
      <textarea
        className="note-textarea"
        placeholder="Markdown… (можно [[вики-ссылки]])"
        value={bodyMd}
        onChange={(e) => setBodyMd(e.target.value)}
      />
      <div className="note-composer-row">
        <button type="button" className="btn-arcane small" onClick={() => void submit()} disabled={!valid}>
          {busy ? '…' : 'Сохранить и синхронизировать'}
        </button>
        {done && <span className="sync-badge ok">Записано в гримуар</span>}
      </div>
    </div>
  );
}
