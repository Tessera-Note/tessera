import { Injectable } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('./../../../package.json');

@Injectable()
export class VersionService {
  constructor(private readonly environmentService: EnvironmentService) {}

  async getVersion() {
    // Версии отдает tessera-hub внутри сети compose, наружу за ними
    // не ходим.
    const url = `${this.environmentService.getHubInternalUrl().replace(/\/$/, '')}/api/releases/latest`;
    const releaseUrl = `${this.environmentService.getHubUrl().replace(/\/$/, '')}/releases`;

    let latestVersion = 0;
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.json();
      latestVersion = data?.tag_name?.replace('v', '');
    } catch (err) {
      /* empty */
    }

    return {
      currentVersion: packageJson?.version,
      latestVersion: latestVersion,
      releaseUrl,
    };
  }
}
