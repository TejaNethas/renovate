import { ensureDir, outputFile, readFile } from 'fs-extra';
import { join } from 'upath';
import { exec, ExecOptions } from '../../util/exec';
import { logger } from '../../logger';
import {
  UpdateArtifactsResult,
  UpdateArtifact,
  UpdateArtifactsConfig,
} from '../common';
import { platform } from '../../platform';

const pythonRe = /python(?:_full)_version\s=\s"(?<version>.+?)"/;

function getPythonConstraint(
  newPackageFileContent: string,
  config: UpdateArtifactsConfig
): string | undefined | null {
  const { compatibility = {} } = config;
  const { python } = compatibility;

  if (python) {
    logger.debug('Using python constraint from config');
    return python;
  }
  const pm = pythonRe.exec(newPackageFileContent);
  return pm?.groups?.version;
}

export async function updateArtifacts({
  packageFileName: pipfileName,
  newPackageFileContent: newPipfileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`pipenv.updateArtifacts(${pipfileName})`);

  const cacheDir =
    process.env.PIPENV_CACHE_DIR || join(config.cacheDir, './others/pipenv');
  await ensureDir(cacheDir);
  logger.debug('Using pipenv cache ' + cacheDir);

  const lockFileName = pipfileName + '.lock';
  const existingLockFileContent = await platform.getFile(lockFileName);
  if (!existingLockFileContent) {
    logger.debug('No Pipfile.lock found');
    return null;
  }
  try {
    const localPipfileFileName = join(config.localDir, pipfileName);
    await outputFile(localPipfileFileName, newPipfileContent);
    const localLockFileName = join(config.localDir, lockFileName);
    const cmd = ['pip install pipenv', 'pipenv lock'];
    const execOptions: ExecOptions = {
      extraEnv: {
        PIPENV_CACHE_DIR: cacheDir,
      },
      docker: {
        image: 'renovate/pipenv',
        volumes: [cacheDir],
        tagConstraint: getPythonConstraint(newPipfileContent, config),
      },
    };
    logger.debug({ cmd }, 'pipenv lock command');
    await exec(cmd, execOptions);
    const status = await platform.getRepoStatus();
    if (!(status && status.modified.includes(lockFileName))) {
      return null;
    }
    logger.debug('Returning updated Pipfile.lock');
    return [
      {
        file: {
          name: lockFileName,
          contents: await readFile(localLockFileName, 'utf8'),
        },
      },
    ];
  } catch (err) {
    logger.warn({ err }, 'Failed to update Pipfile.lock');
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
