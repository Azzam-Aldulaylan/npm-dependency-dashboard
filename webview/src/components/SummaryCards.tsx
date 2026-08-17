import type { ReactElement, ReactNode } from 'react';

import type { SummaryFilterId, SummaryMetrics } from '../../../src/host/summaryMetrics.js';
import {
  attentionCardSubtitle,
  updatesCardSubtitle,
  vulnerabilitiesCardSubtitle,
} from '../../../src/host/summaryMetrics.js';
import { IconAlertTriangle, IconPackage, IconShield, IconTrendUp } from '../icons.js';

interface CardSpec {
  id: SummaryFilterId;
  label: string;
  icon: ReactNode;
  count: number;
  subtitle: string;
}

function buildCards(metrics: SummaryMetrics): CardSpec[] {
  return [
    {
      id: 'all',
      label: 'Total Dependencies',
      icon: <IconPackage />,
      count: metrics.total,
      subtitle: 'All direct dependencies',
    },
    {
      id: 'updates',
      label: 'Updates Available',
      icon: <IconTrendUp />,
      count: metrics.updatesAvailable,
      subtitle: updatesCardSubtitle(metrics),
    },
    {
      id: 'vulnerabilities',
      label: 'Vulnerabilities',
      icon: <IconShield />,
      count: metrics.vulnerable,
      subtitle: vulnerabilitiesCardSubtitle(metrics),
    },
    {
      id: 'attention',
      label: 'Needs Attention',
      icon: <IconAlertTriangle />,
      count: metrics.needsAttention,
      subtitle: attentionCardSubtitle(metrics),
    },
  ];
}

function SummaryCard({
  card,
  selected,
  onSelect,
}: {
  card: CardSpec;
  selected: boolean;
  onSelect: (id: SummaryFilterId) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="summary-card"
      data-card={card.id}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      onClick={() => {
        onSelect(card.id);
      }}
    >
      <span className="summary-card__icon">{card.icon}</span>
      <span className="summary-card__body">
        <span className="summary-card__label">{card.label}</span>
        <span className="summary-card__count">{card.count}</span>
        <span className="summary-card__subtitle">{card.subtitle}</span>
      </span>
    </button>
  );
}

export function SummaryCards({
  metrics,
  selected,
  onSelect,
}: {
  metrics: SummaryMetrics;
  selected: SummaryFilterId;
  onSelect: (id: SummaryFilterId) => void;
}): ReactElement {
  const cards = buildCards(metrics);
  return (
    <div className="summary-cards" role="group" aria-label="Filter dependencies by category">
      {cards.map((card) => (
        <SummaryCard key={card.id} card={card} selected={selected === card.id} onSelect={onSelect} />
      ))}
    </div>
  );
}
