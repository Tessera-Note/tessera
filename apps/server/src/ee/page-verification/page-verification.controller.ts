import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { PageVerificationService } from './page-verification.service';
import {
  SetupVerificationDto,
  UpdateVerificationDto,
  VerificationListDto,
  VerificationPageIdDto,
  RejectApprovalDto,
} from './dto/page-verification.dto';

@Controller('pages')
@UseGuards(JwtAuthGuard)
export class PageVerificationController {
  constructor(private readonly verificationService: PageVerificationService) {}

  @Post('verification-info')
  @HttpCode(HttpStatus.OK)
  async getVerificationInfo(
    @Body('pageId') pageId: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.getVerificationInfo(
      pageId,
      workspace.id,
      user,
    );
  }

  @Post('create-verification')
  @HttpCode(HttpStatus.OK)
  async setupVerification(
    @Body() body: SetupVerificationDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.setupVerification(body, workspace.id, user);
  }

  @Post('update-verification')
  @HttpCode(HttpStatus.OK)
  async updateVerification(
    @Body() body: UpdateVerificationDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.updateVerification(body, workspace.id, user);
  }

  @Post('delete-verification')
  @HttpCode(HttpStatus.OK)
  async removeVerification(
    @Body() dto: VerificationPageIdDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.removeVerification(
      dto.pageId,
      workspace.id,
      user,
    );
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPage(
    @Body('pageId') pageId: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.verifyPage(pageId, workspace.id, user);
  }

  @Post('submit-for-approval')
  @HttpCode(HttpStatus.OK)
  async submitForApproval(
    @Body('pageId') pageId: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.submitForApproval(
      pageId,
      workspace.id,
      user,
    );
  }

  @Post('reject-approval')
  @HttpCode(HttpStatus.OK)
  async rejectApproval(
    @Body() body: RejectApprovalDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.rejectApproval(body, workspace.id, user);
  }

  @Post('mark-obsolete')
  @HttpCode(HttpStatus.OK)
  async markObsolete(
    @Body('pageId') pageId: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.markObsolete(pageId, workspace.id, user);
  }

  @Post('verifications')
  @HttpCode(HttpStatus.OK)
  async getVerificationList(
    @Body() params: VerificationListDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    return this.verificationService.getVerificationList(
      params,
      workspace.id,
      user,
    );
  }
}
