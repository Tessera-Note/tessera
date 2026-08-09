import { BadRequestException } from '@nestjs/common';
import { GroupService } from './group.service';

/**
 * Колонка `groups.is_external` заполнялась SCIM, а теперь и синхронизацией
 * групп SSO, но клиент ее не читал: администратор мог переименовать или
 * удалить группу каталога, после чего следующий цикл синхронизации заводил ее
 * заново под новым идентификатором, и в списке оказывались две.
 */
function build(group: any) {
  const service: GroupService = Object.create(GroupService.prototype);
  (service as any).groupRepo = {
    findById: jest.fn(async () => group),
    findByName: jest.fn(async () => undefined),
  };
  (service as any).findAndValidateGroup = jest.fn(async () => group);
  return service;
}

const EXTERNAL = {
  id: 'g-1',
  name: 'Отдел кадров',
  isDefault: false,
  isExternal: true,
};

describe('GroupService, группа под управлением каталога', () => {
  it('переименовать нельзя', async () => {
    const service = build(EXTERNAL);

    await expect(
      service.updateGroup('ws-1', { groupId: 'g-1', name: 'Другое' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('удалить нельзя', async () => {
    const service = build(EXTERNAL);

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('обычную группу это не задевает', async () => {
    const service = build({ ...EXTERNAL, isExternal: false });

    await expect(service.deleteGroup('g-1', 'ws-1')).rejects.not.toBeInstanceOf(
      BadRequestException,
    );
  });
});
