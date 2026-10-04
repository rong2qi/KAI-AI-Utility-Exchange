import { userRetryResult } from './release-user-result.mjs';

/** User-facing composition seam: callers provide only the candidate version. */
export class StagingReleaseFacade {
  constructor({ controller, getCandidate, runHealthChecks, acquireToken } = {}) {
    if (!controller || typeof controller.releaseForUser !== 'function' || typeof controller.previewForUser !== 'function') {
      throw new Error('CONTROLLER_REQUIRED');
    }
    if (typeof getCandidate !== 'function') throw new Error('CANDIDATE_LOADER_REQUIRED');
    if (typeof runHealthChecks !== 'function') throw new Error('HEALTH_CHECK_RUNNER_REQUIRED');
    if (typeof acquireToken !== 'function') throw new Error('FENCE_ACQUIRER_REQUIRED');
    this.controller = controller;
    this.getCandidate = getCandidate;
    this.runHealthChecks = runHealthChecks;
    this.acquireToken = acquireToken;
  }

  async #buildInput({ version } = {}, { withToken = true } = {}) {
    if (typeof version !== 'string' || version.trim() === '') throw new Error('CANDIDATE_VERSION_REQUIRED');
    const candidate = await this.getCandidate(version);
    if (!candidate?.manifest) throw new Error('CANDIDATE_NOT_FOUND');
    const checks = await this.runHealthChecks({ candidate });
    const token = withToken ? await this.acquireToken({ candidate }) : undefined;
    return { manifest: candidate.manifest, checks, token };
  }

  async preview(request = {}) {
    try {
      return await this.controller.previewForUser(await this.#buildInput(request, { withToken: false }));
    } catch {
      return userRetryResult();
    }
  }

  async publish(request = {}) {
    try {
      return await this.controller.releaseForUser(await this.#buildInput(request));
    } catch {
      return userRetryResult();
    }
  }
}
