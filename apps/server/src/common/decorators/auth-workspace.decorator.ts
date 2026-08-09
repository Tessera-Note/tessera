import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { badRequest } from '../../common/errors/app-error';

export const AuthWorkspace = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const workspace = request.raw?.workspace ?? request?.user?.workspace;

    if (!workspace) {
      throw badRequest('error.common.invalid_workspace');
    }

    return workspace;
  },
);
