import { Injectable } from '@nestjs/common';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@tessera/db/repos/space/utils';
import { SpaceRole } from '../../common/helpers/types/permission';

export type CollabAccess = {
  /** Пускать ли вообще к документу. */
  allowed: boolean;
  /** Пускать ли на запись. Осмысленно только при `allowed`. */
  canEdit: boolean;
};

/**
 * Правило доступа к странице в канале коллаборации.
 *
 * Вынесено из `AuthenticationExtension` в отдельное место, потому что теперь
 * у него два вызывающих: проверка при подключении и периодическая
 * перепроверка уже открытых соединений. Две копии одного правила разъехались
 * бы при первой же правке, и расхождение было бы незаметным: одна сторона
 * начала бы рвать законные соединения, другая пропускать отозванные.
 */
@Injectable()
export class CollabAccessService {
  constructor(
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async resolve(
    userId: string,
    page: { id: string; spaceId: string; deletedAt?: Date | null },
  ): Promise<CollabAccess> {
    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      userId,
      page.spaceId,
    );
    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    if (!userSpaceRole) {
      return { allowed: false, canEdit: false };
    }

    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(userId, page.id);

    if (hasAnyRestriction && !canAccess) {
      return { allowed: false, canEdit: false };
    }

    // При ограничениях на странице решает право страницы, без них роль в space.
    const editable = hasAnyRestriction
      ? canEdit
      : userSpaceRole !== SpaceRole.READER;

    // Удаленная страница открывается только на чтение.
    return { allowed: true, canEdit: editable && !page.deletedAt };
  }
}
