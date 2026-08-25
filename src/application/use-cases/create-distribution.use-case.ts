import { AppError } from '../../domain/errors/app-error';
import { bumpConfigVersion } from '../../services/config-version';

export interface DistributionRecord {
  id: number;
  name: string;
  formId: number;
  timezone: string;
}

export interface DistributionMemberRecord {
  brokerId: number;
  percentage: number;
  isActiveInDistribution: boolean;
}

export interface DistributionRepositoryPort {
  findSingleton(): Promise<DistributionRecord | null>;
  getFormId(): Promise<number | null>;
  createWithVersionBump(input: {
    name: string;
    timezone: string;
    formId: number;
  }): Promise<DistributionRecord>;
  replaceMembersWithVersionBump(
    distributionId: number,
    members: DistributionMemberRecord[],
  ): Promise<void>;
}

/** The exact user-facing message is part of the API contract. */
export const FORM_REQUIRED_MESSAGE = 'Oops, please create a form first.';

/**
 * Creates THE single distribution (INV: one distribution, bound to the one
 * form). FORM_REQUIRED when no form exists yet; DISTRIBUTION_ALREADY_EXISTS
 * on the second attempt. ConfigVersion bumps inside each transaction.
 */
export class CreateDistributionUseCase {
  constructor(private readonly repo: DistributionRepositoryPort) {}

  async execute(input: { name: string; timezone: string }): Promise<DistributionRecord> {
    const existing = await this.repo.findSingleton();
    if (existing !== null) {
      throw new AppError(
        'DISTRIBUTION_ALREADY_EXISTS',
        'A distribution already exists. Only one distribution can be created.',
      );
    }

    const formId = await this.repo.getFormId();
    if (formId === null) {
      throw new AppError('FORM_REQUIRED', FORM_REQUIRED_MESSAGE);
    }

    return this.repo.createWithVersionBump({
      name: input.name,
      timezone: input.timezone,
      formId,
    });
  }
}
