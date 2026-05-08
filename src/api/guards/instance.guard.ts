import { InstanceDto } from '@api/dto/instance.dto';
import { cache, prismaRepository, waMonitor } from '@api/server.module';
import { CacheConf, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@exceptions';
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
      // Always clean up the existing instance when a create is requested.
      // The caller has already expressed intent to (re)create — blocking with
      // 403 just leaves zombie instances that can never be replaced.  This
      // handles: stale-after-restart, zombie Baileys connections still in
      // memory, race conditions with async delete cleanup, and multi-process
      // in-memory state inconsistencies.
      logger.warn(`Instance "${instance.instanceName}" already exists — cleaning up for re-creation`);
      try {
        await waMonitor.cleaningUp(instance.instanceName);
        await waMonitor.cleaningStoreData(instance.instanceName);
      } catch (error) {
        logger.error(`Failed to clean up existing instance "${instance.instanceName}": ${error}`);
      }
    }

    if (waMonitor.waInstances[instance.instanceName]) {
      delete waMonitor.waInstances[instance.instanceName];
    }
  }

  next();
}
