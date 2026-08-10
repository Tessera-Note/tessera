import { GroupRepo } from './group.repo';

/**
 * Общий набор полей группы уходит любому участнику пространства: читать группы
 * вправе роль MEMBER. Ключ каталога и провайдер в него попасть не должны, они
 * отдаются отдельной опцией только управляющему группами.
 */
describe('GroupRepo, общий набор полей', () => {
  // Набор задан полем экземпляра, поэтому берется с настоящего объекта.
  const fields: string[] = (new GroupRepo({} as any) as any).baseFields;

  it('признак каталога в наборе есть, он нужен списку', () => {
    expect(fields).toContain('directorySource');
  });

  it('ключ каталога и провайдер в набор не входят', () => {
    expect(fields).not.toContain('directoryKey');
    expect(fields).not.toContain('directoryProviderId');
  });
});
