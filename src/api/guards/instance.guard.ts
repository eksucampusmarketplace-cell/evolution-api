import { InstanceDto } from '@api/dto/instance.dto';
import { cache, prismaRepository, waMonitor } from '@api/server.module';
import { CacheConf, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@exceptions';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('InstanceGuard');

async function getInstance(instanceName: string) {
  try {
    const cacheConf = configService.get<CacheConf>('CACHE');

    const exists = !!waMonitor.waInstances[instanceName];

    if (cacheConf.REDIS.ENABLED && cacheConf.REDIS.SAVE_INSTANCES) {
      const keyExists = await cache.has(instanceName);

      return exists || keyExists;
    }

    return exists || (await prismaRepository.instance.findMany({ where: { name: instanceName } })).length > 0;
  } catch (error) {
    throw new InternalServerErrorException(error?.toString());
  }
}

async function isInstanceOnlyInDatabase(instanceName: string): Promise<boolean> {
  const inMemory = !!waMonitor.waInstances[instanceName];
  if (inMemory) return false;

  const dbRecords = await prismaRepository.instance.findMany({ where: { name: instanceName } });
  return dbRecords.length > 0;
}

async function removeStaleInstance(instanceName: string): Promise<void> {
  try {
    await waMonitor.cleaningStoreData(instanceName);
    logger.warn(`Removed stale database record for instance "${instanceName}" (not loaded in memory)`);
  } catch (error) {
    logger.error(`Failed to remove stale instance "${instanceName}": ${error}`);
  }
}

export async function instanceExistsGuard(req: Request, _: Response, next: NextFunction) {
  if (req.originalUrl.includes('/instance/create') || req.originalUrl.includes('/instance/fetchInstances')) {
    return next();
  }

  const param = req.params as unknown as InstanceDto;
  if (!param?.instanceName) {
    throw new BadRequestException('"instanceName" not provided.');
  }

  if (!(await getInstance(param.instanceName))) {
    throw new NotFoundException(`The "${param.instanceName}" instance does not exist`);
  }

  next();
}

export async function instanceLoggedGuard(req: Request, _: Response, next: NextFunction) {
  if (req.originalUrl.includes('/instance/create')) {
    const instance = req.body as InstanceDto;
    if (await getInstance(instance.instanceName)) {
      if (await isInstanceOnlyInDatabase(instance.instanceName)) {
        logger.warn(
          `Instance "${instance.instanceName}" exists in database but not in memory (stale after restart). Cleaning up for re-creation.`,
        );
        await removeStaleInstance(instance.instanceName);
      } else {
        throw new ForbiddenException(`This name "${instance.instanceName}" is already in use.`);
      }
    }

    if (waMonitor.waInstances[instance.instanceName]) {
      delete waMonitor.waInstances[instance.instanceName];
    }
  }

  next();
}
