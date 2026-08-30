import type { ReactElement, ReactNode } from 'react';

import type { SummaryFilterId, SummaryMetrics } from '../../../src/host/summaryMetrics.js';
import {
  attentionCardValue,
  updatesCardValue,
  vulnerabilitiesCardValue,
} from '../../../src/host/summaryMetrics.js';
import type { ScanDataAvailability } from '../../../src/core/types.js';
import { IconAlertTriangle, IconPackage, IconShield, IconTrendUp } from '../icons.js';

interface CardSpec {
  id: SummaryFilterId;
  label: string;
  icon: ReactNode;
  count: number | string;
  subtitle: string;
}

function buildCards(metrics: SummaryMetrics, availability: ScanDataAvailability): CardSpec[] {
  const updates = updatesCardValue(metrics, availability);
  const vulnerabilities = vulnerabilitiesCardValue(metrics, availability);
  const attention = attentionCardValue(metrics, availability);
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
      count: updates.count,
      subtitle: updates.subtitle,
    },
    {
      id: 'vulnerabilities',
      label: 'Vulnerable Dependencies',
      icon: <IconShield />,
      count: vulnerabilities.count,
      subtitle: vulnerabilities.subtitle,
    },
    {
      id: 'attention',
      label: 'Needs Attention',
      icon: <IconAlertTriangle />,
      count: attention.count,
      subtitle: attention.subtitle,
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
  availability,
  selected,
  onSelect,
}: {
  metrics: SummaryMetrics;
  availability: ScanDataAvailability;
  selected: SummaryFilterId;
  onSelect: (id: SummaryFilterId) => void;
}): ReactElement {
  const cards = buildCards(metrics, availability);
  return (
    <div className="summary-cards" role="group" aria-label="Filter dependencies by category">
      {cards.map((card) => (
        <SummaryCard key={card.id} card={card} selected={selected === card.id} onSelect={onSelect} />
      ))}
    </div>
  );
}
