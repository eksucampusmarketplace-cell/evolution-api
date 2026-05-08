import { InstanceDto } from '@api/dto/instance.dto';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController } from '@api/server.module';
import { Events, Integration } from '@api/types/wa.types';
import { CacheConf, Chatwoot, ConfigService, Database, DelInstance, ProviderSession } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR, STORE_DIR } from '@config/path.config';
import { NotFoundException } from '@exceptions';
import { execFileSync } from 'child_process';
import EventEmitter2 from 'eventemitter2';
import { rmSync } from 'fs';
import { join } from 'path';

import { CacheService } from './cache.service';

export class WAMonitoringService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly providerFiles: ProviderFiles,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
  ) {
    this.removeInstance();
    this.noConnection();

    Object.assign(this.db, configService.get<Database>('DATABASE'));
    Object.assign(this.redis, configService.get<CacheConf>('CACHE'));

    (this as any).providerSession = Object.freeze(configService.get<ProviderSession>('PROVIDER'));
  }

  private readonly db: Partial<Database> = {};
  private readonly redis: Partial<CacheConf> = {};

  private readonly logger = new Logger('WAMonitoringService');
  public readonly waInstances: Record<string, any> = {};
  private readonly delInstanceTimeouts: Record<string, NodeJS.Timeout> = {};

  private readonly providerSession: ProviderSession;

  public delInstanceTime(instance: string) {
    const time = this.configService.get<DelInstance>('DEL_INSTANCE');
    if (typeof time === 'number' && time > 0) {
      // Clear previous timeout if exists
      if (this.delInstanceTimeouts[instance]) {
        clearTimeout(this.delInstanceTimeouts[instance]);
      }

      // Set new timeout and store reference
      this.delInstanceTimeouts[instance] = setTimeout(
        async () => {
          try {
            if (this.waInstances[instance]?.connectionStatus?.state !== 'open') {
              if (this.waInstances[instance]?.connectionStatus?.state === 'connecting') {
                if ((await this.waInstances[instance].integration) === Integration.WHATSAPP_BAILEYS) {
                  await this.waInstances[instance]?.client?.logout('Log out instance: ' + instance);
                  this.waInstances[instance]?.client?.ws?.close();
                  this.waInstances[instance]?.client?.end(undefined);
                }
                this.eventEmitter.emit('remove.instance', instance, 'inner');
              } else {
                this.eventEmitter.emit('remove.instance', instance, 'inner');
              }
            }
          } finally {
            // Clean up timeout reference
            delete this.delInstanceTimeouts[instance];
          }
        },
        1000 * 60 * time,
      );
    }
  }

  public clearDelInstanceTime(instance: string) {
    if (this.delInstanceTimeouts[instance]) {
      clearTimeout(this.delInstanceTimeouts[instance]);
      delete this.delInstanceTimeouts[instance];
    }
  }

  public async instanceInfo(instanceNames?: string[]): Promise<any> {
    if (instanceNames && instanceNames.length > 0) {
      const inexistentInstances = instanceNames ? instanceNames.filter((instance) => !this.waInstances[instance]) : [];

      if (inexistentInstances.length > 0) {
        throw new NotFoundException(
          `Instance${inexistentInstances.length > 1 ? 's' : ''} "${inexistentInstances.join(', ')}" not found`,
        );
      }
    }

    const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const where =
      instanceNames && instanceNames.length > 0
        ? {
            name: {
              in: instanceNames,
            },
            clientName,
          }
        : { clientName };

    const instances = await this.prismaRepository.instance.findMany({
      where,
      include: {
        Chatwoot: true,
        Proxy: true,
        Rabbitmq: true,
        Nats: true,
        Sqs: true,
        Websocket: true,
        Setting: true,
        _count: {
          select: {
            Message: true,
            Contact: true,
            Chat: true,
          },
        },
      },
    });

    return instances;
  }

  public async instanceInfoById(instanceId?: string, number?: string) {
    let instanceName: string;
    if (instanceId) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { id: instanceId } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${instanceId}" not found`);
      }
    } else if (number) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { number } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${number}" not found`);
      }
    }

    if (!instanceName) {
      throw new NotFoundException(`Instance "${instanceId}" not found`);
    }

    if (instanceName && !this.waInstances[instanceName]) {
      throw new NotFoundException(`Instance "${instanceName}" not found`);
    }

    const instanceNames = instanceName ? [instanceName] : null;

    return this.instanceInfo(instanceNames);
  }

  public async cleaningUp(instanceName: string) {
    let instanceDbId: string;
    if (this.db.SAVE_DATA.INSTANCE) {
      const findInstance = await this.prismaRepository.instance.findFirst({
        where: { name: instanceName },
      });

      if (findInstance) {
        const instance = await this.prismaRepository.instance.update({
          where: { name: instanceName },
          data: { connectionStatus: 'close' },
        });

        rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

        instanceDbId = instance.id;
        await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });
      }
    }

    if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
      await this.cache.delete(instanceName);
      if (instanceDbId) {
        await this.cache.delete(instanceDbId);
      }
    }

    if (this.providerSession?.ENABLED) {
      await this.providerFiles.removeSession(instanceName);
    }
  }

  public async cleaningStoreData(instanceName: string) {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
      const instancePath = join(STORE_DIR, 'chatwoot', instanceName);
      execFileSync('rm', ['-rf', instancePath]);
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { name: instanceName },
    });

    if (!instance) return;

    rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

    // Delete the instance record FIRST so the name is immediately freed for
    // re-creation. The instanceLoggedGuard checks the DB for the name — if
    // the instance row is gone, a new createInstance will pass the guard
    // even while child-record cleanup is still running below.
    await this.prismaRepository.instance.delete({ where: { name: instanceName } }).catch((error) => {
      this.logger.error(`cleaningStoreData: failed to delete instance record for "${instanceName}": ${error}`);
    });

    // Clean up child records sequentially. Each query acquires and releases
    // the DB connection individually, which works well with connection_limit=1.
    // Using $transaction here would hold the single connection for the entire
    // batch, starving concurrent requests and causing P2028 timeouts.
    const id = instance.id;
    await this.prismaRepository.session.deleteMany({ where: { sessionId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.chat.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.contact.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.messageUpdate
      .deleteMany({ where: { instanceId: id } })
      .catch((e) => this.logger.error(e));
    await this.prismaRepository.message.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.webhook.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.chatwoot.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.proxy.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.rabbitmq.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.nats.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.sqs.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.integrationSession
      .deleteMany({ where: { instanceId: id } })
      .catch((e) => this.logger.error(e));
    await this.prismaRepository.typebot.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.websocket.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.setting.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
    await this.prismaRepository.label.deleteMany({ where: { instanceId: id } }).catch((e) => this.logger.error(e));
  }

  public async loadInstance() {
    try {
      if (this.providerSession?.ENABLED) {
        await this.loadInstancesFromProvider();
      } else if (this.db.SAVE_DATA.INSTANCE) {
        await this.loadInstancesFromDatabasePostgres();
      } else if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
        await this.loadInstancesFromRedis();
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async saveInstance(data: any) {
    try {
      const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      const instanceData = {
        ownerJid: data.ownerJid,
        profileName: data.profileName,
        profilePicUrl: data.profilePicUrl,
        connectionStatus:
          data.integration && data.integration === Integration.WHATSAPP_BAILEYS ? 'close' : (data.status ?? 'open'),
        number: data.number,
        integration: data.integration || Integration.WHATSAPP_BAILEYS,
        token: data.hash,
        clientName: clientName,
        businessId: data.businessId,
      };
      await this.prismaRepository.instance.upsert({
        where: { name: data.instanceName },
        update: {
          id: data.instanceId,
          ...instanceData,
        },
        create: {
          id: data.instanceId,
          name: data.instanceName,
          ...instanceData,
        },
      });
    } catch (error) {
      this.logger.error(error);
    }
  }

  public deleteInstance(instanceName: string) {
    try {
      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
    } catch (error) {
      this.logger.error(error);
    }
  }

  private async setInstance(instanceData: InstanceDto) {
    const instance = channelController.init(instanceData, {
      configService: this.configService,
      eventEmitter: this.eventEmitter,
      prismaRepository: this.prismaRepository,
      cache: this.cache,
      chatwootCache: this.chatwootCache,
      baileysCache: this.baileysCache,
      providerFiles: this.providerFiles,
    });

    if (!instance) return;

    instance.setInstance({
      instanceId: instanceData.instanceId,
      instanceName: instanceData.instanceName,
      integration: instanceData.integration,
      token: instanceData.token,
      number: instanceData.number,
      businessId: instanceData.businessId,
      ownerJid: instanceData.ownerJid,
    });

    if (instanceData.connectionStatus === 'open' || instanceData.connectionStatus === 'connecting') {
      this.logger.info(
        `Auto-connecting instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus})`,
      );
      await instance.connectToWhatsapp();
    } else {
      this.logger.info(
        `Skipping auto-connect for instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus || 'close'})`,
      );
    }

    this.waInstances[instanceData.instanceName] = instance;
  }

  private async loadInstancesFromRedis() {
    const keys = await this.cache.keys();

    if (keys?.length > 0) {
      await Promise.all(
        keys.map(async (k) => {
          const instanceData = await this.prismaRepository.instance.findUnique({
            where: { id: k.split(':')[1] },
          });

          if (!instanceData) {
            return;
          }

          const instance = {
            instanceId: k.split(':')[1],
            instanceName: k.split(':')[2],
            integration: instanceData.integration,
            token: instanceData.token,
            number: instanceData.number,
            businessId: instanceData.businessId,
            connectionStatus: instanceData.connectionStatus as any, // Pass connection status
          };

          this.setInstance(instance);
        }),
      );
    }
  }

  private async loadInstancesFromDatabasePostgres() {
    const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const instances = await this.prismaRepository.instance.findMany({
      where: { clientName: clientName },
    });

    if (instances.length === 0) {
      return;
    }

    await Promise.all(
      instances.map(async (instance) => {
        this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: instance.token,
          number: instance.number,
          businessId: instance.businessId,
          ownerJid: instance.ownerJid,
          connectionStatus: instance.connectionStatus as any, // Pass connection status
        });
      }),
    );
  }

  private async loadInstancesFromProvider() {
    const [instances] = await this.providerFiles.allInstances();

    if (!instances?.data) {
      return;
    }

    await Promise.all(
      instances?.data?.map(async (instanceId: string) => {
        const instance = await this.prismaRepository.instance.findUnique({
          where: { id: instanceId },
        });

        this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: instance.token,
          businessId: instance.businessId,
          connectionStatus: instance.connectionStatus as any, // Pass connection status
        });
      }),
    );
  }

  private removeInstance() {
    this.eventEmitter.on('remove.instance', async (instanceName: string) => {
      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.REMOVE_INSTANCE, null);
      } catch (error) {
        this.logger.error(error);
      }

      this.clearDelInstanceTime(instanceName);

      // Delete the in-memory reference FIRST so the instanceLoggedGuard
      // immediately stops returning 403 "name already in use" for this
      // instance name. DB cleanup follows and is best-effort.
      try {
        delete this.waInstances[instanceName];
      } catch (error) {
        this.logger.error(error);
      }
      this.logger.warn(`Instance "${instanceName}" - REMOVED`);

      // DB cleanup: awaited so errors are logged, but each step has its
      // own catch so a single failure doesn't abort the rest.
      try {
        await this.cleaningUp(instanceName);
      } catch (error) {
        this.logger.error(`cleaningUp failed for "${instanceName}": ${error}`);
      }
      try {
        await this.cleaningStoreData(instanceName);
      } catch (error) {
        this.logger.error(`cleaningStoreData failed for "${instanceName}": ${error}`);
      }
    });
    this.eventEmitter.on('logout.instance', async (instanceName: string) => {
      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.LOGOUT_INSTANCE, null);

        this.clearDelInstanceTime(instanceName);

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
          this.waInstances[instanceName]?.clearCacheChatwoot();
        }

        this.cleaningUp(instanceName);
      } finally {
        this.logger.warn(`Instance "${instanceName}" - LOGOUT`);
      }
    });
  }

  private noConnection() {
    this.eventEmitter.on('no.connection', async (instanceName) => {
      try {
        await this.waInstances[instanceName]?.client?.logout('Log out instance: ' + instanceName);

        this.waInstances[instanceName]?.client?.ws?.close();

        this.waInstances[instanceName].instance.qrcode = { count: 0 };
        this.waInstances[instanceName].stateConnection.state = 'close';
      } catch (error) {
        this.logger.error({
          localError: 'noConnection',
          warn: 'Error deleting instance from memory.',
          error,
        });
      } finally {
        this.logger.warn(`Instance "${instanceName}" - NOT CONNECTION`);
      }
    });
  }
}
