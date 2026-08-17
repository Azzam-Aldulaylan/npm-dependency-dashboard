import type { ReactElement } from 'react';

import type { UpgradeAnalysisFiles } from '../../../src/host/webviewProtocol.js';
import { IconFile, IconHistory } from '../icons.js';
import { InfoTooltip } from './Tooltip.js';

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.at(-1) ?? p;
}

export function FilesSection({ files }: { files: UpgradeAnalysisFiles }): ReactElement {
  return (
    <section className="analysis-card" aria-labelledby="analysis-files-heading">
      <h3 className="analysis-card__title" id="analysis-files-heading">
        <IconFile className="analysis-card__title-icon" />
        Files
      </h3>
      <ul className="files__list">
        <li>
          <IconFile className="files__list-icon" />
          {baseName(files.manifestPath)}
        </li>
        <li>
          <IconFile className="files__list-icon" />
          {baseName(files.lockfilePath)}
        </li>
      </ul>
      {files.rollbackAvailable ? (
        <p className="analysis-card__hint analysis-card__hint--rollback">
          <IconHistory className="analysis-card__hint-icon" />
          Rollback available if verification fails
          <InfoTooltip
            label="How rollback works"
            content={<p>Rollback restores package.json and the active lockfile. Installed modules may still need reinstalling.</p>}
          />
        </p>
      ) : null}
    </section>
  );
}
