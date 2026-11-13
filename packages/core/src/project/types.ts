import type { ProjectProfile } from '@blockbase/contracts';

export type ProjectInspectionOptions = {
  /** Maximum number of component source files used as convention samples. */
  maxComponentSamples?: number;
  /** Maximum bytes read from an individual allowlisted file. */
  maxFileBytes?: number;
};

export type ProjectInspection = ProjectProfile;
