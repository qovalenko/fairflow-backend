import { Injectable } from '@nestjs/common';
import { SearchService } from './search.service';
import type { ProjectionDoc, SearchDeltaWriter } from './search-projection.apply';

/**
 * Concrete {@link SearchDeltaWriter} backing the event projection with the real
 * Mongo writes in {@link SearchService}. Kept as a thin adapter so the
 * projection mapper stays storage-agnostic (and unit-testable against a fake).
 */
@Injectable()
export class SearchDeltaWriterImpl implements SearchDeltaWriter {
  constructor(private readonly search: SearchService) {}

  async upsert(d: ProjectionDoc): Promise<void> {
    await this.search.projectUpsert(d);
  }

  /** Terminal erase behind `crm.<entity>.purged` (FR-COMPANIES-040 / 152-ФЗ). */
  async purge(
    projectId: string,
    entityType: string,
    entityId: string,
    version: number,
  ): Promise<void> {
    await this.search.indexPurge({ projectId, entityType, entityId, version });
  }

  async tombstone(
    projectId: string,
    entityType: string,
    entityId: string,
    version: number,
  ): Promise<void> {
    await this.search.indexDelete({ projectId, entityType, entityId, version });
  }

  /** TODO-264: projection inputs stored on the index doc (`null` = not indexed). */
  async sourceFields(
    projectId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.search.indexSourceFields(projectId, entityType, entityId);
  }
}
