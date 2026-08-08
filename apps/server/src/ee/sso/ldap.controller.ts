import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@tessera/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { LdapLoginThrottlerGuard } from '../../integrations/throttle/ldap-login-throttler.guard';
import { LDAP_LOGIN_THROTTLER } from '../../integrations/throttle/throttler-names';
import { LdapService } from './services/ldap.service';
import { LdapLoginDto } from './dto/sso.dto';

/**
 * Вход через каталог LDAP.
 *
 * В отличие от OIDC и SAML браузер никуда не перенаправляется: пароль
 * приходит на наш сервер, мы сами проверяем его в каталоге и ставим куку.
 * Отсюда два следствия.
 *
 * Первое: маршрут становится оракулом паролей против корпоративного
 * каталога, чего у остальных протоколов нет в принципе. Поэтому на нем два
 * счетчика. Общий `auth`, тот же, что у парольного входа, иначе получаем
 * обход его лимита в том же пространстве. И отдельный по паре провайдера
 * и имени пользователя, потому что перебор через нас накручивает счетчик
 * неудач в каталоге и блокирует настоящую учетную запись.
 *
 * Второе: тело запроса содержит пароль, поэтому его нельзя печатать в лог
 * целиком ни при каких обстоятельствах.
 */
@SkipThrottle({ [AI_CHAT_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(ThrottlerGuard, LdapLoginThrottlerGuard)
@Controller('sso/ldap')
export class LdapController {
  constructor(
    private readonly ldapService: LdapService,
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
   * Второй фактор здесь не проверяется, как и у OIDC и SAML: подтверждение
   * личности отдано провайдеру. Клиент умеет разбирать поля второго фактора
   * в ответе, но для этого пути они не заполняются.
   */
  /**
   * Пять попыток на связку провайдера и имени за пять минут.
   *
   * Порог задан здесь, а не в общей настройке счетчиков: там он применялся бы
   * ко всем контроллерам под любым `ThrottlerGuard`. Порог ниже, чем у прочих
   * счетчиков, потому что цена превышения здесь не отказ нам, а блокировка
   * учетной записи в каталоге.
   */
  @Throttle({ [LDAP_LOGIN_THROTTLER]: { ttl: 300_000, limit: 5 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post(':providerId/login')
  async login(
    @Param('providerId') providerId: string,
    @Body() dto: LdapLoginDto,
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { authToken } = await this.ldapService.login(providerId, workspace, {
      username: dto.username,
      password: dto.password,
    });

    res.setCookie('authToken', authToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });

    return { success: true };
  }
}
