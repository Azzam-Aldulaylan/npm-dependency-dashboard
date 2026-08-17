import type { ReactElement } from 'react';

import type { UpgradeAnalysisFiles } from '../../../src/host/webviewProtocol.js';
import { IconFile } from '../icons.js';

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.at(-1) ?? p;
}

export function FilesSection({ files }: { files: UpgradeAnalysisFiles }): ReactElement {
  return (
    <section className="analysis-section" aria-labelledby="analysis-files-heading">
      <h3 className="analysis-section__title" id="analysis-files-heading">
        <IconFile className="analysis-section__title-icon" />
        Files
      </h3>
      <ul className="files__list">
        <li>
          <code>{baseName(files.manifestPath)}</code>
        </li>
        <li>
          <code>{baseName(files.lockfilePath)}</code>
        </li>
      </ul>
      {files.rollbackAvailable ? (
        <p
          className="analysis-section__hint"
          title="Rollback restores the dependency manifest and lockfile. Installed modules may require reinstalling."
        >
          Rollback available if verification fails
        </p>
      ) : null}
    </section>
  );
}
