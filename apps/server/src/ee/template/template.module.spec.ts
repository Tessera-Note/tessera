import 'reflect-metadata';
import { Type } from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { PageModule } from '../../core/page/page.module';
import { EeModule } from '../ee.module';
import { TemplateController } from './template.controller';
import { TemplateModule } from './template.module';
import { TemplateService } from './template.service';

function moduleMetadata<T>(module: Type<unknown>, key: string): T[] {
  return Reflect.getMetadata(key, module) ?? [];
}

function scanControllers(root: Type<unknown>): Type<unknown>[] {
  const controllers = new Set<Type<unknown>>();
  const visited = new Set<Type<unknown>>();

  const visit = (module: Type<unknown>) => {
    if (visited.has(module)) return;
    visited.add(module);

    for (const controller of moduleMetadata<Type<unknown>>(
      module,
      MODULE_METADATA.CONTROLLERS,
    )) {
      controllers.add(controller);
    }

    for (const importedModule of moduleMetadata<Type<unknown>>(
      module,
      MODULE_METADATA.IMPORTS,
    )) {
      if (typeof importedModule === 'function') visit(importedModule);
    }
  };

  visit(root);
  return [...controllers];
}

describe('TemplateModule registration', () => {
  it('declares its page dependency, controller, and service', () => {
    expect(moduleMetadata(TemplateModule, MODULE_METADATA.IMPORTS)).toContain(
      PageModule,
    );
    expect(
      moduleMetadata(TemplateModule, MODULE_METADATA.CONTROLLERS),
    ).toContain(TemplateController);
    expect(moduleMetadata(TemplateModule, MODULE_METADATA.PROVIDERS)).toContain(
      TemplateService,
    );
  });

  it('registers TemplateModule through EeModule', () => {
    expect(moduleMetadata(EeModule, MODULE_METADATA.IMPORTS)).toContain(
      TemplateModule,
    );
  });

  it('exposes the templates controller prefix and six handlers in a module scan', () => {
    const templateController = scanControllers(EeModule).find(
      (controller) => controller === TemplateController,
    );
    const handlers = Object.getOwnPropertyNames(
      TemplateController.prototype,
    ).filter((name) =>
      Reflect.hasMetadata(
        METHOD_METADATA,
        TemplateController.prototype[name as keyof TemplateController],
      ),
    );

    expect(templateController).toBe(TemplateController);
    expect(Reflect.getMetadata(PATH_METADATA, templateController)).toBe(
      'templates',
    );
    expect(handlers).toHaveLength(6);
  });
});
