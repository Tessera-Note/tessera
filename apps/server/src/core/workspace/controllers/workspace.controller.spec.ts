import { WorkspaceController } from './workspace.controller';
import { LicenseCheckService } from '../../../integrations/environment/license-check.service';
import { Feature } from '../../../common/features';

describe('WorkspaceController.getEntitlements', () => {
  function build(isCloud = false) {
    const environmentService = { isCloud: jest.fn().mockReturnValue(isCloud) };

    const controller = new WorkspaceController(
      null as any,
      null as any,
      null as any,
      environmentService as any,
      new LicenseCheckService(),
    );

    return { controller, environmentService };
  }

  it('отдает уровень и состав возможностей', async () => {
    const { controller } = build();

    const result = await controller.getEntitlements();

    expect(result.cloud).toBe(false);
    expect(result.tier).toBe('enterprise');
    expect(result.features).toContain(Feature.BASES);
  });

  // Регресс: раньше обработчик читал workspaces.license_key, колонки для
  // которого в схеме нет. Запрос падал с 500, клиент не получал entitlements
  // и гасил все возможности, включая базы.
  it('не обращается к базе', async () => {
    const { controller } = build();

    await expect(controller.getEntitlements()).resolves.toBeDefined();
  });

  it('прокидывает признак облачного развертывания', async () => {
    const { controller } = build(true);

    await expect(controller.getEntitlements()).resolves.toMatchObject({
      cloud: true,
    });
  });
});
