import { Injectable } from '@nestjs/common';
import { PageHistoryRepo } from '@tessera/db/repos/page/page-history.repo';
import { PageHistory } from '@tessera/db/types/entity.types';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import { CursorPaginationResult } from '@tessera/db/pagination/cursor-pagination';

@Injectable()
export class PageHistoryService {
  constructor(private pageHistoryRepo: PageHistoryRepo) {}

  async findById(historyId: string): Promise<PageHistory> {
    return await this.pageHistoryRepo.findById(historyId, {
      includeContent: true,
    });
  }

  async findHistoryByPageId(
    pageId: string,
    paginationOptions: PaginationOptions,
  ): Promise<CursorPaginationResult<PageHistory>> {
    return this.pageHistoryRepo.findPageHistoryByPageId(
      pageId,
      paginationOptions,
    );
  }
}
