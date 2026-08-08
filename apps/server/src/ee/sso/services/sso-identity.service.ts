import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { randomBytes } from 'crypto';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { GroupUserRepo } from '@tessera/db/repos/group/group-user.repo';
import { executeTx } from '@tessera/db/utils';
import { UserRole } from '../../../common/helpers/types/permission';
import { WorkspaceService } from '../../../core/workspace/services/workspace.service';

/**
 * Общая часть входа через внешнего провайдера, не зависящая от протокола.
 *
 * Протоколы различаются только тем, как получены идентификатор, почта и имя
 * человека. Все, что происходит после, одинаково: найти включенного
 * провайдера, найти или завести пользователя, связать его учетную запись.
 * Держать это в сервисе конкретного протокола значило бы дублировать
 * правила доступа на каждый новый протокол и получить их расхождение.
 */
@Injectable()
export class SsoIdentityService {
  private readonly logger = new Logger(SsoIdentityService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly groupUserRepo: GroupUserRepo,
    private readonly workspaceService: WorkspaceService,
  ) {}

  /**
   * Включенный провайдер нужного типа в рабочем пространстве.
   *
   * Тип проверяется здесь, а не только по маршруту: без этого обращение к
   * маршруту одного протокола с идентификатором провайдера другого запустило
   * бы вход по чужим настройкам.
   */
  async findEnabledProvider(
    providerId: string,
    workspaceId: string,
    type: string,
  ): Promise<any> {
    const provider = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', type)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!provider) {
      throw new BadRequestException('Провайдер входа недоступен');
    }
    return provider;
  }

  /**
   * Единственный включенный провайдер типа в пространстве.
   *
   * Нужен там, где идентификатора провайдера в запросе нет. У Google его
   * нет по устройству: обратный адрес один на установку и не может содержать
   * ни поддомен, ни идентификатор. Несколько включенных провайдеров одного
   * такого типа это ошибка настройки, а не выбор: молча взять первый
   * означало бы зависеть от порядка строк.
   */
  async findEnabledProviderByType(
    workspaceId: string,
    type: string,
  ): Promise<any> {
    const providers = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', type)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .limit(2)
      .execute();

    if (providers.length === 0) {
      throw new BadRequestException('Провайдер входа недоступен');
    }
    if (providers.length > 1) {
      this.logger.error(
        `В пространстве ${workspaceId} несколько включенных провайдеров типа ${type}`,
      );
      throw new BadRequestException('Настройка провайдера входа неоднозначна');
    }
    return providers[0];
  }

  /**
   * Пользователь по данным провайдера.
   *
   * Порядок поиска: сначала по связи `auth_accounts`, потом по почте.
   * Связь первична, потому что почта у провайдера может смениться, а
   * идентификатор нет; поиск по почте нужен для первого входа человека,
   * который уже заведен в пространстве обычным способом.
   */
  async resolveUser(opts: {
    provider: any;
    workspace: Workspace;
    subject: string;
    email: string;
    name?: string;
  }): Promise<User> {
    const { provider, workspace, subject, email, name } = opts;

    const linked = await this.db
      .selectFrom('authAccounts')
      .select('userId')
      .where('authProviderId', '=', provider.id)
      .where('providerUserId', '=', subject)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (linked) {
      const user = await this.userRepo.findById(linked.userId, workspace.id);
      if (!user) {
        throw new UnauthorizedException('Учетная запись недоступна');
      }
      return user;
    }

    const existing = await this.userRepo.findByEmail(email, workspace.id);
    if (existing) {
      // Сюда попадают только тогда, когда поиск по идентификатору ничего не
      // дал, то есть у найденного по почте пользователя связь с этим
      // провайдером, если она есть, заведена под другим идентификатором.
      // Совпадение по почте в этом случае неоднозначно: это либо смена
      // идентификатора у того же человека, либо адрес, переданный другому
      // человеку после увольнения первого. Перепривязка во втором случае
      // отдала бы чужую учетную запись, поэтому вход отвергается, а
      // разбирается администратор.
      const bound = await this.db
        .selectFrom('authAccounts')
        .select('providerUserId')
        .where('userId', '=', existing.id)
        .where('authProviderId', '=', provider.id)
        .where('workspaceId', '=', workspace.id)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();

      if (bound) {
        this.logger.warn(
          `Вход отвергнут: учетная запись ${existing.id} уже связана с провайдером ${provider.id} под другим идентификатором`,
        );
        throw new UnauthorizedException(
          'Учетная запись с этим адресом уже связана с провайдером под другим идентификатором. Обратитесь к администратору',
        );
      }

      await this.linkAccount(existing.id, provider.id, subject, workspace.id);
      return existing;
    }

    if (!provider.allowSignup) {
      throw new UnauthorizedException(
        'Этот провайдер не создает новые учетные записи. Обратитесь к администратору',
      );
    }

    return this.createUser({ provider, workspace, subject, email, name });
  }

  /**
   * Привязка учетной записи к провайдеру.
   *
   * Идемпотентна по паре пользователь и провайдер: на этой паре стоит
   * уникальное ограничение, а без обработки конфликта вставка роняла бы вход
   * нарушением ограничения. Живая связь под другим идентификатором сюда уже
   * не доходит, ее отвергает `resolveUser`, поэтому обновление по конфликту
   * работает только на связи, помеченной удаленной: ее надо оживить и снять
   * пометку, иначе она осталась бы невидимой для чтения, продолжая занимать
   * уникальный ключ.
   */
  private async linkAccount(
    userId: string,
    authProviderId: string,
    providerUserId: string,
    workspaceId: string,
    trx?: any,
  ): Promise<void> {
    const now = new Date();
    await (trx ?? this.db)
      .insertInto('authAccounts')
      .values({
        userId,
        authProviderId,
        providerUserId,
        workspaceId,
        createdAt: now,
        updatedAt: now,
      } as any)
      .onConflict((oc: any) =>
        oc.columns(['userId', 'authProviderId']).doUpdateSet({
          providerUserId,
          updatedAt: now,
          // Чтение связи фильтрует по `deletedAt`. Без сброса помеченная
          // удаленной строка осталась бы невидимой для чтения, продолжая
          // занимать уникальный ключ, и привязка молча не вступала бы в силу.
          deletedAt: null,
        } as any),
      )
      .execute();
  }

  /**
   * Завести пользователя по данным провайдера.
   *
   * Пароль ставится случайным и наружу не отдается: у такого пользователя
   * пути входа по паролю нет, но колонка не допускает пустого значения.
   * Роль всегда `member`: повышать права по данным внешнего провайдера
   * нельзя, это делает администратор вручную.
   */
  private async createUser(opts: {
    provider: any;
    workspace: Workspace;
    subject: string;
    email: string;
    name?: string;
  }): Promise<User> {
    const { provider, workspace, subject, email, name } = opts;

    return executeTx(this.db, async (trx) => {
      const user = await this.userRepo.insertUser(
        {
          name: name || email.split('@')[0],
          email,
          password: randomBytes(32).toString('hex'),
          role: UserRole.MEMBER,
          workspaceId: workspace.id,
          emailVerifiedAt: new Date(),
        } as any,
        trx,
      );

      // Роль передается явно. Без нее `addUserToWorkspace` ставит
      // `workspaces.defaultRole` и затирает роль, заданную выше, а на
      // пространстве с административной ролью по умолчанию любой, кто вошел
      // через провайдера, получил бы права администратора.
      await this.workspaceService.addUserToWorkspace(
        user.id,
        workspace.id,
        UserRole.MEMBER,
        trx,
      );
      await this.groupUserRepo.addUserToDefaultGroup(
        user.id,
        workspace.id,
        trx,
      );
      await this.linkAccount(user.id, provider.id, subject, workspace.id, trx);

      this.logger.log(
        `Заведен пользователь ${user.id} по данным провайдера ${provider.id}`,
      );
      return user;
    });
  }
}
