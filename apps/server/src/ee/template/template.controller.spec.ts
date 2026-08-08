import 'reflect-metadata';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  TemplateIdDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/template.dto';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';

describe('TemplateController', () => {
  const user = { id: 'user-id' } as User;
  const workspace = { id: 'workspace-id' } as Workspace;
  let service: jest.Mocked<TemplateService>;
  const wsService = { emitTreeRefresh: jest.fn() };
  let controller: TemplateController;

  beforeEach(() => {
    service = {
      listTemplates: jest.fn(),
      getTemplate: jest.fn(),
      createTemplate: jest.fn(),
      updateTemplate: jest.fn(),
      deleteTemplate: jest.fn(),
      useTemplate: jest.fn().mockResolvedValue({ spaceId: 'space-id' }),
    } as unknown as jest.Mocked<TemplateService>;
    controller = new TemplateController(service, wsService as any);
  });

  describe('route metadata', () => {
    const routes = [
      ['list', '/', RequestMethod.POST],
      ['info', 'info', RequestMethod.POST],
      ['create', 'create', RequestMethod.POST],
      ['update', 'update', RequestMethod.POST],
      ['delete', 'delete', RequestMethod.POST],
      ['use', 'use', RequestMethod.POST],
    ] as const;

    it('uses the templates controller prefix', () => {
      expect(Reflect.getMetadata(PATH_METADATA, TemplateController)).toBe(
        'templates',
      );
    });

    it('is protected by JwtAuthGuard', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, TemplateController)).toEqual([
        JwtAuthGuard,
      ]);
    });

    it.each(routes)(
      'maps %s to POST %s with status 200',
      (handler, path, method) => {
        const routeHandler = TemplateController.prototype[handler];

        expect(Reflect.getMetadata(PATH_METADATA, routeHandler)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, routeHandler)).toBe(method);
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, routeHandler)).toBe(
          HttpStatus.OK,
        );
      },
    );
  });

  describe('delegation', () => {
    it('delegates list with the exact dto, user, and workspace', async () => {
      const dto = { spaceId: 'space-id' } as ListTemplatesDto;

      await controller.list(dto, user, workspace);

      expect(service.listTemplates).toHaveBeenCalledWith(dto, user, workspace);
    });

    it('delegates info with the extracted template ID', async () => {
      const dto = { templateId: 'template-id' } as TemplateIdDto;

      await controller.info(dto, user, workspace);

      expect(service.getTemplate).toHaveBeenCalledWith(
        dto.templateId,
        user,
        workspace,
      );
    });

    it('delegates create with the exact dto, user, and workspace', async () => {
      const dto = { title: 'Template' } as CreateTemplateDto;

      await controller.create(dto, user, workspace);

      expect(service.createTemplate).toHaveBeenCalledWith(dto, user, workspace);
    });

    it('delegates update with the exact dto, user, and workspace', async () => {
      const dto = {
        templateId: 'template-id',
        title: 'Updated template',
      } as UpdateTemplateDto;

      await controller.update(dto, user, workspace);

      expect(service.updateTemplate).toHaveBeenCalledWith(dto, user, workspace);
    });

    it('delegates delete with the extracted template ID', async () => {
      const dto = { templateId: 'template-id' } as TemplateIdDto;

      await controller.delete(dto, user, workspace);

      expect(service.deleteTemplate).toHaveBeenCalledWith(
        dto.templateId,
        user,
        workspace,
      );
    });

    it('delegates use with the exact dto, user, and workspace', async () => {
      const dto = {
        templateId: 'template-id',
        spaceId: 'space-id',
      } as UseTemplateDto;

      await controller.use(dto, user, workspace);

      expect(service.useTemplate).toHaveBeenCalledWith(dto, user, workspace);
    });
  });
});
