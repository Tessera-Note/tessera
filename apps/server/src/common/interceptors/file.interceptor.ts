import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { FastifyRequest } from 'fastify';
import { badRequest } from '../../common/errors/app-error';

@Injectable()
export class FileInterceptor implements NestInterceptor {
  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    const req: FastifyRequest = context.switchToHttp().getRequest();

    if (!req.isMultipart() || !req.file) {
      throw badRequest('error.common.invalid_multipart_content_type');
    }

    return next.handle();
  }
}
