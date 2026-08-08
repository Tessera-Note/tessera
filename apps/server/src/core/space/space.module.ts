import { Module } from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { SpaceController } from './space.controller';
import { PersonalSpaceController } from './personal-space.controller';
import { SpaceMemberService } from './services/space-member.service';

@Module({
  imports: [],
  controllers: [SpaceController, PersonalSpaceController],
  providers: [SpaceService, SpaceMemberService],
  exports: [SpaceService, SpaceMemberService],
})
export class SpaceModule {}
