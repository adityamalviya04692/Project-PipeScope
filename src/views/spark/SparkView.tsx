import { useCallback, useState } from 'react';
import { Segmented } from '../../components/ui';
import { fmtDuration } from '../../lib/format';
import { runLabel, type Analysis } from '../../spark/analyze';
import Compare from './Compare';
import Config from './Config';
import Overview from './Overview';
import Plans from './Plans';
import StageDag from './StageDag';
import Stages from './Stages';
import Timeline from './Timeline';

type Tab = 'overview' | 'timeline' | 'stages' | 'dag' | 'plans' | 'config' | 'compare';

export default function SparkView({ runs, onSwap }: { runs: Analysis[]; onSwap: () => void }) {
  const [runIdx, setRunIdx] = useState(0);
  const [tab, setTab] = useState<Tab>('overview');
  const [stageKey, setStageKey] = useState<string | null>(null);
  const [sqlId, setSqlId] = useState<number | null>(null);
  const a = runs[Math.min(runIdx, runs.length - 1)];

  const openStage = useCallback((key: string) => {
    setStageKey(key);
    setTab('stages');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const openSql = useCallback((id: number) => {
    setSqlId(id);
    setTab('dag');
  }, []);

  const critical = a.findings.filter((f) => f.severity === 'critical').length;
  const tabs: { id: Tab; label: string; count?: number; tone?: string }[] = [
    { id: 'overview', label: 'Overview', count: a.findings.length, tone: critical ? 'critical' : '' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'stages', label: 'Stages' },
    { id: 'dag', label: 'Stage DAG' },
    { id: 'plans', label: 'SQL & plans' },
    { id: 'config', label: 'Config' },
    ...(runs.length === 2 ? [{ id: 'compare' as Tab, label: 'Before vs after' }] : []),
  ];

  return (
    <div className="stack">
      <div className="view-head">
        <div>
          <h2>{a.summary.appName}</h2>
          <p className="meta">
            {a.summary.appId} · {runLabel(a)} · {fmtDuration(a.summary.duration)} · Spark {a.summary.sparkVersion}
          </p>
        </div>
        {runs.length > 1 && (
          <Segmented
            label="Run"
            value={String(runIdx)}
            onChange={(v) => {
              setRunIdx(Number(v));
              setStageKey(null);
              setSqlId(null);
            }}
            options={runs.map((r, i) => ({ id: String(i), label: `${i === 0 ? 'Before' : 'After'} · ${runLabel(r)}` }))}
          />
        )}
      </div>
      <div className="subtabs">
        <Segmented label="Spark Doctor sections" value={tab} onChange={setTab} options={tabs} />
      </div>
      {tab === 'overview' && <Overview a={a} onOpenStage={openStage} onOpenSql={openSql} />}
      {tab === 'timeline' && <Timeline a={a} onOpenStage={openStage} />}
      {tab === 'stages' && <Stages a={a} selected={stageKey} onSelect={setStageKey} />}
      {tab === 'dag' && <StageDag a={a} sqlId={sqlId} onSelectSql={setSqlId} onOpenStage={openStage} />}
      {tab === 'plans' && <Plans a={a} sqlId={sqlId} onSelect={setSqlId} onOpenStage={openStage} />}
      {tab === 'config' && <Config a={a} />}
      {tab === 'compare' && runs.length === 2 && <Compare runs={[runs[0], runs[1]]} onSwap={onSwap} />}
    </div>
  );
}
