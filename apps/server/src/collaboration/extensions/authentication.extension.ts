import { Extension, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@tessera/db/repos/user/user.repo';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { isUserDisabled } from '../../common/helpers';
import { CollabAccessService } from '../services/collab-access.service';
import { getPageId } from '../collaboration.util';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly collabAccess: CollabAccessService,
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const pageId = getPageId(documentName);

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    const user = await this.userRepo.findById(userId, workspaceId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    // Правило доступа общее с периодической перепроверкой открытых
    // соединений (`AccessSweepExtension`): две копии разъехались бы.
    const access = await this.collabAccess.resolve(user.id, page);

    if (!access.allowed) {
      this.logger.warn(`User not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    if (!access.canEdit) {
      data.connectionConfig.readOnly = true;
      this.logger.debug(`User granted readonly access to page: ${pageId}`);
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    return {
      user,
    };
  }
}
