import { SamlController } from './saml.controller';

/**
 * Поведение обратного вызова SAML на уровне контроллера.
 *
 * Отказ здесь не должен превращаться в ошибку сервера: человек пришел
 * перенаправлением браузера, и единственный внятный для него исход это
 * возврат на форму входа с меткой.
 */
function build() {
  const samlService: any = {
    buildLoginRedirect: jest.fn(async () => ({ url: 'https://idp/sso' })),
    handleCallback: jest.fn(),
  };
  const environmentService: any = {
    getAppUrl: () => 'https://wiki.local',
    getCookieExpiresIn: () => new Date('2030-01-01T00:00:00Z'),
    isHttps: () => true,
  };

  const controller = new SamlController(samlService, environmentService);
  jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => {});

  const res: any = {
    redirect: jest.fn(),
    setCookie: jest.fn(),
  };

  return { controller, samlService, res };
}

const WORKSPACE = { id: 'ws-1' } as any;

describe('SamlController, начало входа', () => {
  it('браузер отправляется к провайдеру', async () => {
    const { controller, res } = build();

    await controller.login('prov-1', '/home', WORKSPACE, res);

    expect(res.redirect).toHaveBeenCalledWith('https://idp/sso', 302);
  });
});

describe('SamlController, обратный вызов', () => {
  it('успех выдает куку и уводит на точку возврата', async () => {
    const { controller, samlService, res } = build();
    samlService.handleCallback.mockResolvedValue({
      authToken: 'токен',
      redirect: '/s/general',
    });

    await controller.callback('prov-1', {}, WORKSPACE, res);

    expect(res.setCookie).toHaveBeenCalledWith(
      'authToken',
      'токен',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://wiki.local/s/general',
      302,
    );
  });

  it('без точки возврата уводит на домашнюю страницу', async () => {
    const { controller, samlService, res } = build();
    samlService.handleCallback.mockResolvedValue({ authToken: 'токен' });

    await controller.callback('prov-1', {}, WORKSPACE, res);

    expect(res.redirect).toHaveBeenCalledWith('https://wiki.local/home', 302);
  });

  // Внешний адрес в точке возврата увел бы человека с сайта сразу после входа.
  it('внешняя точка возврата заменяется домашней страницей', async () => {
    const { controller, samlService, res } = build();
    samlService.handleCallback.mockResolvedValue({
      authToken: 'токен',
      redirect: '//зло.example/забрать',
    });

    await controller.callback('prov-1', {}, WORKSPACE, res);

    expect(res.redirect).toHaveBeenCalledWith('https://wiki.local/home', 302);
  });

  it('отказ уводит на форму входа с меткой, а не отдает ошибку', async () => {
    const { controller, samlService, res } = build();
    samlService.handleCallback.mockRejectedValue(new Error('подпись неверна'));

    await controller.callback('prov-1', {}, WORKSPACE, res);

    expect(res.setCookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://wiki.local/login?error=sso',
      302,
    );
  });
});
