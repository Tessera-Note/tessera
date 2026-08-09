import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { badRequest } from '../../common/errors/app-error';

export const AuthUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    if (!request?.user?.user) {
      throw badRequest('error.common.invalid_user');
    }

    return request.user.user;
  },
);
