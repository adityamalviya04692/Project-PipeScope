import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { MSSQL, MySQL, PostgreSQL, sql, StandardSQL } from '@codemirror/lang-sql';
import { basicSetup, EditorView } from 'codemirror';

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)' },
});

function dialectFor(id: string) {
  if (id === 'postgres' || id === 'redshift') return PostgreSQL;
  if (id === 'tsql') return MSSQL;
  if (id === 'mysql') return MySQL;
  return StandardSQL;
}

/** CodeMirror 6 SQL editor. A new `docKey` loads a new document. */
export default function SqlEditor({ value, onChange, dialect = 'databricks', readOnly = false, docKey, height = 520 }: { value: string; onChange?: (v: string) => void; dialect?: string; readOnly?: boolean; docKey: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          sql({ dialect: dialectFor(dialect), upperCaseKeywords: true }),
          EditorView.lineWrapping,
          theme,
          EditorView.theme({ '&': { height: `${height}px` }, '.cm-scroller': { overflow: 'auto' } }),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // The document is owned by CodeMirror once created; only a new docKey reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, dialect, readOnly, height]);
  return <div className="cm-host" ref={host} />;
}
