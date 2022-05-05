const Heroku = require('heroku-client');
const core = require('@actions/core');
const github = require('@actions/github');

const VALID_EVENT = 'pull_request';

async function run() {
  try {
    const githubToken = core.getInput('github_token', { required: true });
    const herokuApiToken = core.getInput('heroku_api_token', {
      required: true,
    });
    const herokuPipelineId = core.getInput('heroku_pipeline_id', {
      required: true,
    });

    const octokit = new github.getOctokit(githubToken);
    const heroku = new Heroku({ token: herokuApiToken });

    const {
      eventName,
      payload: {
        action,
        pull_request: {
          head: {
            ref: branch,
            sha: version,
            repo: {
              id: repoId,
              fork: forkRepo,
              html_url: repoHtmlUrl,
            },
          },
          number: prNumber,
          // updated_at: prUpdatedAtRaw,
        },
      },
      issue: {
        number: issueNumber,
      },
      repo,
    } = github.context;

    const {
      owner: repoOwner,
    } = repo;

    if (eventName !== VALID_EVENT) {
      throw new Error(`Unexpected github event trigger: ${eventName}`);
    }

    // const prUpdatedAt = DateTime.fromISO(prUpdatedAtRaw);
    const sourceUrl = `${repoHtmlUrl}/tarball/${version}`;
    const forkRepoId = forkRepo ? repoId : undefined;

    const getAppDetails = async (id) => {
      const url = `/apps/${id}`;
      core.debug(`Getting app details for app ID ${id} (${url})`);
      const appDetails = await heroku.get(url);
      core.info(`Got app details for app ID ${id} OK: ${JSON.stringify(appDetails)}`);
      return appDetails;
    };

    const outputAppDetails = (app) => {
      core.startGroup('Output app details');
      const {
        id: appId,
        web_url: webUrl,
        name: appName,
      } = app;
      core.info(`Review app ID: "${appId}"`);
      core.setOutput('app_id', appId);
      core.info(`Review app Web URL: "${webUrl}"`);
      core.setOutput('app_web_url', webUrl);
      core.info(`Review app name: "${appName}"`);
      core.setOutput('app_name', appName);
      core.endGroup();
    };

    const findReviewApp = async () => {
      const apiUrl = `/pipelines/${herokuPipelineId}/review-apps`;
      core.debug(`Listing review apps: "${apiUrl}"`);
      const reviewApps = await heroku.get(apiUrl);
      core.info(`Listed ${reviewApps.length} review apps OK: ${reviewApps.length} apps found.`);

      core.debug(`Finding review app for PR #${prNumber}...`);
      const app = reviewApps.find(app => app.pr_number === prNumber);
      if (app) {
        const { status } = app;
        if ('errored' === status) {
          core.notice(`Found review app for PR #${prNumber} OK, but status is "${status}"`);
          return null;
        }
        core.info(`Found review app for PR #${prNumber} OK: ${JSON.stringify(app)}`);
      } else {
        core.info(`No review app found for PR #${prNumber}`);
      }
      return app;
    };

    const waitReviewAppUpdated = async () => {
      core.startGroup('Ensure review app is up to date');

      const waitSeconds = secs => new Promise(resolve => setTimeout(resolve, secs * 1000));

      const checkBuildStatusForReviewApp = async (app) => {
        core.debug(`Checking build status for app: ${JSON.stringify(app)}`);
        if ('pending' === app.status || 'creating' === app.status) {
          return false;
        }
        if ('deleting' === app.status) {
          throw new Error(`Unexpected app status: "${app.status}" - ${app.message} (error status: ${app.error_status})`);
        }
        if (!app.app) {
          throw new Error(`Unexpected app status: "${app.status}"`);
        }
        const {
          app: {
            id: appId,
          },
          status,
          error_status: errorStatus,
        } = app;

        core.debug(`Fetching latest builds for app ${appId}...`);
        const latestBuilds = await heroku.get(`/apps/${appId}/builds`);
        core.debug(`Fetched latest builds for pipeline ${appId} OK: ${latestBuilds.length} builds found.`);

        core.debug(`Finding build matching version ${version}...`);
        const build = await latestBuilds.find(build => version === build.source_blob.version);
        if (!build) {
          core.error(`Could not find build matching version ${version}.`);
          core.setFailed(`No existing build for app ID ${appId} matches version ${version}`);
          throw new Error(`Unexpected build status: "${status}" yet no matching build found`);
        }
        core.info(`Found build matching version ${version} OK: ${JSON.stringify(build)}`);
        core.debug('XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX');

        switch (build.status) {
          case 'succeeded':
            return true;
          case 'pending':
            return false;
          default:
            throw new Error(`Unexpected build status: "${status}": ${errorStatus || 'no error provided'}`);
        }
      };

      let reviewApp;
      let isFinished;
      do {
        reviewApp = await findReviewApp();
        isFinished = await checkBuildStatusForReviewApp(reviewApp);
        core.debug('YYYY YYYY YYYY YYYY YYYY YYYY YYYY YYYY YYYY YYYY ');
        await waitSeconds(5);
      } while (!isFinished);
      core.endGroup();

      core.debug('ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ');
      return getAppDetails(reviewApp.app.id);
    };

    const createReviewApp = async () => {
      try {
        core.startGroup('Create review app');

        const archiveBody = {
          owner: repoOwner,
          repo: repo.repo,
          ref: version,
        };
        core.debug(`Fetching archive: ${JSON.stringify(archiveBody)}`);
        const { url: archiveUrl } = await octokit.rest.repos.downloadTarballArchive(archiveBody);
        core.info(`Fetched archive OK: ${JSON.stringify(archiveUrl)}`);

        const body = {
          branch,
          pipeline: herokuPipelineId,
          source_blob: {
            url: archiveUrl,
            version,
          },
          fork_repo_id: forkRepoId,
          pr_number: prNumber,
          environment: {
            GIT_REPO_URL: repoHtmlUrl,
          },
        };
        core.debug(`Creating heroku review app: ${JSON.stringify(body)}`);
        const app = await heroku.post('/review-apps', { body });
        core.info('Created review app OK:', app);
        core.endGroup();

        return app;
      } catch (err) {
        // 409 indicates duplicate; anything else is unexpected
        if (err.statusCode !== 409) {
          throw err;
        }
        // possibly build kicked off after this PR action began running
        core.warning('Review app now seems to exist after previously not...');
        core.endGroup();

        // just some sanity checking
        const app = await findReviewApp();
        if (!app) {
          throw new Error('Previously got status 409 but no app found');
        }
        return app;
      }
    };

    const updateReviewApp = async (app) => {
      core.startGroup('Update review app');

      const archiveBody = {
        owner: repoOwner,
        repo: repo.repo,
        ref: version,
      };
      core.debug(`Fetching archive: ${JSON.stringify(archiveBody)}`);
      const { url: archiveUrl } = await octokit.rest.repos.downloadTarballArchive(archiveBody);
      core.info(`Fetched archive OK: ${JSON.stringify(archiveUrl)}`);

      const body = {
        source_blob: {
          url: archiveUrl,
          version,
        },
      };
      core.debug(`Creating heroku review app: ${JSON.stringify(body)}`);
      await heroku.post(`/apps/${app.app.id}/builds`, { body });
      core.info('Updated review app OK:', app);
      core.endGroup();

      return app;
    };

    core.debug(`Deploy info: ${JSON.stringify({
      branch,
      version,
      repoId,
      forkRepo,
      forkRepoId,
      repoHtmlUrl,
      prNumber,
      issueNumber,
      repoOwner,
      sourceUrl,
    })}`);

    if (forkRepo) {
      core.notice('No secrets are available for PRs in forked repos.');
      return;
    }

    // Only people that can close PRs are maintainers or the author
    // hence can safely delete review app without being collaborator
    if ('closed' === action) {
      core.debug('PR closed, deleting review app...');
      const app = await findReviewApp();
      if (app) {
        await heroku.delete(`/review-apps/${app.id}`);
        core.info('PR closed, deleted review app OK');
        core.endGroup();
      } else {
        core.error(`Could not find review app for PR #${prNumber}`);
        core.setFailed(`Action "closed", yet no existing review app for PR #${prNumber}`);
      }
      return;
    }

    // TODO: ensure we have permission
    // const perms = await tools.github.repos.getCollaboratorPermissionLevel({
    //   ...tools.context.repo,
    //   username: tools.context.actor,
    // });

    const app = await findReviewApp();
    if (!app) {
      await createReviewApp();
    } else {
      await updateReviewApp(app);
    }
    const updatedApp = await waitReviewAppUpdated();
    outputAppDetails(updatedApp);
  } catch (err) {
    core.error(err);
    core.setFailed(err.message);
  }
}

run();
